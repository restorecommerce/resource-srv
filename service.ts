import * as _ from 'lodash';
import * as co from 'co';
import * as Logger from '@restorecommerce/logger';
import * as redis from 'redis';
import * as sconfig from '@restorecommerce/service-config';
import {
  CommandInterface, ICommandInterface, config, database,
  grpc, Server, OffsetStore
} from '@restorecommerce/chassis-srv';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';

export class Worker {
  server: Server;
  events: Events;
  logger: any;
  redisClient: any;
  offsetStore: OffsetStore;
  async start(cfg?: any) {
    // Load config
    if (!cfg) {
      cfg = sconfig(process.cwd());
    }
    const standardConfig = cfg.get('server:services:standard-cfg');
    const resources = cfg.get('resources');
    if (!resources) {
      throw new Error('config field resources does not exist');
    }

    // Generate a config for each resource
    const kafkaCfg = cfg.get('events:kafka');
    const grpcConfig = cfg.get('server:transports:0');

    const validResourceTopicNames: string[] = [];

    const eventTypes = ['Created', 'Read', 'Modified', 'Deleted'];
    for (let resourceType in resources) {
      const resourceCfg = resources[resourceType];
      const resourcesProtoPathPrefix = resourceCfg.resourcesProtoPathPrefix;
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      const resourcesServiceConfigPrefix = resourceCfg.resourcesServiceConfigPrefix;
      const root = resourceCfg.resourcesProtoRoot;
      for (let resource of resourceCfg.resources) {
        cfg.set(`server:services:${resourcesServiceConfigPrefix}${resource}-srv`, standardConfig);
        const proto = resourcesProtoPathPrefix + `${resource}.proto`;
        grpcConfig.protos.push(proto);

        const serviceName = resourcesServiceNamePrefix + `${resource}.Service`;
        grpcConfig.services[`${resourcesServiceConfigPrefix}${resource}-srv`] = serviceName;

        let resourceObjectName = resource.charAt(0).toUpperCase() + resource.substr(1);

        if (resource.indexOf('_') != -1) {
          const names = resourceObjectName.split('_');
          resourceObjectName = '';

          for (let name of names) {
            resourceObjectName += name.charAt(0).toUpperCase() + name.substr(1);
          }
        }

        for (let event of eventTypes) {
          kafkaCfg[`${resource}${event}`] = {
            protos: [
              proto
            ],
            protoRoot: root,
            messageObject: `${resourcesServiceNamePrefix}${resource}.${resourceObjectName}`
          };

          const topicName = `${resourcesServiceNamePrefix}${resource}s.resource`;
          const topicLabel = `${resource}.resource`;
          kafkaCfg.topics[topicLabel] = {
            topic: topicName,
          };
          validResourceTopicNames.push(topicName);
        }
      }
    }
    cfg.set('events:kafka', kafkaCfg);

    // Load google descriptor proto file in the end - this is used by other proto files.
    const descriptorProto = `google/protobuf/descriptor.proto`;
    grpcConfig.protos.push(descriptorProto);
    cfg.set('server:transports', [grpcConfig]);

    const logger = new Logger(cfg.get('logger'));
    const server = new Server(cfg.get('server'), logger);
    const db = await co(database.get(cfg.get('database:arango'), logger));
    const events = new Events(cfg.get('events:kafka'), logger);

    await events.start();
    this.offsetStore = new OffsetStore(events, cfg, logger);
    let redisClient: any;
    if (cfg.get('redis')) {
      const redisConfig = cfg.get('redis');
      redisConfig.db = cfg.get('redis:db-indexes:db-resourcesCounter');
      redisClient = redis.createClient(redisConfig);
    }
    const fieldGeneratorConfig: any = cfg.get('fieldHandlers:fieldGenerators');
    const bufferHandlerConfig: any = cfg.get('fieldHandlers:bufferFields');

    // Enable events firing for resource api using config
    const isEventsEnabled = (cfg.get('events:enableCRUDEvents') == 'true');

    for (let resourceType in resources) {
      const resourceCfg = resources[resourceType];
      const resourcesServiceConfigPrefix = resourceCfg.resourcesServiceConfigPrefix;
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      for (let resourceName of resourceCfg.resources) {
        let resourceFieldConfig: any;
        if (fieldGeneratorConfig && (resourceName in fieldGeneratorConfig)) {
          resourceFieldConfig = {};
          resourceFieldConfig['strategies'] = fieldGeneratorConfig[resourceName];
          logger.info('Setting up field generators on Redis...');
          resourceFieldConfig['redisClient'] = redisClient;
        }
        if (bufferHandlerConfig && (resourceName in bufferHandlerConfig)) {
          if (!resourceFieldConfig) {
            resourceFieldConfig = {};
          }
          resourceFieldConfig['bufferField'] = bufferHandlerConfig[resourceName];
        }
        logger.info(`Setting up ${resourceName} resource service`);

        const resourceAPI = new ResourcesAPIBase(db, `${resourceName}s`, resourceFieldConfig);
        const resourceEvents = events.topic(`${resourcesServiceNamePrefix}${resourceName}s.resource`);
        const service = new ServiceBase(resourceName,
          resourceEvents, logger, resourceAPI, isEventsEnabled);
        await server.bind(`${resourcesServiceConfigPrefix}${resourceName}-srv`, service);
      }
    }

    // Add CommandInterfaceService
    const cis: ICommandInterface = new CommandInterface(server, cfg.get(), logger, events);
    const cisName = cfg.get('command-interface:name');
    await server.bind(cisName, cis);

    const that = this;
    const resourcesServiceEventListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      try {
        await cis.command(msg, context);
      } catch (err) {
        that.logger.error(err);
      }
    };

    const topics = kafkaCfg.topics;
    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic: Topic = events.topic(topicName);
      const offSetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offSetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await topic.on(eventName, resourcesServiceEventListener, offSetValue);
        }
      }
    }

    // Add reflection service
    const transportName = cfg.get('server:services:reflection:serverReflectionInfo:transport:0');
    const transport = server.transport[transportName];
    const reflectionService = new grpc.ServerReflection(transport.$builder, server.config);
    await server.bind('reflection', reflectionService);

    // Start server
    await server.start();
    logger.info('Server Started Correctly');
    this.events = events;
    this.server = server;
    this.logger = logger;

    if (redisClient) {
      this.redisClient = redisClient;
    }
  }

  async stop() {
    this.logger.info('Shutting down');
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
    if (this.redisClient) {
      await this.redisClient.quit();
    }
  }
}

if (require.main === module) {
  const worker = new Worker();
  worker.start().catch((err) => {
    console.error('startup error', err);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    worker.stop().catch((err) => {
      console.error('shutdown error', err);
      process.exit(1);
    });
  });
}

