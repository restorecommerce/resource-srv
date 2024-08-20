import * as _ from 'lodash-es';
import { Logger } from 'winston';
import { ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';
import { DecisionResponse, Operation, PolicySetRQResponse, ResolvedSubject } from '@restorecommerce/acs-client';
import { AuthZAction } from '@restorecommerce/acs-client';
import { checkAccessRequest, getACSFilters, resolveSubject } from './utils.js';
import * as uuid from 'uuid';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import {
  ReadRequest,
  DeleteRequest,
  DeepPartial,
  DeleteResponse,
  Resource,
  ResourceListResponse,
  ResourceList
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { Filter_Operation, Filter_ValueType } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/filter.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';

export class ResourceService extends ServiceBase<ResourceListResponse, ResourceList> {
  private readonly urns: any;

  constructor(
    private readonly resourceName: string,
    resourceEvents: any,
    cfg: any,
    logger: Logger,
    resourceAPI: ResourcesAPIBase,
    isEventsEnabled: boolean,
  ) {
    super(resourceName, resourceEvents, logger, resourceAPI, isEventsEnabled);
    this.urns = cfg.get('authorization:urns');
  }

  async create(request: any, ctx: any) {
    try {
      const subject = await resolveSubject(request.subject);
      // update meta data for owners information
      request.items = await this.createMetadata(request.items, AuthZAction.CREATE, subject);
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = request.items;
      const acsResponse = await checkAccessRequest(
        ctx,
        [{ resource: this.resourceName, id: request.items.map((item: any) => item.id) }],
        AuthZAction.CREATE,
        Operation.isAllowed
      );
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return { operation_status: acsResponse.operation_status };
      }
      return await super.create(request, ctx);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }

  async read(request: ReadRequest, ctx: any): Promise<DeepPartial<any>> {
    try {
      const subject = await resolveSubject(request.subject);
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = [];
      const acsResponse = await checkAccessRequest(
        ctx,
        [{ resource: this.resourceName }],
        AuthZAction.READ,
        Operation.whatIsAllowed
      ) as PolicySetRQResponse;

      if (acsResponse.decision != Response_Decision.PERMIT) {
        return { operation_status: acsResponse.operation_status };
      }
      const acsFilters = getACSFilters(acsResponse, this.resourceName);
      if (request.filters) {
        request.filters.push(...acsFilters);
      }
      else {
        request.filters = acsFilters;
      }

      request.custom_queries = acsResponse.custom_query_args?.flatMap(arg => arg.custom_queries);
      request.custom_arguments = acsResponse.custom_query_args?.flatMap(arg => arg.custom_arguments)[0];
      return await super.read(request, ctx);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }

  async update(request: any, ctx: any) {
    try {
      const subject = await resolveSubject(request.subject);
      // update meta data for owner information
      const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = acsResources;
      const acsResponse = await checkAccessRequest(
        ctx,
        [{ resource: this.resourceName, id: acsResources.map((e: any) => e.id) }],
        AuthZAction.MODIFY,
        Operation.isAllowed
      );
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return { operation_status: acsResponse.operation_status };
      }
      return await super.update(request, ctx);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }

  async upsert(request: any, ctx: any) {
    try {
      const subject = await resolveSubject(request.subject);
      const acsResources = await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = acsResources;
      const acsResponse = await checkAccessRequest(
        ctx,
        [{ resource: this.resourceName, id: acsResources.map((e: any) => e.id) }],
        AuthZAction.MODIFY,
        Operation.isAllowed
      );
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return { operation_status: acsResponse.operation_status };
      }
      return await super.upsert(request, ctx);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
  }

  async delete(request: DeleteRequest, ctx: any): Promise<DeepPartial<DeleteResponse>> {
    try {
      const resourceIDs = request.ids;
      const resources = [];
      let acsResources = [];
      const subject = await resolveSubject(request.subject);
      let action;
      if (resourceIDs) {
        action = AuthZAction.DELETE;
        if (Array.isArray(resourceIDs)) {
          for (let id of resourceIDs) {
            resources.push({ id });
          }
        } else {
          resources.push([{ id: resourceIDs }]);
        }
        Object.assign(resources, { id: resourceIDs });
        acsResources = await this.createMetadata<any>(resources, action, subject as ResolvedSubject);
      }
      if (request.collection) {
        action = AuthZAction.DROP;
        acsResources = [{ collection: request.collection }];
      }
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = acsResources;
      const acsResponse = await checkAccessRequest(
        ctx,
        [{ resource: this.resourceName, id: acsResources.map((e: any) => e.id) }],
        action,
        Operation.isAllowed
      );
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return { operation_status: acsResponse.operation_status };
      }
      return await super.delete(request as any, ctx);
    } catch (err: any) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err?.code,
          message: err?.message
        }
      };
    }
  }

  /**
   * reads meta data from DB and updates owners information in resource if action is UPDATE / DELETE
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
   */
  async createMetadata<T extends Resource>(
    resources: T | T[],
    action: string,
    subject?: Subject
  ): Promise<T[]> {

    if (!Array.isArray(resources)) {
      resources = [resources];
    }

    const setDefaultMeta = (resource: T) => {
      if (!resource.id?.length) {
        resource.id = uuid.v4().replace(/-/g, '');
      }

      if (!resource.meta) {
        resource.meta = {};
        resource.meta.owners = [];

        if (subject?.scope) {
          resource.meta.owners.push(
            {
              id: this.urns.ownerIndicatoryEntity,
              value: this.urns.organization,
              attributes: [{
                id: this.urns.ownerInstance,
                value: subject.scope
              }]
            }
          );
        }

        if (subject?.id) {
          resource.meta.owners.push(
            {
              id: this.urns.ownerIndicatoryEntity,
              value: this.urns.user,
              attributes: [{
                id: this.urns.ownerInstance,
                value: subject.id
              }]
            }
          );
        }
      }
    };

    if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
      const ids = [
        ...new Set(
          resources.map(
            r => r.id
          ).filter(
            id => id
          )
        ).values()
      ];
      const filters = ReadRequest.fromPartial({
        filters: [
          {
            filters: [
              {
                field: 'id',
                operation: Filter_Operation.in,
                value: JSON.stringify(ids),
                type: Filter_ValueType.ARRAY
              }
            ]
          }
        ],
        limit: ids.length
      });

      const result_map = await super.read(filters, {}).then(
        resp => new Map(
          resp.items?.map(
            item => [item.payload?.id, item?.payload]
          )
        )
      );

      for (let resource of resources) {
        if (!resource.meta && result_map.has(resource?.id)) {
          resource.meta = result_map.get(resource?.id).meta;
        }
        else {
          setDefaultMeta(resource);
        }
      }
    }
    else if (action === AuthZAction.CREATE) {
      for (let resource of resources) {
        setDefaultMeta(resource);
      }
    }

    return resources;
  }
}
