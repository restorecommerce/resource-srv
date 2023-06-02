import {
  AuthZAction, accessRequest, DecisionResponse, Operation, PolicySetRQResponse
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { UserServiceClient as UserClient, UserServiceDefinition as UserServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';
import { FilterOp } from '@restorecommerce/rc-grpc-clients/dist/generated/io/restorecommerce/resource_base';

// Create a ids client instance
let idsClientInstance: UserClient;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, createChannel(grpcIDSConfig.address));
    }
  }
  return idsClientInstance;
};

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export interface Attribute {
  id: string;
  value: string;
  attributes: Attribute[];
}

export interface CtxResource {
  id: string;
  meta: {
    created?: number;
    modified?: number;
    modified_by?: string;
    owners: Attribute[]; // id and owner is mandatory in ctx resource other attributes are optional
  };
  [key: string]: any;
}

export interface GQLClientContext {
  // if subject is missing by default it will be treated as unauthenticated subject
  subject?: Subject;
  resources?: CtxResource[];
}

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation, useCache = true): Promise<DecisionResponse | PolicySetRQResponse> {
  let subject = ctx.subject;
  let dbSubject;
  // resolve subject id using findByToken api and update subject with id
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject && dbSubject.payload && dbSubject.payload.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, operation, 'arangoDB', useCache);
  } catch (err) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

/**
 * accessResponse returned from `acs-client` contains the filters for the list of
 * resources requested and it returns resource filter map, below api
 * returns applicable `Filters[]` for the specified resource, it iterates through
 * the ACS response and returns the applicable `Filters[]` for the resource.
 * @param accessResponse ACS response
 * @param enitity enitity name
 */
export const getACSFilters = (accessResponse: PolicySetRQResponse, resource: string): FilterOp[] => {
  let acsFilters = [];
  const resourceFilterMap = accessResponse?.filters;
  const resourceFilter = resourceFilterMap?.filter((e) => e?.resource === resource);
  // for a given entity there should be one filter map
  if (resourceFilter && resourceFilter.length === 1 && resourceFilter[0].filters && resourceFilter[0].filters[0]?.filters.length > 0) {
    acsFilters = resourceFilter[0].filters;
  }
  return acsFilters;
};
