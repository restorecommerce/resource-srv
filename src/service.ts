import * as _ from 'lodash';
import { RedisClientType } from 'redis';
import { ServiceBase } from '@restorecommerce/resource-base-interface';
import { ACSAuthZ, DecisionResponse, Operation, PolicySetRQResponse, ResolvedSubject } from '@restorecommerce/acs-client';
import { AuthZAction } from '@restorecommerce/acs-client';
import { checkAccessRequest, getACSFilters } from './utils';
import * as uuid from 'uuid';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import { ReadRequest, DeleteRequest, DeepPartial, DeleteResponse } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';
import { Filter_Operation } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/filter';

export class ResourceService extends ServiceBase<any, any> {
  authZ: ACSAuthZ;
  redisClient: RedisClientType;
  cfg: any;
  resourceName: string;
  constructor(resourceName, resourceEvents, cfg, logger, resourceAPI, isEventsEnabled, authZ, redisClientSubject) {
    super(resourceName, resourceEvents, logger, resourceAPI, isEventsEnabled);
    this.authZ = authZ;
    this.cfg = cfg;
    this.resourceName = resourceName;
    this.redisClient = redisClientSubject;
  }

  async create(request, ctx) {
    let data = request.items;
    let subject = request.subject;
    // update meta data for owner information
    const acsResources = await this.createMetadata(data, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = acsResources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: this.resourceName, id: acsResources.map(item => item.id) }], AuthZAction.CREATE,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    return await super.create(request, ctx);
  }

  async read(request: ReadRequest, ctx: any): Promise<DeepPartial<any>> {
    const readRequest = ReadRequest.fromPartial({
      offset: request.offset, limit: request.limit,
      sort: request.sort, filters: request.filters, field: request.field, locales_limiter: request.locales_limiter,
      custom_arguments: request.custom_arguments, custom_queries: request.custom_queries, search: request.search
    });
    let subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = [];
      acsResponse = await checkAccessRequest(ctx, [{ resource: this.resourceName }], AuthZAction.READ,
        Operation.whatIsAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    const acsFilters = getACSFilters(acsResponse, this.resourceName);
    if (acsResponse && acsResponse.filters && acsFilters) {
      if (!readRequest.filters) {
        readRequest.filters = [];
      }
      readRequest.filters.push(...acsFilters);
    }

    if (acsResponse?.custom_query_args && acsResponse.custom_query_args.length > 0) {
      readRequest.custom_queries = acsResponse.custom_query_args[0].custom_queries;
      readRequest.custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
    }
    return await super.read(ReadRequest.fromPartial(readRequest), ctx);
  }

  async update(request, ctx) {
    let subject = request.subject;
    // update meta data for owner information
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = acsResources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: this.resourceName, id: acsResources.map(e => e.id) }], AuthZAction.MODIFY,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    return await super.update(request, ctx);
  }

  async upsert(request, ctx) {
    let subject = request.subject;
    const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = acsResources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: this.resourceName, id: acsResources.map(e => e.id) }], AuthZAction.MODIFY,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    return await super.upsert(request, ctx);
  }

  async delete(request: DeleteRequest, ctx): Promise<DeepPartial<DeleteResponse>> {
    let resourceIDs = request.ids;
    let resources = [];
    let acsResources = [];
    let subject = request.subject;
    let action;
    if (resourceIDs) {
      action = AuthZAction.DELETE;
      if (_.isArray(resourceIDs)) {
        for (let id of resourceIDs) {
          resources.push({ id });
        }
      } else {
        resources = [{ id: resourceIDs }];
      }
      Object.assign(resources, { id: resourceIDs });
      acsResources = await this.createMetadata(resources, action, subject as ResolvedSubject);
    }
    if (request.collection) {
      action = AuthZAction.DROP;
      acsResources = [{ collection: request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = acsResources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: this.resourceName, id: acsResources.map(e => e.id) }], action,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    return await super.delete(request, ctx);
  }

  /**
 * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
 * @param reaources list of resources
 * @param entity entity name
 * @param action resource action
 */
  async createMetadata(resources: any, action: string, subject?: ResolvedSubject): Promise<any> {
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
          let result = await super.read(ReadRequest.fromPartial({
            filters: [{
              filter: [{
                field: 'id',
                operation: Filter_Operation.eq,
                value: resource.id
              }]
            }]
          }), {});
          // update owner info
          if (result.items.length === 1) {
            let item = result.items[0].payload;
            resource.meta.owner = item.meta.owner;
          } else if (result.items.length === 0) {
            if (_.isEmpty(resource.id)) {
              resource.id = uuid.v4().replace(/-/g, '');
            }
            let ownerAttributes;
            if (!resource.meta.owner) {
              ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            } else {
              ownerAttributes = resource.meta.owner;
            }
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
        } else if (action === AuthZAction.CREATE) {
          if (_.isEmpty(resource.id)) {
            resource.id = uuid.v4().replace(/-/g, '');
          }
          let ownerAttributes;
          if (!resource.meta.owner) {
            ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          } else {
            ownerAttributes = resource.meta.owner;
          }
          if (subject?.id) {
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: subject?.id
              });
          }
          resource.meta.owner = ownerAttributes;
        }
      }
    }
    return resources;
  }

}