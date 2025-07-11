import {} from 'mocha';
import should from 'should';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { Events, Topic, registerProtoMeta } from '@restorecommerce/kafka-client';
import { Worker } from '../src/worker.js';
import { updateConfig } from '@restorecommerce/acs-client';
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
import { ReadRequest, Sort_SortOrder } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { Filter_Operation } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/filter.js';

const cfg = createServiceConfig(process.cwd());
const logger = createLogger(cfg.get('logger'));
const ServiceDefinitionList = [command, organization, contact_point];

// for test `should re read messages for organization resource` (since a local listener for Organization events is created in unit test below)
registerProtoMeta(
  organizationMeta,
  contactPointMeta,
  commandPointMeta
);

/**
 * Note: To run below tests a running Kafka, Redis and ArangoDB instance is required.
 * Kafka can be disabled if the config 'enableEvents' is set to false.
 */
const meta = {
  modified_by: 'AdminID',
  owners: [{
    "id": "urn:restorecommerce:acs:names:ownerIndicatoryEntity",
    "value": "urn:restorecommerce:acs:model:user.User",
    "attributes": [{
      "id": "urn:restorecommerce:acs:names:ownerInstance",
      "value": "Admin"
    }]
  }]
};

const listOfContactPoints = [
  {
    id: 'contact_point_1',
    website: 'http://TestOrg1.de',
    meta,
  },
  {
    id: 'contact_point_2',
    website: 'http://TestOrg2.de',
    meta,
  },
];

const listOfOrganizations = [
  {
    name: 'TestOrg1',
    address_id: '123',
    contact_point_ids: ['contact_point_1', 'contact_point_2'],
    meta,
  },
  {
    name: 'TestOrg2',
    address_id: '456',
    contact_point_ids: ['contact_point_1', 'contact_point_2'],
    meta,
  },
];

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

