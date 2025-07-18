import {} from 'mocha';
import should from 'should';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { Events, registerProtoMeta } from '@restorecommerce/kafka-client';
import { Worker } from '../src/worker.js';
import { GrpcMockServer, ProtoUtils } from '@alenon/grpc-mock-server';
import * as proto_loader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import { createLogger } from '@restorecommerce/logger';
import { createServiceConfig } from '@restorecommerce/service-config';
import { CommandInterfaceServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface.js';
import {
  CommandServiceDefinition as command,
  protoMetadata as commandPointMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/command.js';
import {
  OrganizationServiceDefinition as organization,
  protoMetadata as organizationMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/organization.js';
import {
  ContactPointServiceDefinition as contact_point,
  protoMetadata as contactPointMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point.js';
import { createClient as RedisCreateClient, RedisClientType } from 'redis';
import { updateConfig } from '@restorecommerce/acs-client';

registerProtoMeta(
  organizationMeta,
  contactPointMeta,
  commandPointMeta
);

const cfg = createServiceConfig(process.cwd());
const logger = createLogger(cfg.get('logger'));
const ServiceDefinitionList = [command, organization, contact_point];
let redisClient: RedisClientType;
let tokenRedisClient: RedisClientType;

/**
 * Note: To run below tests a running Kafka, Redis and ArangoDB instance is required.
 * Kafka can be disabled if the config 'enableEvents' is set to false.
 */

const listOfContactPoints = [
  {
    id: 'contact_point_1',
    website: 'http://TestOrg1.de',
  },
  {
    id: 'contact_point_2',
    website: 'http://TestOrg2.de',
  },
];

const permitAllEntitiesRule = {
  id: 'permit_rule_id',
  target: {
    actions: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:*.*' }],
    subjects: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'PERMIT'
};

let policySetRQ = {
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'user_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'user_test_policy_id',
          target: {
            actions: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:*.*'
            }],
            subjects: []
          }, effect: 'PERMIT',
          rules: [ // permit or deny rule will be added
            permitAllEntitiesRule
          ],
          has_rules: true
        }]
    }]
};

let expires_in = new Date(); // set expires_in to +1 day
expires_in.setDate(expires_in.getDate() + 1);
let subject = {
  id: 'admin_user_id',
  scope: 'orgC',
  token: 'admin_token',
  tokens: [{ token: 'admin_token', expires_in }],
  role_associations: [
    {
      role: 'admin-r-id',
      attributes: [{
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization',
        attributes: [{
          id: 'urn:restorecommerce:acs:names:roleScopingInstance',
          value: 'mainOrg'
        }]
      }]
    }
  ],
  hierarchical_scopes: [
    {
      id: 'mainOrg',
      role: 'admin-r-id',
      children: [{
        id: 'orgA',
        children: [{
          id: 'orgB',
          children: [{
            id: 'orgC'
          }]
        }]
      }]
    }
  ]
};

interface MethodWithOutput {
  method: string,
  output: any
};

const PROTO_PATH: string = 'io/restorecommerce/access_control.proto';
const PKG_NAME: string = 'io.restorecommerce.access_control';
const SERVICE_NAME: string = 'AccessControlService';
const pkgDef: grpc.GrpcObject = grpc.loadPackageDefinition(
  proto_loader.loadSync(PROTO_PATH, {
    includeDirs: ['node_modules/@restorecommerce/protos'],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
);

const proto: any = ProtoUtils.getProtoFromPkgDefinition(
  PKG_NAME,
  pkgDef
);

const mockServer = new GrpcMockServer('localhost:50161');

const startGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    isAllowed: (call: any, callback: any) => {
      const isAllowedResponse = methodWithOutput.filter(e => e.method === 'IsAllowed');
      let response: any = new proto.Response.constructor(isAllowedResponse[0].output);
      // Delete request with invalid scope - DENY
      if (call?.request?.target?.subjects?.length === 2) {
        let reqSubject = call.request.target.subjects;
        if (reqSubject[1]?.id === 'urn:restorecommerce:acs:names:roleScopingInstance' && reqSubject[1]?.value === 'orgD') {
          response = { decision: 'DENY' };
        }
      }
      callback(null, response);
    },
    whatIsAllowed: (call: any, callback: any) => {
      // check the request object and provide UserPolicies / RolePolicies
      const whatIsAllowedResponse = methodWithOutput.filter(e => e.method === 'WhatIsAllowed');
      const response: any = new proto.ReverseQuery.constructor(whatIsAllowedResponse[0].output);
      callback(null, response);
    }
  };
  try {
    mockServer.addService(PROTO_PATH, PKG_NAME, SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServer.start();
    logger.info('Mock ACS Server started on port 50161');
  } catch (err) {
    logger.error('Error starting mock ACS server', err);
  }
};

const IDS_PROTO_PATH = 'io/restorecommerce/user.proto';
const IDS_PKG_NAME = 'io.restorecommerce.user';
const IDS_SERVICE_NAME = 'UserService';

const mockServerIDS = new GrpcMockServer('localhost:50151');

// Mock server for ids - findByToken
const startIDSGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    findByToken: (call: any, callback: any) => {
      if (call.request.token === 'admin_token') {
        // admin user
        callback(null, { payload: subject, status: { code: 200, message: 'success' } });
      }
    }
  };
  try {
    mockServerIDS.addService(IDS_PROTO_PATH, IDS_PKG_NAME, IDS_SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServerIDS.start();
    logger.info('Mock IDS Server started on port 50151');
  } catch (err) {
    logger.error('Error starting mock IDS server', err);
  }
};

