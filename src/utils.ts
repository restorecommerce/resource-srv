import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject, DecisionResponse
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { ResourceService } from './service';

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface AccessResponse {
  decision: Decision;
  obligation?: string;
  operation_status: {
    code: number;
    message: string;
  };
}

export interface FilterType {
  field?: string;
  operation?: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'in' | 'isEmpty' | 'iLike';
  value?: string;
  type?: 'string' | 'boolean' | 'number' | 'date' | 'array';
}

export interface ReadPolicyResponse extends AccessResponse {
  policy_sets?: PolicySetRQ[];
  filters?: FilterType[];
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
  entity: string, service: ResourceService, resourceNameSpace?: string): Promise<DecisionResponse | ReadPolicyResponse> {
  let authZ = service.authZ;
  let data = _.cloneDeep(resources);
  if (!_.isArray(resources) && action != AuthZAction.READ) {
    data = [resources];
  } else if (action === AuthZAction.READ) {
    data.args = resources;
    data.entity = entity;
  }

  let result: DecisionResponse | ReadPolicyResponse;
  try {
    result = await accessRequest(subject, data, action, authZ, entity, resourceNameSpace);
  } catch (err) {
    return {
      decision: Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  if (result && (result as ReadPolicyResponse).policy_sets) {
    let custom_queries = data.args.custom_queries;
    let custom_arguments = data.args.custom_arguments;
    (result as ReadPolicyResponse).filters = data.args.filters;
    (result as ReadPolicyResponse).custom_query_args = { custom_queries, custom_arguments };
    return result as ReadPolicyResponse;
  } else {
    return result as DecisionResponse;
  }
}