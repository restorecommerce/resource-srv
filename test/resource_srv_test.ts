import * as srvConfig from '@restorecommerce/service-config';
import * as grpcClient from '@restorecommerce/grpc-client';
import { Worker } from './../service';
import * as Logger from '@restorecommerce/logger';
import * as should from 'should';

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
    "value": "urn:restorecommerce:acs:model:user.User"
  },
  {
    "id": "urn:restorecommerce:acs:names:ownerInstance",
    "value": "Admin"
  }]
};
const listOfOrganizations = [
  {
    name: 'TestOrg1',
    address_id: '123',
    meta
  },
  {
    name: 'TestOrg2',
    address_id: '456',
    meta
  },
];

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

describe('resource-srv testing', () => {
  let options;
  let resourceService;
  let worker: Worker;
  let baseValidation = function(result: any) {
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
    let mapValue = serviceMapping.microservice.mapClients.get('organization');
    resourceService = serviceMapping.microservice.service[mapValue];
  });

  // stop the server
  after(async function stopServer() {
    await worker.stop();
  });

  it('should create organization resource', async function createOrganization() {
    const result = await resourceService.create({ items: listOfOrganizations });
    baseValidation(result);
    result.data.items.should.be.length(2);
    result.data.items[0].name.should.equal('TestOrg1');
    result.data.items[1].name.should.equal('TestOrg2');
  });

  it('should read organization resource', async function readOrganization() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(result);
    result.data.items.should.be.length(2);
    result.data.items[0].name.should.equal('TestOrg1');
    result.data.items[1].name.should.equal('TestOrg2');
  });

  it('should update organization resource', async function updateOrganization() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(result);
    result.data.items.should.be.length(2);
    const changedOrgList = [{
      id: result.data.items[0].id,
      name: 'TestOrg3',
      meta
    },
    {
      id: result.data.items[1].id,
      name: 'TestOrg4',
      meta
    }];
    const update = await resourceService.update({ items: changedOrgList });
    baseValidation(update);
    result.data.items.should.be.length(2);
    const updatedResult = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(updatedResult);
    result.data.items.should.be.length(2);
    updatedResult.data.items[0].name.should.equal('TestOrg3');
    updatedResult.data.items[1].name.should.equal('TestOrg4');
  });

  it('should upsert organization resource', async function upsertOrganization() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(result);
    result.data.items.should.be.length(2);
    const updatedOrgList = [{
      id: result.data.items[0].id,
      name: 'TestOrg5',
      meta
    },
    // New organization created
    {
      name: 'TestOrg6',
      address_id: '789',
      meta
    }];
    const update = await resourceService.upsert({ items: updatedOrgList });
    baseValidation(update);
    update.data.items.should.be.length(2);
    const updatedResult = await resourceService.read({
      sort: [{
        field: 'modified',
        order: 1, // ASCENDING
      },
      {
        field: 'name',
        order: 1
      }
    ]
    });
    baseValidation(updatedResult);
    updatedResult.data.items.should.be.length(3);
    updatedResult.data.items[0].name.should.equal('TestOrg4');
    updatedResult.data.items[1].name.should.equal('TestOrg5');
    updatedResult.data.items[2].name.should.equal('TestOrg6');
  });

  it('should delete organization resource', async function deleteOrganization() {
    const result = await resourceService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(result);
    const deleteIDs = {
      ids:
        [result.data.items[0].id,
        result.data.items[1].id,
        result.data.items[2].id]
    };
    const deletedResult = await resourceService.delete(deleteIDs);
    should.exist(deletedResult);
    should.not.exist(deletedResult.error);

    const resultAfterDeletion = await resourceService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }]
    });
    baseValidation(resultAfterDeletion);
    resultAfterDeletion.data.items.should.be.length(0);
  });
});