const stopGrpcMockServer = async () => {
  await mockServer.stop();
  logger.info('Mock ACS Server closed successfully');
};

const stopIDSGrpcMockServer = async () => {
  await mockServerIDS.stop();
  logger.info('Mock IDS Server closed successfully');
};

// get client connection object
async function getClientResourceServices() {
  const options: any = {
    microservice: {
      service: {},
      mapClients: new Map()
    }
  };
  const resources = cfg.get('resources');
  const clientConfig = cfg.get('client');
  for (const resourceCfg of Object.values<any>(resources)) {
    // const protosPrefix = resourceCfg.resourcesProtoPathPrefix;
    const servicePrefix = resourceCfg.resourcesServiceNamePrefix;

    logger.silly('microservice clients', resourceCfg.resources);

    for (const { resourceName, collectionName } of resourceCfg.resources) {
      if (resourceName === 'command') {
        // if resource is command create a commandInterface client
        const serviceName = 'io.restorecommerce.commandinterface.Service';
        const cisConfig = cfg.get('client:commandinterface');
        const client = cisConfig && createClient(
          { ...cisConfig, logger },
          CommandInterfaceServiceDefinition,
          createChannel(cisConfig.address)
        );
        // const client = new GrpcClient(cfg.get('client:commandinterface'), logger);
        options.microservice.service[serviceName] = client;
        options.microservice.mapClients.set(resourceName, serviceName);
        continue;
      }
      const serviceName = `${servicePrefix}${resourceName}-srv`;
      const defaultConfig = clientConfig['default-resource-srv'];
      try {
        let serviceDefinition = ServiceDefinitionList.filter((obj) => obj.fullName.split('.')[2] === resourceName)[0];
        const client = createClient(
          { ...defaultConfig, logger },
          serviceDefinition,
          createChannel(defaultConfig.address)
        );
        options.microservice.service[serviceName] = client;
        options.microservice.mapClients.set(resourceName, serviceName);
        logger.verbose('connected to microservice', serviceName);
      } catch (err) {
        logger.error(
          'microservice connecting to service',
          serviceName,
          err
        );
      }
    }
  }

  return options;
}

