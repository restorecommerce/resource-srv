# resource-srv
[![Build Status][build]](https://travis-ci.org/restorecommerce/resource-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/resource-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/resource-srv?branch=master)

[build]: http://img.shields.io/travis/restorecommerce/resource-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/resource-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/resource-srv/master.svg?style=flat-square

This microservice exposes CRUD operations through a [gRPC](https://grpc.io/docs/) endpoint for each specified resource. Such resources are persisted in an ArangoDB database instance, each of them binded with its own separate collection.
Its also exposes a graph traversal operation (further documented in [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/)).
The list of resource names should be specified in `resources` configuration in the [`config.json`](cfg/config.json) file, in order to create them in the database. Such names should have a matching [Protocol Buffers](https://developers.google.com/protocol-buffers/) file in the [protos](https://github.com/restorecommerce/protos) folder where all the fields of resources are defined.
CRUD operations are performed by using [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/).

## gRPC Interface

### CRUD Operations

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be created |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> |
| Update | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be updated |
| Upsert | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be created or updated |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest`   | `google.protobuf.Empty` | List of resource IDs to be deleted |

For detailed fields of protobuf messages `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/).

### Graph Operations

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Traversal | `io.restorecommerce.graph.TraversalRequest` | `io.restorecommerce.graph.TraversalResponse` | List of vertices and edges data traversed through the graph |

For detailed fields of protobuf messages `io.restorecommerce.graph.TraversalRequest` and `io.restorecommerce.graph.TraversalResponse` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/).

## Kafka Events

A [Kafka](https://kafka.apache.org/) topic is created for each resource that is specified in the configuration file.
CRUD operations are posted as event messages to the resource's respective topic, using [kafka-client](https://github.com/restorecommerce/kafka-client).
For more details of the event and topic names please refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface).

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - resetCommand
  - healthCheckCommand
  - versionCommand

List of events emitted to Kafka by this microservice for below topics:
- io.restorecommerce.command
  - restoreResponse
  - resetResponse
  - healthCheckResponse
  - versionResponse

## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:

- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the io.restorecommerce.command topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)
- stores the offset values for Kafka topics at regular intervals to [Redis](https://redis.io/).

## Development

### Tests

See [tests](test/). To execute the tests a set of _backing services_ are needed.
Refer to [System](https://github.com/restorecommerce/system) repository to start the backing-services before running the tests.

- To run tests

```sh
npm run test
```

## Running as Docker Container

This service depends on a set of _backing services_ that can be started using a
dedicated [docker compose definition](https://github.com/restorecommerce/system).

```sh
docker run \
 --name restorecommerce_resource_srv \
 --hostname resource-srv \
 --network=system_test \
 -e NODE_ENV=production \
 -p 50053:50053 \
 restorecommerce/resource-srv
```

## Running Locally

Install dependencies

```sh
npm install
```

Build service

```sh
# compile the code
npm run build
```

Start service

```sh
# run compiled service
npm start
```
