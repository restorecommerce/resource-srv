# resource-srv
<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fresource%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/resource-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/resource-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/resource-srv?branch=master)

[version]: http://img.shields.io/npm/v/resource-srv.svg?style=flat-square
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

See [tests](/test/).

## Usage

### Development

- Install dependencies

```sh
npm install
```

- Build application

```sh
# compile the code
npm run build
```

- Run application and restart it on changes in the code

```sh
# Start resource-srv in dev mode
npm run dev
```

### Production

```sh
# compile the code
npm run build

# run compiled server
npm start
```