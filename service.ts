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
import { ResourcesAPIBase, ServiceBase, GraphResourcesServiceBase } from '@restorecommerce/resource-base-interface';

export class Worker {
  server: Server;
  events: Events;
  logger: any;
  redisClient: any;
  offsetStore: OffsetStore;
  cis: ICommandInterface;
  service: ServiceBase[];
  async start(cfg?: any, resourcesServiceEventListener?: Function) {
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
    const db = await database.get(cfg.get('database:arango'),
      logger, cfg.get('graph:graphName'));
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
    const requiredFieldsConfig: any = cfg.get('fieldHandlers:requiredFields');

    // Enable events firing for resource api using config
    const isEventsEnabled = (cfg.get('events:enableCRUDEvents') == 'true');
    const graphCfg = cfg.get('graph');

    for (let resourceType in resources) {
      const resourceCfg = resources[resourceType];
      const resourcesServiceConfigPrefix = resourceCfg.resourcesServiceConfigPrefix;
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      this.service = [];
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
        const resourceEvents = events.topic(`${resourcesServiceNamePrefix}${resourceName}s.resource`);
        this.service[resourceName] = new ServiceBase(resourceName,
          resourceEvents, logger, resourceAPI, isEventsEnabled);
        await server.bind(`${resourcesServiceConfigPrefix}${resourceName}-srv`, this.service[resourceName]);
      }
    }

    // Add CommandInterfaceService
    const cis: ICommandInterface = new ResourceCommandInterface(server, cfg.get(), logger, events);
    const cisName = cfg.get('command-interface:name');
    await server.bind(cisName, cis);

    const that = this;
    if (!resourcesServiceEventListener) {
      resourcesServiceEventListener = async function eventListener(msg: any,
        context: any, config: any, eventName: string): Promise<any> {
        try {
          await cis.command(msg, context);
        } catch (err) {
          that.logger.error('Error while executing command', err);
        }
      };
    }

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
          await topic.on(eventName, resourcesServiceEventListener, { startingOffset: offSetValue });
        }
      }
    }

    // Add reflection service
    const transportName = cfg.get('server:services:reflection:serverReflectionInfo:transport:0');
    const transport = server.transport[transportName];
    const reflectionService = new grpc.ServerReflection(transport.$builder, server.config);
    await server.bind('reflection', reflectionService);

    // graph Service
    const graphAPIService = new GraphResourcesServiceBase(db, cfg.get('fieldHandlers:bufferFields'));
    await server.bind('graph', graphAPIService);

    // Start server
    await server.start();
    logger.info('Server Started Correctly');
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
    if (this.redisClient) {
      await this.redisClient.quit();
    }
  }
}

class ResourceCommandInterface extends CommandInterface {
  edgeCfg: any;
  // graphName: any;
  constructor(server: Server, cfg: any, logger: any, events: Events) {
    super(server, cfg, logger, events);
    if (cfg.graph && cfg.graph.vertices) {
      this.edgeCfg = cfg.graph.vertices;
      // this.graphName = cfg.graph.graphName;
    }
  }

  makeResourcesRestoreSetup(db: any, resource: string): any {
    const that = this;
    const collectionName = `${resource}s`;
    return {
      [`${resource}Created`]: async function restoreCreated(message: any,
        context: any, config: any, eventName: string): Promise<any> {
        that.decodeBufferField(message, resource);
        if (that.edgeCfg[collectionName]) {
          const result = await db.findByID(collectionName, message.id);
          if (result.length > 0) {
            return {};
          }
          await db.createVertex(collectionName, message);
          // Based on graphCfg create the necessary edges
          for (let eachEdgeCfg of that.edgeCfg[collectionName]) {
            const fromIDkey = eachEdgeCfg.from;
            const from_id = message[fromIDkey];
            const toIDkey = eachEdgeCfg.to;
            const to_id = message[toIDkey];
            const fromVerticeName = collectionName;
            const toVerticeName = eachEdgeCfg.toVerticeName;
            if (fromVerticeName && toVerticeName) {
              const edgeDefRes = await db.addEdgeDefinition(eachEdgeCfg.edgeName, [fromVerticeName],
                [toVerticeName]);
            }
            if (from_id && to_id) {
              if (_.isArray(to_id)) {
                for (let toID of to_id) {
                  await db.createEdge(eachEdgeCfg.edgeName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                }
                continue;
              }
              await db.createEdge(eachEdgeCfg.edgeName, null,
                `${fromVerticeName}/${from_id}`, `${toVerticeName}/${to_id}`);
            }
          }
        } else {
          await db.insert(collectionName, message);
        }
        return {};
      },
      [`${resource}Modified`]: async function restoreModified(message: any,
        context: any, config: any, eventName: string): Promise<any> {
        that.decodeBufferField(message, resource);
        // Based on graphcfg update necessary edges
        if (that.edgeCfg[collectionName]) {
          const foundDocs = await db.find(collectionName, { id: message.id });
          const dbDoc = foundDocs[0];
          for (let eachEdgeCfg of that.edgeCfg[collectionName]) {
            const toIDkey = eachEdgeCfg.to;
            let modified_to_idValues = message[toIDkey];
            let db_to_idValues = dbDoc[toIDkey];
            if (_.isArray(modified_to_idValues)) {
              modified_to_idValues = _.sortBy(modified_to_idValues);
            }
            if (_.isArray(db_to_idValues)) {
              db_to_idValues = _.sortBy(db_to_idValues);
            }
            // delete and recreate only if there is a difference in references
            if (!_.isEqual(modified_to_idValues, db_to_idValues)) {
              const fromIDkey = eachEdgeCfg.from;
              const from_id = message[fromIDkey];
              const fromVerticeName = collectionName;
              const toVerticeName = eachEdgeCfg.toVerticeName;

              const edgeCollectionName = eachEdgeCfg.edgeName;
              let outgoingEdges: any = await db.getOutEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              for (let outgoingEdge of outgoingEdges) {
                const removedEdge = await db.removeEdge(edgeCollectionName, outgoingEdge._id);
              }
              // Create new edges
              if (from_id && modified_to_idValues) {
                if (_.isArray(modified_to_idValues)) {
                  for (let toID of modified_to_idValues) {
                    await db.createEdge(eachEdgeCfg.edgeName, null,
                      `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                  }
                  continue;
                }
                await db.createEdge(edgeCollectionName, null,
                  `${fromVerticeName}/${from_id}`, `${toVerticeName}/${modified_to_idValues}`);
              }
            }
          }
        }
        await db.update(collectionName, { id: message.id }, _.omitBy(message, _.isNil));
        return {};
      },
      [`${resource}Deleted`]: async function restoreDeleted(message: any,
        context: any, config: any, eventName: string): Promise<any> {
        if (that.edgeCfg[collectionName]) {
          // Modify the Ids to include documentHandle
          await db.removeVertex(collectionName, `${collectionName}/${message.id}`);
        } else {
          await db.delete(collectionName, { id: message.id });
        }
        return {};
      }
    };
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