describe('resource-srv testing with ACS enabled', () => {
  let contactPointsService: any;
  let worker: Worker;
  let events: Events;
  const baseValidation = function (result: any, itemsShouldExist: boolean = true) {
    should.exist(result);
    if (itemsShouldExist) {
      should.exist(result.items);
    }
    should.exist(result.operation_status);
  };

  // start the server and get the clientService Obj based on resourceName
  before(async function startServer() {
    // enable ACS check
    cfg.set('authorization:enabled', true);
    updateConfig(cfg);
    worker = new Worker();
    await worker.start(cfg, logger);
    // get the client object
    // List of serviceMappedValues
    const serviceMapping = await getClientResourceServices();
    // get contact_point service
    const contacPointMapValue = serviceMapping.microservice.mapClients.get('contact_point');
    contactPointsService = serviceMapping.microservice.service[contacPointMapValue];

    // create events for restoring
    events = new Events(cfg.get('events:kafka'), logger);
    await events.start();
  });

  // stop the server
  after(async function stopServer() {
    await stopGrpcMockServer();
    await stopIDSGrpcMockServer();
    await worker.stop();
  });

  it('should create contact_point resource', async function createContactPoints() {
    // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
    // to get applicable policies although acs-lookup is disabled
    startGrpcMockServer([{ method: 'WhatIsAllowed', output: policySetRQ },
    { method: 'IsAllowed', output: { decision: 'PERMIT' } }]);

    // start mock ids-srv needed for findByToken response and return subject
    await startIDSGrpcMockServer([{ method: 'findByToken', output: subject }]);

    // set redis client
    // since its not possible to mock findByToken as it is same service, storing the token value with subject
    // HR scopes resolved to db-subject redis store and token to findByToken redis store
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject') || 0;
    redisClient = RedisCreateClient(redisConfig);
    redisClient.on('error', (err) => logger.error('Redis Client Error', err));
    await redisClient.connect();

    // for findByToken
    redisConfig.database = cfg.get('redis:db-indexes:db-findByToken') || 0;
    tokenRedisClient = RedisCreateClient(redisConfig);
    tokenRedisClient.on('error', (err) => logger.error('Redis client error in token cache store', err));
    await tokenRedisClient.connect();

    // store hrScopesKey and subjectKey to Redis index `db-subject`
    const hrScopeskey = `cache:${subject.id}:${subject.token}:hrScopes`;
    const subjectKey = `cache:${subject.id}:subject`;
    await redisClient.set(subjectKey, JSON.stringify(subject));
    await redisClient.set(hrScopeskey, JSON.stringify(subject.hierarchical_scopes));

    // store user with tokens and role associations to Redis index `db-findByToken`
    await tokenRedisClient.set('admin-token', JSON.stringify(subject));

    const result = await contactPointsService.create({ items: listOfContactPoints, subject });
    baseValidation(result);
    result.items.should.be.length(2);
    result.items[0].payload.website.should.equal('http://TestOrg1.de');
    result.items[1].payload.website.should.equal('http://TestOrg2.de');
  });
  it('should throw an error when creating contact_point resource with invalid subject scope', async function createContactPoints() {
    subject.scope = 'orgD';
    const result = await contactPointsService.create({ items: listOfContactPoints, subject });
    should.exist(result.operation_status);
    result.operation_status.code.should.equal(403);
    result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:contact_point, action:CREATE, target_scope:orgD; the response was DENY');
  });
  it('should throw error updating contact point resource with invalid subject scope', async function deleteContactPoint() {
    const updateResult = await contactPointsService.update({ items: listOfContactPoints, subject });
    should.exist(updateResult.operation_status);
    updateResult.operation_status.code.should.equal(403);
    updateResult.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:contact_point, action:MODIFY, target_scope:orgD; the response was DENY');
  });
  it('should throw error upserting contact point resource with invalid subject scope', async function deleteContactPoint() {
    const updateResult = await contactPointsService.upsert({ items: listOfContactPoints, subject });
    should.exist(updateResult.operation_status);
    updateResult.operation_status.code.should.equal(403);
    updateResult.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:contact_point, action:MODIFY, target_scope:orgD; the response was DENY');
  });
  it('should throw error deleting contact point resource with invalid subject scope', async function deleteContactPoint() {
    const deletedResult = await contactPointsService.delete({ ids: ['contact_point_1', 'contact_point_2'], subject });
    should.not.exist(deletedResult.status);
    should.exist(deletedResult.operation_status);
    deletedResult.operation_status.code.should.equal(403);
    deletedResult.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:contact_point, action:DELETE, target_scope:orgD; the response was DENY');
  });
  it('should update contact point resource with valid subject scope', async function deleteContactPoint() {
    subject.scope = 'orgC';
    listOfContactPoints[0].website = 'http://newtest1.de';
    listOfContactPoints[1].website = 'http://newtest2.de';
    const updateResult = await contactPointsService.update({ items: listOfContactPoints, subject });
    baseValidation(updateResult);
    updateResult.items[0].payload.website.should.equal('http://newtest1.de');
    updateResult.items[1].payload.website.should.equal('http://newtest2.de');
  });
  it('should throw error when trying to update contact point not existing with valid subject scope', async function deleteContactPoint() {
    const contactPoint = [{
      id: 'contact_point_3',
      website: 'http://TestOrg3.de'
    }];
    const updateResult = await contactPointsService.update({ items: contactPoint, subject });
    should.exist(updateResult.operation_status);
    // update status for item failure
    // updateResult.items[0].status.id.should.equal('contact_point_3');
    updateResult.items[0].status.code.should.equal(404);
    updateResult.items[0].status.message.should.equal('document not found');
    // overall status success
    updateResult.operation_status.code.should.equal(207);
    updateResult.operation_status.message.should.equal('Multi status - response may include errors!');
  });
  it('should upsert contact point with valid subject scope', async function deleteContactPoint() {
    const contactPoint = [{
      id: 'contact_point_3',
      website: 'http://TestOrg3.de'
    }];
    const upsertResult = await contactPointsService.upsert({ items: contactPoint, subject });
    baseValidation(upsertResult);
    upsertResult.items[0].payload.website.should.equal(contactPoint[0].website);
  });
  it('should delete contact point resource all', async function deleteContactPoint() {
    subject.scope = 'orgC';
    const deletedResult = await contactPointsService.delete({ collection: true, subject });
    should.exist(deletedResult);
    // overall_status
    should.exist(deletedResult.operation_status);
    deletedResult.operation_status.code.should.equal(200);
    deletedResult.operation_status.message.should.equal('success');
    const resultAfterDeletion = await contactPointsService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }],
      subject
    });
    baseValidation(resultAfterDeletion, false);
    should.not.exist(resultAfterDeletion.items);
  });
});
