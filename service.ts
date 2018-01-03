import * as co from 'co';
import { ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';
import * as redis from 'redis';
import * as chassis from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import * as _ from 'lodash';
import * as rcsi from '@restorecommerce/command-interface';
import * as sconfig from '@restorecommerce/service-config';

// microservice
const Server = chassis.Server;
const grpc = chassis.grpc; // for serverReflection
const config = chassis.config;
const database = chassis.database;

const RESTORE_CMD_EVENT = 'restoreCommand';
const HEALTHCHECK_CMD_EVENT = 'healthCheckCommand';
const HEALTHCHECK_RES_EVENT = 'healthCheckResponse';
const RESET_START_EVENT = 'resetCommand';
const RESET_DONE_EVENT = 'resetResponse';

export class Worker {
  server: chassis.Server;
  events: kafkaClient.Events;
  logger: any;
  redisClient: any;
  constructor() { }
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
    const resourcesProtoPathPrefix = cfg.get('resourcesProtoPathPrefix');
    const resourcesServiceNamePrefix = cfg.get('resourcesServiceNamePrefix');
    const resourcesServiceConfigPrefix = cfg.get('resourcesServiceConfigPrefix');
    const root = cfg.get('resourcesProtoRoot');

    const eventTypes = ['Created', 'Read', 'Modified', 'Deleted'];
    // const resourceEventCfg = {};

    for (let i = 0; i < resources.length; i++) {
      cfg.set(`server:services:${resourcesServiceConfigPrefix}${resources[i]}-srv`, standardConfig);
      const proto = resourcesProtoPathPrefix + `${resources[i]}.proto`;
      grpcConfig.protos.push(proto);
      const serviceName = resourcesServiceNamePrefix + `${resources[i]}.Service`;
      grpcConfig.services[`${resourcesServiceConfigPrefix}${resources[i]}-srv`] = serviceName;

      let resourceObject = resources[i].charAt(0).toUpperCase() + resources[i].substr(1);
      if (resources[i].indexOf('command') != -1) {
        resourceObject = resourceObject.replace('command', 'Request');
      }

      if (resources[i].indexOf('_') != -1) {
        const names = resourceObject.split('_');
        resourceObject = '';

        for (let name of names) {
          resourceObject += name.charAt(0).toUpperCase() + name.substr(1);
        }
      }

      for (let event of eventTypes) {
        kafkaCfg[`${resources[i]}${event}`] = {
          protos: [
            proto
          ],
          protoRoot: root,
          messageObject: `${resourcesServiceNamePrefix}${resources[i]}.${resourceObject}`
        };
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
    const events = new kafkaClient.Events(cfg.get('events:kafka'), logger);
    // Enable events firing for resource api using config
    let isEventsEnabled = cfg.get('events:enableEvents');
    if (isEventsEnabled === 'true') {
      isEventsEnabled = true;
    } else { // Undefined means events not enabled
      isEventsEnabled = false;
    }

    await events.start();

    // load resource services
    let restoreSetup = {};
    let validResourceTopicNames = [];

    let redisClient: any;
    if (cfg.get('redis')) {
      redisClient = redis.createClient();
    }

    const fieldGeneratorConfig: any = cfg.get('fieldGenerators');
    for (let i = 0; i < resources.length; i += 1) {
      const resourceName = resources[i];

      let resourceFieldGenConfig: any;
      if (resourceName in fieldGeneratorConfig) {
        resourceFieldGenConfig = {};
        resourceFieldGenConfig['strategies'] = fieldGeneratorConfig[resourceName];
        logger.info('Setting up field generators on Redis...');
        resourceFieldGenConfig['redisClient'] = redisClient;
      }

      logger.info(`Setting up ${resourceName} resource service`);

      const resourceAPI = new ResourcesAPIBase(db, `${resourceName}s`, resourceFieldGenConfig);
      const resourceEvents = events.topic(resourcesServiceNamePrefix + `${resourceName}s.resource`);
      // const protobufModule = require(`./protos/io/restorecommerce/${resourceName}_pb.js`);
      const service = new ServiceBase(resourceName,
        resourceEvents, logger, resourceAPI, isEventsEnabled);
      await co(server.bind(`${resourcesServiceConfigPrefix}${resourceName}-srv`, service));
      // CIS listener
      const resourcesRestoreSetup = this.makeResourcesRestoreSetup(db, resourceName);
      const topicName = resourcesServiceNamePrefix + `${resourceName}s.resource`;
      validResourceTopicNames.push(topicName);
      restoreSetup[topicName] = {
        topic: resourceEvents,
        events: resourcesRestoreSetup,
      };
    }
    // Add CommandInterfaceService
    const CommandInterfaceService = rcsi.CommandInterface;
    const cis = new CommandInterfaceService(server, restoreSetup, cfg.get(), logger);
    const cisName = cfg.get('command-interface:name');
    await co(server.bind(cisName, cis));

    const topics = kafkaCfg.topics;

    let that = this;
    let resourcesServiceEventListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      const requestObject = msg;
      const commandTopic = kafkaCfg.topics.command.topic;
      if (eventName === RESTORE_CMD_EVENT) {
        if (requestObject && requestObject.topics && (_.includes(validResourceTopicNames,
          requestObject.topics[0].topic))) {

          await cis.restore(requestObject);
        }
      }
      else if (eventName === HEALTHCHECK_CMD_EVENT) {
        if (requestObject && (_.includes(_.keys(grpcConfig.services), requestObject.service))) {
          const serviceStatus = await cis.check(requestObject);
          const healthCheckTopic = events.topic(commandTopic);
          await healthCheckTopic.emit(HEALTHCHECK_RES_EVENT,
            serviceStatus);
        }
      }
      else if (eventName === RESET_START_EVENT) {
        const resetStatus = await cis.reset(requestObject);
        if (resetStatus) {
          const resetTopic = events.topic(commandTopic);
          await resetTopic.emit(RESET_DONE_EVENT,
            resetStatus);
        }
      }
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic: kafkaClient.Topic = events.topic(topicName);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await topic.on(eventName, resourcesServiceEventListener);
        }
      }
    }

    // Add reflection service
    const transportName = cfg.get('server:services:reflection:serverReflectionInfo:transport:0');
    const transport = server.transport[transportName];
    const reflectionService = new grpc.ServerReflection(transport.$builder, server.config);
    await co(server.bind('reflection', reflectionService));

    // Start server
    await co(server.start());
    logger.info('Server Started Correctly');
    this.events = events;
    this.server = server;
    this.logger = logger;

    if (redisClient) {
      this.redisClient = redisClient;
    }
  }

  makeResourcesRestoreSetup(db: any, collectionName: string): any {
    let that = this;
    return {
      [`${collectionName}Deleted`]: async function restoreDeleted(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.delete(collectionName, { id: message.id }));
        return {};
      },
      [`${collectionName}Modified`]: async function restoreModified(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        const patch = {
          active: true,
          activation_code: '',
        };
        await co(db.update(collectionName, { id: message.id }, _.omitBy(message, _.isNil)));
        return {};
      },
      [`${collectionName}Created`]: async function restoreCreated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.insert(`${collectionName}s`, message));
        return {};
      }
    };
  }

  async stop() {
    this.logger.info('Shutting down');
    await co(this.server.end());
    await this.events.stop();

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

