import * as should from 'should';
import * as srvConfig from '@restorecommerce/service-config';
import * as grpcClient from '@restorecommerce/grpc-client';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { Logger } from '@restorecommerce/logger';
import { Worker } from '../lib/worker';
import { updateConfig } from '@restorecommerce/acs-client';
import { createMockServer } from 'grpc-mock';

const cfg = srvConfig(process.cwd() + '/test');
const logger = new Logger(cfg.get('logger'));

/**
 * Note: To run below tests a running Kafka, Redis and ArangoDB instance is required.
 * Kafka can be disabled if the config 'enableEvents' is set to false.
 */
const meta = {
  modified_by: 'AdminID',
  owner: [{
    "id": "urn:restorecommerce:acs:names:ownerIndicatoryEntity",
    "value": "urn:restorecommerce:acs:model:organization.Organization"
  },
  {
    "id": "urn:restorecommerce:acs:names:ownerInstance",
    "value": "orgC"
  }]
};

const listOfContactPoints = [
  {
    id: 'contact_point_1',
    website: 'http://TestOrg1.de',
    meta
  },
  {
    id: 'contact_point_2',
    website: 'http://TestOrg2.de',
    meta
  },
];

const permitAllEntitiesRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:*.*' }],
    subject: [
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
            action: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:*.*'
            }],
            subject: []
          }, effect: 'PERMIT',
          rules: [ // permit or deny rule will be added
            permitAllEntitiesRule
          ],
          has_rules: true
        }]
    }]
};

