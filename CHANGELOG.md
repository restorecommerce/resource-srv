## 0.1.6 (February 18th, 2022)

- updated chassis-srv (includes fix for offset store config)

## 0.1.5 (February 14th, 2022)

- up redis config

## 0.1.4 (February 14th, 2022)

- fix import and redis db config

## 0.1.3 (February 14th, 2022)

- up dependencies

## 0.1.2 (February 7th, 2022)

- up dependencies

## 0.1.1 (September 13th, 2021)

- up dependencies

## 0.1.0 (August 10th, 2021)

- latest grpc-client
- migraged kafka-client to kafkajs
- chassis-srv using the latest grpc-js and protobufdef loader
- filter changes (removed google.protobuf.struct completely and defined nested proto structure)
- added status object to each item and also overall operation_status.

## 0.0.12 (March 25th, 2021)

- switch to official grpc healthcheck proto

## 0.0.11 (March 25th, 2021)

- update resource-base-interface

## 0.0.10 (March 11th, 2021)

- update chassis, protos, node typings

## 0.0.9 (February 19th, 2021)

- update acs server address in production config

## 0.0.8 (December 11th, 2021)

- fix acs server address in production config

## 0.0.7 (December 2nd, 2020)

- fix docker image permissions

### 0.0.6 (December 1st, 2020)

- fix production redis auth cache address

### 0.0.5 (December 1st, 2020)

- fix startup script

### 0.0.4 (December 1st, 2020)

- update to NodeJS 12.18

### 0.0.3 (October 15th, 2020)

- updated chassis-srv

### 0.0.2 (October 14th, 2020)

- add new grpc healthcheck with readiness probe
- listen on 0.0.0.0 for grpc port
