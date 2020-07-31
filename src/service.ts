import * as _ from 'lodash';
import * as redis from 'redis';
import { ServiceBase } from '@restorecommerce/resource-base-interface';
import { ACSAuthZ, Subject } from '@restorecommerce/acs-client';
import { Decision, AuthZAction, PermissionDenied } from '@restorecommerce/acs-client';
import { AccessResponse, getSubjectFromRedis, checkAccessRequest, ReadPolicyResponse } from './utils';
import { toStruct } from '@restorecommerce/grpc-client';

export class ResourceService extends ServiceBase {
  authZ: ACSAuthZ;
  redisClient: redis.RedisClient;
  cfg: any;
  resourceName: string;
  constructor(resourceName, resourceEvents, cfg, logger, resourceAPI, isEventsEnabled, authZ) {
    super(resourceName, resourceEvents, logger, resourceAPI, isEventsEnabled);
    this.authZ = authZ;
    this.cfg = cfg;
    this.resourceName = resourceName;
  }

  async create(call, ctx) {
    let data = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    // update meta data for owner information
    await this.createMetadata(data, AuthZAction.CREATE, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, data, AuthZAction.CREATE,
        this.resourceName, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    return await super.create(call, ctx);
  }

  async read(call, ctx) {
    const readRequest = call.request;
    let subject = await getSubjectFromRedis(call, this);
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        this.resourceName, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    return await super.read({ request: readRequest });
  }

  async update(call, ctx) {
    const items = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    // update meta data for owner information
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, items, AuthZAction.MODIFY,
        this.resourceName, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    return await super.update(call, ctx);
  }

  async upsert(call, ctx) {
    const usersList = call.request.items;
    let subject = await getSubjectFromRedis(call, this);
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse;
    try {
      acsResponse = await checkAccessRequest(subject, usersList, AuthZAction.MODIFY,
        this.resourceName, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    return await super.upsert(call, ctx);
  }

  async delete(call, ctx) {
    let userIDs = call.request.ids;
    let resources = [];
    let subject = await getSubjectFromRedis(call, this);
    let action;
    if (userIDs) {
      action = AuthZAction.DELETE;
      if (_.isArray(userIDs)) {
        for (let id of userIDs) {
          resources.push({ id });
        }
      } else {
        resources = [{ id: userIDs }];
      }
      Object.assign(resources, { id: userIDs });
      await this.createMetadata(resources, action, subject);
    }
    if (call.request.collection) {
      action = AuthZAction.DROP;
      resources = [{ collection: call.request.collection }];
    }
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, action,
        this.resourceName, this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    return await super.delete(call, ctx);
  }

  /**
 * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
 * @param reaources list of resources
 * @param entity entity name
 * @param action resource action
 */
  async createMetadata(resources: any, action: string, subject?: Subject): Promise<any> {
    let orgOwnerAttributes = [];
    if (resources && !_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject && subject.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add user and subject scope as default owner
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
    }

    if (resources) {
      for (let resource of resources) {
        if (!resource.meta) {
          resource.meta = {};
        }
        if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
          let result = await super.read({
            request: {
              filter: toStruct({
                id: {
                  $eq: resource.id
                }
              })
            }
          });
          // update owner info
          if (result.items.length === 1) {
            let item = result.items[0];
            resource.meta.owner = item.meta.owner;
          } else if (result.items.length === 0 && !resource.meta.owner) {
            let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: resource.id
              });
            resource.meta.owner = ownerAttributes;
          }
        } else if (action === AuthZAction.CREATE && !resource.meta.owner) {
          let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          ownerAttributes.push(
            {
              id: urns.ownerIndicatoryEntity,
              value: urns.user
            },
            {
              id: urns.ownerInstance,
              value: resource.id
            });
          resource.meta.owner = ownerAttributes;
        }
      }
    }
    return resources;
  }

}