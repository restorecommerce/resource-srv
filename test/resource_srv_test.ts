import * as srvConfig from '@restorecommerce/service-config';
import * as grpcClient from '@restorecommerce/grpc-client';
import { Worker } from './../service';
import * as Logger from '@restorecommerce/logger';
import * as should from 'should';

const cfg = srvConfig(process.cwd() + '/test');
const logger = new Logger(cfg.get('logger'));

/**
 * Note: To run below tests a running Kafka and ArangoDB instance is required.
 * Kafka can be disabled if the config 'enableEvents' is set to false.
 */

const listOfOrganizations = [
  {
    name: 'TestOrg1',
    creator: 'Admin1',
    address: {
      postcode: '123',
      locality: 'testLocality1',
      street: 'testStreet1',
      country: 'TestCountry1'
    }
  },
  {
    name: 'TestOrg2',
    creator: 'Admin2',
    address: {
      postcode: '456',
      locality: 'testLocality2',
      street: 'testStreet2',
      country: 'TestCountry2'
    }
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

    console.log('Resource cfg', protosPrefix);
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

  it('should create organization resource', async function registerUser() {
    const result = await resourceService.create({ items: listOfOrganizations });
    result.data.items[0].name.should.equal('TestOrg1');
    result.data.items[1].name.should.equal('TestOrg2');
  });

  it('should read organization resource', async function registerUser() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    should.exist(result.data.items);
    result.data.items[0].name.should.equal('TestOrg1');
    result.data.items[1].name.should.equal('TestOrg2');
  });

  it('should update organization resource', async function registerUser() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    const changedOrgList = [{
      id: result.data.items[0].id,
      name: 'TestOrg3'
    },
    {
      id: result.data.items[1].id,
      name: 'TestOrg4'
    }];
    const update = await resourceService.update({ items: changedOrgList });
    const updatedResult = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    updatedResult.data.items[0].name.should.equal('TestOrg3');
    updatedResult.data.items[1].name.should.equal('TestOrg4');
  });

  it('should upsert organization resource', async function registerUser() {
    const result = await resourceService.read({
      sort: [{
        field: 'name',
        order: 1, // ASCENDING
      }]
    });
    const updatedOrgList = [{
      id: result.data.items[0].id,
      name: 'TestOrg5'
    },
    // New organization created
    {
      name: 'TestOrg6',
      creator: 'Admin6',
      address: {
        postcode: '789',
        locality: 'testLocality6',
        street: 'testStreet6',
        country: 'TestCountry6'
      }
    }];
    const update = await resourceService.upsert({ items: updatedOrgList });
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
    Object.keys(updatedResult.data.items).length.should.equal(3);
    updatedResult.data.items[0].name.should.equal('TestOrg4');
    updatedResult.data.items[1].name.should.equal('TestOrg5');
    updatedResult.data.items[2].name.should.equal('TestOrg6');
  });

  it('should delete organization resource', async function registerUser() {
    const result = await resourceService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }]
    });
    const deleteIDs = {
      ids:
        [result.data.items[0].id,
        result.data.items[1].id,
        result.data.items[2].id]
    };
    const deletedResult = await resourceService.delete(deleteIDs);
    const resultAfterDeletion = await resourceService.read({
      sort: [{
        field: 'created',
        order: 1, // ASCENDING
      }]
    });
    Object.keys(resultAfterDeletion.data.items).length.should.equal(0);
  });
});
