# resource-srv
<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fresource%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/resource-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/resource-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/resource-srv?branch=master)

[version]: http://img.shields.io/npm/v/resource-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/resource-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/resource-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/resource-srv/master.svg?style=flat-square

This microservice provides a generic database access abstraction. Resources are persisted in an ArangoDB database instance and a separate collection is created for each resource name.
The list of resource names should be specified in `resources` configuration in the [`config.json`](cfg/config.json) file, in order to create them in the database. Such names should have a matching [Protocol Buffers](https://developers.google.com/protocol-buffers/) file in the [protos](https://github.com/restorecommerce/protos) folder where all the fields of resources are defined.

## gRPC Interface

Generic CRUD operations are exposed via gRPC. Such operations are performed implementing [resource-base-interface](https://github.com/restorecommerce/resource-base-interface/).

### CRUD Operations

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be created |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> |
| Update | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be updated |
| Upsert | [ ]`io.restorecommerce.<resource>.<resourceName>` | [ ]`io.restorecommerce.<resource>.<resourceName>` | List of \<resourceName> to be created or updated |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest`   | `google.protobuf.Empty` | List of resource IDs to be deleted |

For detailed fields of protubf messages `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource_base.proto](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/resource_base.proto) file.

## Kafka Events

A [Kafka](https://kafka.apache.org/) topic is created for each resource that is specified in the configuration file.
CRUD operations are then posted as event messages in each call, using [kafka-client](https://github.com/restorecommerce/kafka-client) to respective topics.
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

## Shared Interface

This microservice implements a shared [command-interface](https://github.com/restorecommerce/command-interface-srv) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
For usage details please see [command-interface tests](https://github.com/restorecommerce/command-interface-srv/tree/master/test).

## Redis

[Redis](https://redis.io/) can optionally be integrated with this microservice to automatically generate specific fields in each resource.
Such autogeneration feature currently includes timestamps and sequential counters. The latter one is particularly useful for fields like customer or item numbers, which can have a type of sequential logic and can be read and written efficiently with Redis.
These operations can be enabled by simply specifying the fields and their "strategies" in the configuration files.

## Usage

See [tests](/test/).