describe('resource-srv testing', () => {
  let options;
  let organizationService;
  let contactPointsService;
  let commandService;
  let worker: Worker;
  let events: Events;
  let commandTopic: Topic;
  let organizationTopic: Topic;
  const baseValidation = function (result: any, itemsShouldExist: boolean = true) {
    should.exist(result);
    if (itemsShouldExist) {
      should.exist(result.items);
    }
    should.exist(result.operation_status);
  };

  // start the server and get the clientService Obj based on resourceName
  before(async function startServer() {
    // disable ACS check
    cfg.set('authorization:enabled', false);
    updateConfig(cfg);
    worker = new Worker();
    await worker.start(cfg, logger);
    // get the client object
    // List of serviceMappedValues
    const serviceMapping = await getClientResourceServices();
    // get the Organization service
    const orgMapValue = serviceMapping.microservice.mapClients.get('organization');
    organizationService = serviceMapping.microservice.service[orgMapValue];
    // get contact_point service
    const contacPointMapValue = serviceMapping.microservice.mapClients.get('contact_point');
    contactPointsService = serviceMapping.microservice.service[contacPointMapValue];

    // create events for restoring
    events = new Events(cfg.get('events:kafka'), logger);
    await events.start();
    organizationTopic = await events.topic(cfg.get('events:kafka:topics:organizations:topic'));
    commandTopic = await events.topic(cfg.get('events:kafka:topics:command:topic'));

    // create command service
    let commandMapValue = serviceMapping.microservice.mapClients.get('command');
    commandService = serviceMapping.microservice.service[commandMapValue];
  });

  // stop the server
  after(async function stopServer() {
    await worker.stop();
  });

  it('should create contact_point resource and verify data and status response', async function createContactPoints() {
    const result = await contactPointsService.create({ items: listOfContactPoints });
    baseValidation(result);
    result.items.should.be.length(2);
    result.items[0].payload.website.should.equal('http://TestOrg1.de');
    result.items[1].payload.website.should.equal('http://TestOrg2.de');
    // validate overall status
    result.operation_status.code.should.equal(200);
    result.operation_status.message.should.equal('success');
    // validate payload status messages
    result.items[0].status.id.should.equal('contact_point_1');
    result.items[0].status.code.should.equal(200);
    result.items[0].status.message.should.equal('success');
    result.items[1].status.id.should.equal('contact_point_2');
    result.items[1].status.code.should.equal(200);
    result.items[1].status.message.should.equal('success');
  });

  it('should create organization resource and verify data and status response', async function createOrganizations() {
    const result = await organizationService.create({ items: listOfOrganizations });
    baseValidation(result);
    result.items.should.be.length(2);
    result.items[0].payload.name.should.equal('TestOrg1');
    result.items[1].payload.name.should.equal('TestOrg2');
    // validate overall status
    result.operation_status.code.should.equal(200);
    result.operation_status.message.should.equal('success');
    // validate payload status messages
    result.items[0].status.code.should.equal(200);
    result.items[0].status.message.should.equal('success');
    result.items[1].status.code.should.equal(200);
    result.items[1].status.message.should.equal('success');
  });

  it('should read organization resource', async function readOrganization() {
    const result = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'name',
        order: Sort_SortOrder.ASCENDING
      }]
    }), {});
    baseValidation(result);
    result.items.should.be.length(2);
    result.items[0].payload.name.should.equal('TestOrg1');
    result.items[1].payload.name.should.equal('TestOrg2');
    should.exist(result.operation_status);
    // validate overall status
    result.operation_status.code.should.equal(200);
    result.operation_status.message.should.equal('success');
  });

  it('should update organization resource and validate status', async function updateOrganization() {
    const result = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'name',
        order: Sort_SortOrder.DESCENDING, // ASCENDING
      }]
    }), {});
    baseValidation(result);
    result.items.should.be.length(2);
    const changedOrgList = [{
      id: result.items[0].payload.id,
      name: 'TestOrg3',
      meta
    },
    {
      id: result.items[1].payload.id,
      name: 'TestOrg4',
      meta
    }];
    const update = await organizationService.update({ items: changedOrgList });
    baseValidation(update);
    result.items.should.be.length(2);
    const updatedReadResult = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'name',
        order: Sort_SortOrder.ASCENDING, // ASCENDING
      }]
    }), {});
    baseValidation(updatedReadResult);
    result.items.should.be.length(2);
    updatedReadResult.items[0].payload.name.should.equal('TestOrg3');
    updatedReadResult.items[1].payload.name.should.equal('TestOrg4');
    should.exist(updatedReadResult.operation_status);
    updatedReadResult.operation_status.code.should.equal(200);
    updatedReadResult.operation_status.message.should.equal('success');
  });

  it('should upsert organization resource and validate status', async function upsertOrganization() {
    const result = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'name',
        order: Sort_SortOrder.ASCENDING, // ASCENDING
      }]
    }), {});
    baseValidation(result);
    result.items.should.be.length(2);
    const updatedOrgList = [{
      id: result.items[0].payload.id,
      name: 'TestOrg5',
      meta
    },
    // New organization created
    {
      name: 'TestOrg6',
      address_id: '789',
      meta
    }];
    const update = await organizationService.upsert({ items: updatedOrgList });
    baseValidation(update);
    // overall status
    should.exist(update.operation_status);
    update.operation_status.code.should.equal(200);
    update.operation_status.message.should.equal('success');
    update.items.should.be.length(2);
    update.items[0].status.code.should.equal(200);
    update.items[0].status.message.should.equal('success');
    update.items[1].status.code.should.equal(200);
    update.items[1].status.message.should.equal('success');
    const updatedResult = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'modified',
        order: Sort_SortOrder.ASCENDING, // ASCENDING
      },
      {
        field: 'name',
        order: Sort_SortOrder.ASCENDING
      }
      ]
    }));
    baseValidation(updatedResult);
    updatedResult.items.should.be.length(3);
    updatedResult.items[0].payload.name.should.equal('TestOrg4');
    updatedResult.items[1].payload.name.should.equal('TestOrg5');
    updatedResult.items[2].payload.name.should.equal('TestOrg6');
  });

  // edge from org to cp resource is also delted when org is deleted
  it('should delete organization resource and verify status', async function deleteOrganization() {
    const result = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'created',
        order: Sort_SortOrder.ASCENDING // ASCENDING
      }]
    }), {});
    baseValidation(result);
    const deleteIDs = {
      ids:
        [result.items[0].payload.id,
        result.items[1].payload.id,
        result.items[2].payload.id]
    };
    const deletedResult = await organizationService.delete(deleteIDs);
    should.exist(deletedResult);
    should.exist(deletedResult.status);
    deletedResult.status[0].message.should.equal('success');
    deletedResult.status[1].message.should.equal('success');
    deletedResult.status[2].message.should.equal('success');
    should.exist(deletedResult.operation_status);
    deletedResult.operation_status.code.should.equal(200);
    deletedResult.operation_status.message.should.equal('success');


    const resultAfterDeletion = await organizationService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'created',
        order: Sort_SortOrder.ASCENDING, // ASCENDING
      }]
    }), {});
    baseValidation(resultAfterDeletion, false);
    should.not.exist(resultAfterDeletion.items);
  });

  // // test case to re-read the data from that offset and test insert, update
  // // and delete for organization
  // it('should re read messages for organization resource', async function reReeadContactPointMsgs() {
  //   this.timeout(5000);

  //   const restoreListener = async function (msg: any,
  //     context: any, config: any, eventName: string): Promise<any> {
  //   };

  //   // subscribe to command topic events
  //   // this is needed to update offset (in kafka-client for $wait)
  //   // for commandTopic (since we listen for restoreResponse event)
  //   await commandTopic.on('restoreResponse', restoreListener);

  //   const commnadTopicOffset = await commandTopic.$offset(-1);
  //   const currentOrgOffset = await organizationTopic.$offset(-1);
  //   // Total 9 messages are emitted for organizations
  //   // organizationCreated -2, organizationModified - 2, organziationDeleted - 3
  //   const cmdPayload = encodeMsg({
  //     data: [
  //       {
  //         entity: 'organization',
  //         base_offset: currentOrgOffset - 9,
  //         ignore_offset: []
  //       }
  //     ]
  //   });
  //   const resp = await commandService.command({
  //     name: 'restore',
  //     payload: cmdPayload
  //   });
  //   should.not.exist(resp.error);
  //   await commandTopic.$wait(commnadTopicOffset);
  // });

  it('should read contact point resource using filter', async function readContactPoint() {
    const readResult = await contactPointsService.read(ReadRequest.fromPartial({
      filters: [{
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value: 'contact_point_1'
        }]
      }]
    }), {});
    should.exist(readResult);
    should.exist(readResult.items[0]);
    readResult.items[0].payload.id.should.equal('contact_point_1');
  });

  it('should not return data using filter for invalid id', async function readContactPoint() {
    const readResult = await contactPointsService.read(ReadRequest.fromPartial({
      filters: [{
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value: 'invalid_id'
        }]
      }]
    }), {});
    should.exist(readResult);
    should.not.exist(readResult.items);
  });

  // delete contact_point resource
  it('should delete contact point resource all', async function deleteContactPoint() {
    const deletedResult = await contactPointsService.delete({ collection: true });
    should.exist(deletedResult);
    // overall_status
    should.exist(deletedResult.operation_status);
    deletedResult.operation_status.code.should.equal(200);
    deletedResult.operation_status.message.should.equal('success');

    const resultAfterDeletion = await contactPointsService.read(ReadRequest.fromPartial({
      sorts: [{
        field: 'created',
        order: Sort_SortOrder.ASCENDING // ASCENDING
      }]
    }), {});
    baseValidation(resultAfterDeletion, false);
    should.not.exist(resultAfterDeletion.items);
  });
});
