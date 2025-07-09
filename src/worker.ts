import { Events, Topic, registerProtoMeta } from '@restorecommerce/kafka-client';
import { GraphResourcesServiceBase, ResourcesAPIBase } from '@restorecommerce/resource-base-interface';
import { initAuthZ, initializeCache } from '@restorecommerce/acs-client';
import { ResourceCommandInterface } from './commandInterface.js';
import {
  database,
  GraphDatabaseProvider,
  buildReflectionService,
  CommandInterface,
  OffsetStore,
  Server,
  Health
} from '@restorecommerce/chassis-srv';
import {
  createLogger,
  Logger
} from '@restorecommerce/logger';
import {
  createServiceConfig,
  type ServiceConfig
} from '@restorecommerce/service-config';
import { createClient, RedisClientType } from 'redis';
import {
  protoMetadata as commandMeta,
  CommandServiceDefinition as command
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/command.js';
import {
  protoMetadata as addressMeta,
  AddressServiceDefinition as address
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/address.js';
import {
  protoMetadata as contactPointTypeMeta,
  ContactPointTypeServiceDefinition as contact_point_type
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point_type.js';
import {
  protoMetadata as countryMeta,
  CountryServiceDefinition as country
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/country.js';
import {
  protoMetadata as contactPointMeta,
  ContactPointServiceDefinition as contact_point
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point.js';
import {
  protoMetadata as credentialMeta,
  CredentialServiceDefinition as credential
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/credential.js';
import {
  protoMetadata as currencyMeta,
  CurrencyServiceDefinition as currency
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/currency.js';
import {
  protoMetadata as localeMeta,
  LocaleServiceDefinition as locale
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/locale.js';
import {
  protoMetadata as locationMeta,
  LocationServiceDefinition as location
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/location.js';
import {
  protoMetadata as organizationMeta,
  OrganizationServiceDefinition as organization
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/organization.js';
import {
  protoMetadata as taxMeta,
  TaxServiceDefinition as tax
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/tax.js';
import {
  protoMetadata as taxTypeMeta,
  TaxTypeServiceDefinition as tax_type
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/tax_type.js';
import {
  protoMetadata as timezoneMeta,
  TimezoneServiceDefinition as timezone
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/timezone.js';
import {
  protoMetadata as customerMeta,
  CustomerServiceDefinition as customer
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/customer.js';
import {
  protoMetadata as shopMeta,
  ShopServiceDefinition as shop
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/shop.js';
import {
  protoMetadata as unitCodeMeta,
  UnitCodeServiceDefinition as unit_code
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/unit_code.js';
import {
  protoMetadata as templateMeta,
  TemplateServiceDefinition as template
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/template.js';
import {
  protoMetadata as settingMeta,
  SettingServiceDefinition as setting
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/setting.js';
import {
  protoMetadata as resourceMeta,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  protoMetadata as notificationMeta,
  NotificationServiceDefinition as notification
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/notification.js';
import {
  protoMetadata as notificationChannelMeta,
  NotificationChannelServiceDefinition as notification_channel
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/notification_channel.js';
import {
  CommandInterfaceServiceDefinition as CommandInterfaceServiceDefinition,
  protoMetadata as commandInterfaceMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface.js';
import {
  protoMetadata as reflectionMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/reflection/v1alpha/reflection.js';
import { ServerReflectionService } from 'nice-grpc-server-reflection';
import { HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health.js';
import {
  GraphServiceDefinition as GraphServiceDefinition,
  protoMetadata as graphMeta,
  GraphServiceClient
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph.js';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc/index.js';
import { protoMetadata as hierarchicalScopesMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { UserServiceClient } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import { ResourceService } from './service.js';
import { getUserServiceClient, getGraphServiceClient, createHRScope } from './utils.js';

const COMMANDEVENTS = [
  'restoreCommand',
  'healthCheckCommand',
  'resetCommand',
  'versionCommand',
  'configUpdateCommand',
  'flushCacheCommand'
];
const HIERARCHICAL_SCOPE_REQUEST_EVENT = 'hierarchicalScopesRequest';

const metas = [
  resourceMeta,
  commandMeta,
  addressMeta,
  contactPointTypeMeta,
  countryMeta,
  contactPointMeta,
  credentialMeta,
  currencyMeta,
  localeMeta,
  locationMeta,
  organizationMeta,
  taxMeta,
  taxTypeMeta,
  timezoneMeta,
  customerMeta,
  shopMeta,
  templateMeta,
  commandInterfaceMeta,
  reflectionMeta,
  graphMeta,
  unitCodeMeta,
  notificationMeta,
  notificationChannelMeta,
  hierarchicalScopesMeta,
  settingMeta,
];

registerProtoMeta(
  ...metas
);

const ServiceDefinitions = [
  command,
  address,
  contact_point_type,
  country,
  contact_point,
  credential,
  currency,
  locale,
  location,
  organization,
  tax,
  tax_type,
  timezone,
  customer,
  shop,
  unit_code,
  template,
  notification,
  notification_channel,
  setting,
];

export class Worker {
  readonly services = new Map<string, ResourceService>();

  server?: Server;
  events?: Events;
  logger?: Logger;
  redisClient: any;
  offsetStore?: OffsetStore;
  cis?: CommandInterface;
  idsClient?: UserServiceClient;
  graphClient?: GraphServiceClient;

  async start(
    cfg?: ServiceConfig,
    logger?: Logger,
    resourcesServiceEventListener?: object
  ) {
    // Load config
    cfg ??= createServiceConfig(process.cwd());
    const resources = cfg.get('resources');
    if (!resources) {
      throw new Error('config field resources does not exist');
    }

    // Generate a config for each resource
    const kafkaCfg = cfg.get('events:kafka');
    // const grpcConfig = cfg.get('server:transports:0');
    const eventTypes = ['Created', 'Read', 'Modified'];
    for (const resourceCfg of Object.values<any>(resources)) {
      const resourcesDeletedMessage = resourceCfg.resourcesDeletedMessage;
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      for (const { resourceName, collectionName } of resourceCfg.resources) {
        const resourceObjectName = resourceName.split('_').map(
          (name: string) => name.charAt(0).toUpperCase() + name.slice(1)
        ).join('');

        const topicName = `${resourcesServiceNamePrefix}${collectionName}.resource`;
        const topicLabel = `${resourceName}.resource`;
        kafkaCfg.topics[topicLabel] = {
          topic: topicName,
        };
        kafkaCfg[`${resourceName}Deleted`] = {
          messageObject: resourcesDeletedMessage
        };
        kafkaCfg[`${resourceName}DeletedAll`] = {
          messageObject: resourcesDeletedMessage
        };
        for (const event of eventTypes) {
          kafkaCfg[`${resourceName}${event}`] = {
            messageObject: `${resourcesServiceNamePrefix}${resourceName}.${resourceObjectName}`
          };
        }
      }
    }
    cfg.set('events:kafka', kafkaCfg);

    const loggerCfg = cfg.get('logger');
    this.logger = logger ??= createLogger(loggerCfg);
    const server = new Server(cfg.get('server'), logger);
    const db = await database.get(
      cfg.get('database:arango'),
      logger,
      cfg.get('graph:graphName'),
      cfg.get('graph:edgeDefinitions')
    ) as GraphDatabaseProvider;
    const events = new Events(cfg.get('events:kafka'), logger);

    await events.start();
    this.offsetStore = new OffsetStore(events as any, cfg, logger);
    let redisClient: RedisClientType<any, any> | undefined;
    if (cfg.get('redis')) {
      const redisConfig = cfg.get('redis');
      redisConfig.database = cfg.get('redis:db-indexes:db-resourcesCounter');
      redisClient = createClient(redisConfig);
      redisClient.on('error', (err) => logger.error('Redis Client Error', err));
      await redisClient.connect();
    }
    else {
      redisClient = undefined;
    }
    const fieldGeneratorConfig: any = cfg.get('fieldHandlers:fieldGenerators');
    const bufferHandlerConfig: any = cfg.get('fieldHandlers:bufferFields');
    const requiredFieldsConfig: any = cfg.get('fieldHandlers:requiredFields');

    // Enable events firing for resource api using config
    const isEventsEnabled = cfg.get('events:enableCRUDEvents')?.toString() === 'true';
    const graphCfg = cfg.get('graph');

    await initAuthZ(cfg);
    // init Redis Client for subject index
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject');
    const redisClientSubject: RedisClientType = createClient(redisConfig);
    await redisClientSubject.on('error', (err) => logger.error('Redis Client Error', err));
    await redisClientSubject.connect();
    for (const resourceCfg of Object.values<any>(resources)) {
      const resourcesServiceConfigPrefix = resourceCfg.resourcesServiceConfigPrefix;
      const resourcesServiceNamePrefix = resourceCfg.resourcesServiceNamePrefix;
      const collectionNames = cfg.get('database:arango:collections') as string[];

      for (const { resourceName, collectionName } of resourceCfg.resources) {
        if (!collectionNames?.includes(collectionName)) {
          logger.warn('No collection initialized for resourse', { resourceName, collectionName });
        }
        const resourceFieldConfig: any = {};
        if (fieldGeneratorConfig && (resourceName in fieldGeneratorConfig)) {
          resourceFieldConfig.strategies = fieldGeneratorConfig[resourceName];
          logger.info('Setting up field generators on Redis...');
          resourceFieldConfig.redisClient = redisClient;
        }
        // bufferFields handler
        if (bufferHandlerConfig && (resourceName in bufferHandlerConfig)) {
          resourceFieldConfig.bufferFields = bufferHandlerConfig[resourceName];
        }
        // dateTimeStampFields handler
        if (cfg.get('fieldHandlers:timeStampFields')) {
          resourceFieldConfig.timeStampFields = [];
          for (const timeStampFiledConfig of cfg.get('fieldHandlers:timeStampFields')) {
            if (timeStampFiledConfig.entities.includes(resourceName)) {
              resourceFieldConfig.timeStampFields.push(...timeStampFiledConfig.fields);
            }
          }
        }
        // requiredFields handler
        if (requiredFieldsConfig && (resourceName in requiredFieldsConfig)) {
          resourceFieldConfig.requiredFields = requiredFieldsConfig;
        }
        logger.info(`Setting up ${resourceName} resource service`);

        let edgeCfg;
        let graphName;
        if (graphCfg && graphCfg.vertices) {
          edgeCfg = graphCfg.vertices[collectionName];
        }
        if (graphCfg) {
          graphName = graphCfg.graphName;
        }
        const resourceAPI = new ResourcesAPIBase(
          db,
          collectionName,
          resourceFieldConfig,
          edgeCfg,
          graphName,
          logger,
          resourceName,
        );
        const resourceEvents = await events.topic(`${resourcesServiceNamePrefix}${collectionName}.resource`);
        // TODO provide typing on ResourceService<T, M>
        this.services.set(resourceName, new ResourceService(
          resourceName,
          resourceEvents,
          cfg,
          logger,
          resourceAPI,
          isEventsEnabled,
        ));

        const resourceServiceDefinition = ServiceDefinitions.find(
          (obj: any) => obj.fullName.split('.')[2] === resourceName
        );
        const serviceName = `${resourcesServiceConfigPrefix}${resourceName}-srv`;
        logger?.debug(`Bind ${resourceName} to ${serviceName} with ${resourceServiceDefinition?.fullName}`);
        if (resourceServiceDefinition) {
          await server.bind(serviceName, {
            service: resourceServiceDefinition,
            implementation: this.services.get(resourceName)
          } as BindConfig<typeof resourceServiceDefinition>);
        }
        else {
          logger?.error(`Implementation for ${resourceName} not found!`);
        }
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

    const hrTopicName = kafkaCfg?.topics?.user?.topic;
    const hrTopic = await events.topic(hrTopicName);
    this.idsClient = getUserServiceClient();
    this.graphClient = await getGraphServiceClient();

    if (!resourcesServiceEventListener) {
      resourcesServiceEventListener = async (
        msg: any,
        context: any,
        config: any,
        eventName: string
      ): Promise<any> => {
        if (COMMANDEVENTS.indexOf(eventName) > -1) {
          await cis.command(msg, context).catch(
            err => logger.error('Error while executing command', err)
          );
        } else if (eventName === HIERARCHICAL_SCOPE_REQUEST_EVENT) {
          const token = msg.token?.split(':')?.[0] as string;
          const user = token ? await this.idsClient?.findByToken({ token }) : undefined;
          if (!user?.payload?.id) {
            logger?.debug('Subject could not be resolved for token');
          }
          const subject = user?.payload?.id ? await createHRScope(user, token, this.graphClient!, null, cfg, this.logger) : undefined;
          if (hrTopic) {
            // emit response with same messag id on same topic
            logger?.info(`Hierarchical scopes are created for subject ${user?.payload?.id}`);
            await hrTopic.emit('hierarchicalScopesResponse', {
              subject_id: user?.payload?.id,
              token: msg.token,
              hierarchical_scopes: subject?.hierarchical_scopes
            });
          }
        }
      };
    }

    const topicTypes = Object.keys(kafkaCfg.topics);
    for (const topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic: Topic = await events.topic(topicName);
      const offSetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offSetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (const eventName of eventNames) {
          await topic.on(eventName, resourcesServiceEventListener, { startingOffset: offSetValue });
        }
      }
    }

    // Add reflection service
    const reflectionService = buildReflectionService(
      metas.map(meta => ({descriptor: meta.fileDescriptor}))
    );
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
    logger.debug('Start server...');
    await server.start();
    logger.info('Server started and ready to use.');
    this.events = events;
    this.server = server;
    this.cis = cis;

    if (redisClient) {
      this.redisClient = redisClient;
    }
  }

  async stop() {
    this.logger?.info('Shutting down');
    await Promise.allSettled(
      [
        this.server?.stop(),
        this.events?.stop(),
        this.offsetStore?.stop(),
      ]
    );
  }
}
