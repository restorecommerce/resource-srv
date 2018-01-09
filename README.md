# resource-srv
<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fresource%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/resource-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/resource-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/resource-srv?branch=master)

[version]: http://img.shields.io/npm/v/resource-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/resource-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/resource-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/resource-srv/master.svg?style=flat-square

This microservice exposes CRUD operations through a [gRPC](https://grpc.io/docs/) endpoint for each specified resource. Such resources are persisted in an ArangoDB database instance, each of them binded with its own separate collection.
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

For detailed fields of protubf messages `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/).

## Kafka Events

A [Kafka](https://kafka.apache.org/) topic is created for each resource that is specified in the configuration file.
CRUD operations are posted as event messages to the resource's respective topic, using [kafka-client](https://github.com/restorecommerce/kafka-client).
For more details of the event and topic names please refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface).

This microservice subscribes to the following Kafka events by topic:
- io.restorecommerce.command
  - restoreCommand
  - healthCheckCommand
  - resetCommand

List of events emitted to Kafka by this microservice for below topics:
- io.restorecommerce.command
  - healthCheckResponse
  - resetResponse

## Chassis Service

This service uses chassis-srv, a base module for restorecommerce microservices, in order to provide the following functionalities:

- exposure of all previously mentioned gRPC endpoints
- implementation of a command-interface which provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the io.restorecommerce.command topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)

## Redis

[Redis](https://redis.io/) can optionally be integrated with this microservice to automatically generate specific fields in each resource.
Such autogeneration feature currently includes timestamps and sequential counters. The latter one is particularly useful for fields like customer or item numbers, which can have a type of sequential logic and can be read and written efficiently with Redis.
These operations can be enabled by simply specifying the fields and their "strategies" in the configuration files.

## Usage

See [tests](/test/).
