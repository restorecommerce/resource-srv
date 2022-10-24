import { Events, Topic, registerProtoMeta } from '@restorecommerce/kafka-client';
import { GraphResourcesServiceBase, ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';
import { ACSAuthZ, initAuthZ, initializeCache } from '@restorecommerce/acs-client';
import { ResourceCommandInterface } from './commandInterface';
import * as _ from 'lodash';
import {
  database,
  GraphDatabaseProvider,
  buildReflectionService,
  CommandInterface,
  OffsetStore,
  Server,
  Health
} from '@restorecommerce/chassis-srv';
import { ResourceService } from './service';
import { Logger } from 'winston';
import { createLogger } from '@restorecommerce/logger';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createClient, RedisClientType } from 'redis';
import { protoMetadata as commandMeta, ServiceDefinition as command } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/command';
import { protoMetadata as addressMeta, ServiceDefinition as address } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/address';
import { protoMetadata as contactPointTypeMeta, ServiceDefinition as contact_point_type } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point_type';
import { protoMetadata as countryMeta, ServiceDefinition as country } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/country';
import { protoMetadata as contactPointMeta, ServiceDefinition as contact_point } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point';
import { protoMetadata as credentialMeta, ServiceDefinition as credential } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/credential';
import { protoMetadata as localeMeta, ServiceDefinition as locale } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/locale';
import { protoMetadata as locationMeta, ServiceDefinition as location } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/location';
import { protoMetadata as organizationMeta, ServiceDefinition as organization } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/organization';
import { protoMetadata as taxMeta, ServiceDefinition as tax } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/tax';
import { protoMetadata as taxTypeMeta, ServiceDefinition as tax_type } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/tax_type';
import { protoMetadata as timezoneMeta, ServiceDefinition as timezone } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/timezone';
import { protoMetadata as customerMeta, ServiceDefinition as customer } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/customer';
import {
  ServiceDefinition as CommandInterfaceServiceDefinition,
  protoMetadata as commandInterfaceMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface';
import {
  protoMetadata as reflectionMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/reflection/v1alpha/reflection';
import { ServerReflectionService } from 'nice-grpc-server-reflection';
import { HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health';
import {
  ServiceDefinition as GraphServiceDefinition,
  protoMetadata as graphMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc';

registerProtoMeta(commandMeta, addressMeta, contactPointTypeMeta, countryMeta,
  contactPointMeta, credentialMeta, localeMeta, locationMeta, organizationMeta,
  taxMeta, taxTypeMeta, timezoneMeta, customerMeta, commandInterfaceMeta, reflectionMeta, graphMeta);

const ServiceDefinitions: any = [command, address, contact_point_type, country, contact_point, credential, locale, location, organization,
  tax, tax_type, timezone, customer];

export class Worker {
  server: Server;
  events: Events;
  logger: Logger;
  redisClient: any;
  offsetStore: OffsetStore;
  cis: CommandInterface;
  service: any[];

  async start(cfg?: any, resourcesServiceEventListener?: Function) {
    // Load config
    if (!cfg) {
      cfg = createServiceConfig(process.cwd());
    }
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
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      for (let resource of resourceCfg.resources) {
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

    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    const server = new Server(cfg.get('server'), logger);
    const db = await database.get(cfg.get('database:arango'),
      logger, cfg.get('graph:graphName'), cfg.get('graph:edgeDefinitions')) as GraphDatabaseProvider;
    const events = new Events(cfg.get('events:kafka'), logger);

    await events.start();
    this.offsetStore = new OffsetStore(events, cfg, logger);
    let redisClient: RedisClientType<any, any>;
    if (cfg.get('redis')) {
      const redisConfig = cfg.get('redis');
      redisConfig.database = cfg.get('redis:db-indexes:db-resourcesCounter');
      redisClient = createClient(redisConfig);
      redisClient.on('error', (err) => logger.error('Redis Client Error', err));
      await redisClient.connect();
    }
    const fieldGeneratorConfig: any = cfg.get('fieldHandlers:fieldGenerators');
    const bufferHandlerConfig: any = cfg.get('fieldHandlers:bufferFields');
    const requiredFieldsConfig: any = cfg.get('fieldHandlers:requiredFields');

    // Enable events firing for resource api using config
    const isEventsEnabled = (cfg.get('events:enableCRUDEvents') == 'true');
    const graphCfg = cfg.get('graph');

    this.service = [];
    const authZ = await initAuthZ(cfg) as ACSAuthZ;
    // init Redis Client for subject index
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject');
    const redisClientSubject: RedisClientType<any, any> = createClient(redisConfig);
    await redisClientSubject.on('error', (err) => logger.error('Redis Client Error', err));
    await redisClientSubject.connect();
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
        if (requiredFieldsConfig && (resourceName in requiredFieldsConfig)) {
          if (!resourceFieldConfig) {
            resourceFieldConfig = {};
          }
          resourceFieldConfig['requiredFields'] = requiredFieldsConfig;
        }
        logger.info(`Setting up ${resourceName} resource service`);

        let edgeCfg;
        let graphName;
        if (graphCfg && graphCfg.vertices) {
          const collectionName = `${resourceName}s`;
          edgeCfg = graphCfg.vertices[collectionName];
        }
        if (graphCfg) {
          graphName = graphCfg.graphName;
        }
        const resourceAPI = new ResourcesAPIBase(db, `${resourceName}s`,
          resourceFieldConfig, edgeCfg, graphName);
        const resourceEvents = await events.topic(`${resourcesServiceNamePrefix}${resourceName}s.resource`);
        // TODO provide typing on ResourceService<T, M>
        this.service[resourceName] = new ResourceService(resourceName,
          resourceEvents, cfg, logger, resourceAPI, isEventsEnabled, authZ, redisClientSubject);
        const resourceServiceDefinition = ServiceDefinitions.filter((obj) => obj.fullName.split('.')[2] === resourceName);
        // todo add bindConfig typing
        await server.bind(`${resourcesServiceConfigPrefix}${resourceName}-srv`, {
          service: resourceServiceDefinition[0],
          implementation: this.service[resourceName]
        } as BindConfig<any>);
      }
    }

    // init ACS cache
    await initializeCache();

    // Add CommandInterfaceService
    const cis: ResourceCommandInterface = new ResourceCommandInterface(server, cfg, logger, events, redisClientSubject);
    const cisName = cfg.get('command-interface:name');
    await server.bind(cisName, {
      service: CommandInterfaceServiceDefinition,
      implementation: cis
    } as BindConfig<CommandInterfaceServiceDefinition>);

    if (!resourcesServiceEventListener) {
      resourcesServiceEventListener = async (msg: any,
        context: any, config: any, eventName: string): Promise<any> => {
        try {
          await cis.command(msg, context);
        } catch (err) {
          logger.error('Error while executing command', err);
        }
      };
    }
    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic: Topic = await events.topic(topicName);
      const offSetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offSetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await topic.on(eventName, resourcesServiceEventListener, { startingOffset: offSetValue });
        }
      }
    }

    // Add reflection service
    const reflectionService = buildReflectionService([
      { descriptor: commandMeta.fileDescriptor },
      { descriptor: addressMeta.fileDescriptor },
      { descriptor: contactPointTypeMeta.fileDescriptor },
      { descriptor: countryMeta.fileDescriptor },
      { descriptor: credentialMeta.fileDescriptor },
      { descriptor: localeMeta.fileDescriptor },
      { descriptor: locationMeta.fileDescriptor },
      { descriptor: organizationMeta.fileDescriptor },
      { descriptor: taxMeta.fileDescriptor },
      { descriptor: taxTypeMeta.fileDescriptor },
      { descriptor: timezoneMeta.fileDescriptor },
      { descriptor: customerMeta.fileDescriptor },
      { descriptor: commandInterfaceMeta.fileDescriptor }
    ]);
    await server.bind('reflection', {
      service: ServerReflectionService,
      implementation: reflectionService
    });

    // graph Service
    const graphAPIService = new GraphResourcesServiceBase(db, cfg.get('fieldHandlers:bufferFields'));
    await server.bind('graph', {
      implementation: graphAPIService,
      service: GraphServiceDefinition
    } as BindConfig<GraphServiceDefinition>);

    // health Service
    await server.bind('grpc-health-v1', {
      service: HealthDefinition,
      implementation: new Health(cis, {
        logger,
        cfg
      })
    } as BindConfig<HealthDefinition>);

    // Start server
    await server.start();
    logger.info('Server Started Successfully');
    this.events = events;
    this.server = server;
    this.logger = logger;
    this.cis = cis;

    if (redisClient) {
      this.redisClient = redisClient;
    }
  }

  async stop() {
    this.logger.info('Shutting down');
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
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