let subject = {
  id: 'admin_user_id',
  scope: 'orgC',
  role_associations: [
    {
      role: 'admin-r-id',
      attributes: [{
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingInstance',
        value: 'mainOrg'
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

interface serverRule {
  method: string,
  input: any,
  output: any
}

let mockServer: any;
const startGrpcMockServer = async (rules: serverRule[]) => {
  // Create a mock ACS server to expose isAllowed and whatIsAllowed
  mockServer = createMockServer({
    protoPath: 'test/protos/io/restorecommerce/access_control.proto',
    packageName: 'io.restorecommerce.access_control',
    serviceName: 'Service',
    options: {
      keepCase: true
    },
    rules
  });
  mockServer.listen('0.0.0.0:50061');
  logger.info('ACS Server started on port 50061');
};

const stopGrpcMockServer = async () => {
  await mockServer.close(() => {
    logger.info('Server closed successfully');
  });
};

function encodeMsg(data: any): any {
  const encoded = Buffer.from(JSON.stringify(data));
  return {
    type_url: 'payload',
    value: encoded
  };
}

// get client connection object
async function getClientResourceServices() {
  const options: any = { microservice: {} };
  options.microservice = {
    service: {},
    mapClients: new Map()
  };
  const resources = cfg.get('resources');
  const clientConfig = cfg.get('client');
  for (let resource in resources) {
    const resourceCfg = resources[resource];
    const resourceNames = resourceCfg.resources;
    const protosPrefix = resourceCfg.resourcesProtoPathPrefix;
    const servicePrefix = resourceCfg.resourcesServiceNamePrefix;

    logger.silly('microservice clients', resourceNames);

    for (let resource of resourceNames) {
      if (resource === 'command') {
        // if resource is command create a commandInterface client
        const serviceName = 'io.restorecommerce.commandinterface.Service';
        const client = new grpcClient.Client(cfg.get('client:commandinterface'), logger);
        options.microservice.service[serviceName] = await client.connect();
        options.microservice.mapClients.set(resource, serviceName);
        continue;
      }
      const protos = [`${protosPrefix}/${resource}.proto`];
      const serviceName = `${servicePrefix}${resource}.Service`;
      const defaultConfig = clientConfig['default-resource-srv'];
      defaultConfig.transports.grpc.protos = protos;
      defaultConfig.transports.grpc.service = serviceName;
      try {
        const client = new grpcClient.Client(defaultConfig, logger);
        options.microservice.service[serviceName] = await client.connect();
        options.microservice.mapClients.set(resource, serviceName);
        logger.verbose('connected to microservice', serviceName);
      } catch (err) {
        logger.error('microservice connecting to service',
          serviceName, err);
      }
    }
  }

  return options;
}

describe('resource-srv testing with ACS enabled', () => {
  let options;
  let organizationService;
  let contactPointsService;
  let commandService;
  let worker: Worker;
  let events: Events;
  let commandTopic: Topic;
  let organizationTopic: Topic;
  let validate;
  let baseValidation = function (result: any) {
    should.exist(result);
    should.not.exist(result.error);
    should.exist(result.data);
    should.exist(result.data.items);
  };

  // start the server and get the clientService Obj based on resourceName
  before(async function startServer() {
    worker = new Worker();
    await worker.start(cfg);
    // get the client object
    // List of serviceMappedValues
    const serviceMapping = await getClientResourceServices();
    // get the Organization service
    let orgMapValue = serviceMapping.microservice.mapClients.get('organization');
    organizationService = serviceMapping.microservice.service[orgMapValue];
    // get contact_point service
    let contacPointMapValue = serviceMapping.microservice.mapClients.get('contact_point');
    contactPointsService = serviceMapping.microservice.service[contacPointMapValue];

    // create events for restoring
    events = new Events(cfg.get('events:kafka'), logger);
    await events.start();
    organizationTopic = events.topic(cfg.get('events:kafka:topics:organizations:topic'));
    commandTopic = events.topic(cfg.get('events:kafka:topics:command:topic'));

    // create command service
    let commandMapValue = serviceMapping.microservice.mapClients.get('command');
    commandService = serviceMapping.microservice.service[commandMapValue];
  });

  // stop the server
  after(async function stopServer() {
    await worker.stop();
  });

  it('should create contact_point resource', async function createContactPoints() {
    // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
    // to get applicable policies although acs-lookup is disabled
    startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: policySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
    const result = await contactPointsService.create({ items: listOfContactPoints, subject });
    baseValidation(result);
    result.data.items.should.be.length(2);
    result.data.items[0].website.should.equal('http://TestOrg1.de');
    result.data.items[1].website.should.equal('http://TestOrg2.de');
  });
  it('should throw an error when creating contact_point resource with invalid subject scope', async function createContactPoints() {
    subject.scope = 'orgD';
    stopGrpcMockServer();
    startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: policySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'DENY' } }]);
    const result = await contactPointsService.create({ items: listOfContactPoints, subject });
    should.exist(result.error);
    result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:contact_point, action:CREATE, target_scope:orgD; the response was DENY');
  });
  it('should throw error updating contact point resource with invalid subject scope', async function deleteContactPoint() {
    const updateResult = await contactPointsService.update({ items: listOfContactPoints, subject });
    should.exist(updateResult.error);
    updateResult.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:contact_point, action:MODIFY, target_scope:orgD; the response was DENY');
  });
  it('should throw error upserting contact point resource with invalid subject scope', async function deleteContactPoint() {
    const updateResult = await contactPointsService.upsert({ items: listOfContactPoints, subject });
    should.exist(updateResult.error);
    updateResult.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:contact_point, action:MODIFY, target_scope:orgD; the response was DENY');
  });
  it('should throw error deleting contact point resource with invalid subject scope', async function deleteContactPoint() {
    const deletedResult = await contactPointsService.delete({ ids: ['contact_point_1', 'contact_point_2'], subject });
    should.exist(deletedResult);
    should.exist(deletedResult.error);
    deletedResult.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:contact_point, action:DELETE, target_scope:orgD; the response was DENY');
  });
  it('should update contact point resource with valid subject scope', async function deleteContactPoint() {
    subject.scope = 'orgC';
    stopGrpcMockServer();
    startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: policySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
    listOfContactPoints[0].website = 'http://newtest1.de';
    listOfContactPoints[1].website = 'http://newtest2.de';
    const updateResult = await contactPointsService.update({ items: listOfContactPoints, subject });
    baseValidation(updateResult);
    updateResult.data.items[0].website.should.equal('http://newtest1.de');
    updateResult.data.items[1].website.should.equal('http://newtest2.de');
  });
  it('should throw error when trying to update contact point not existing with valid subject scope', async function deleteContactPoint() {
    const contactPoint = {
      id: 'contact_point_3',
      website: 'http://TestOrg3.de',
      meta
    };
    const updateResult = await contactPointsService.update({ items: contactPoint, subject });
    should.exist(updateResult.error);
    updateResult.error.message.should.equal('not found');
  });
  it('should upsert contact point with valid subject scope', async function deleteContactPoint() {
    const contactPoint = {
      id: 'contact_point_3',
      website: 'http://TestOrg3.de',
      meta
    };
    const upsertResult = await contactPointsService.upsert({ items: contactPoint, subject });
    baseValidation(upsertResult);
    upsertResult.data.items[0].website.should.equal(contactPoint.website);
  });
  it('should delete contact point resource', async function deleteContactPoint() {
    subject.scope = 'orgC';
    stopGrpcMockServer();
    startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: policySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }]);
    const deletedResult = await contactPointsService.delete({ collection: true, subject });
    should.exist(deletedResult);
    should.not.exist(deletedResult.error);

    const resultAfterDeletion = await contactPointsService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }],
      subject
    });
    baseValidation(resultAfterDeletion);
    resultAfterDeletion.data.items.should.be.length(0);
  });
});
