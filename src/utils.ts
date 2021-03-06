import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { ResourceService } from './service';

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface Response {
  payload: any;
  count: number;
  status?: {
    code: number;
    message: string;
  };
}

export interface AccessResponse {
  decision: Decision;
  response?: Response;
}

export interface FilterType {
  field?: string;
  operation?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'in' | 'isEmpty' | 'iLike';
  value?: string;
  type?: 'string' | 'boolean' | 'number' | 'date' | 'array';
}

export interface ReadPolicyResponse extends AccessResponse {
  policySet?: PolicySetRQ;
  filter?: FilterType[];
  custom_query_args?: {
    custom_queries: any;
    custom_arguments: any;
  };
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
export async function checkAccessRequest(subject: Subject, resources: any, action: AuthZAction,
  entity: string, service: ResourceService, resourceNameSpace?: string): Promise<AccessResponse | ReadPolicyResponse> {
  let authZ = service.authZ;
  let data = _.cloneDeep(resources);
  if (!_.isArray(resources) && action != AuthZAction.READ) {
    data = [resources];
  } else if (action === AuthZAction.READ) {
    data.args = resources;
    data.entity = entity;
  }

  let result: Decision | PolicySetRQ;
  try {
    result = await accessRequest(subject, data, action, authZ, entity, resourceNameSpace);
  } catch (err) {
    return {
      decision: Decision.DENY,
      response: {
        payload: undefined,
        count: 0,
        status: {
          code: err.code || 500,
          message: err.details || err.message,
        }
      }
    };
  }
  if (typeof result === 'string') {
    return {
      decision: result
    };
  }
  let custom_queries = data.args.custom_queries;
  let custom_arguments = data.args.custom_arguments;
  return {
    decision: Decision.PERMIT,
    policySet: result,
    filter: data.args.filter,
    custom_query_args: { custom_queries, custom_arguments }
  };
}

export const getSubjectFromRedis = async (call: any, service: ResourceService) => {
  let subject = call.request.subject;
  if (!subject) {
    subject = {};
  }
  let api_key = call.request.api_key;
  if (subject && subject.id && _.isEmpty(subject.hierarchical_scopes)) {
    let redisKey = `cache:${subject.id}:subject`;
    // update ctx with HR scope from redis
    subject = await new Promise((resolve, reject) => {
      service.redisClient.get(redisKey, async (err, response) => {
        if (!err && response) {
          // update user HR scope and role_associations from redis
          const redisResp = JSON.parse(response);
          subject.role_associations = redisResp.role_associations;
          subject.hierarchical_scopes = redisResp.hierarchical_scopes;
          resolve(subject);
        }
        // when not set in redis
        if (err || (!err && !response)) {
          resolve(subject);
          return subject;
        }
      });
    });
  } else if (api_key) {
    subject = { api_key };
  }
  return subject;
};