import {
  AuthZAction,
  accessRequest,
  DecisionResponse,
  Operation,
  PolicySetRQResponse,
  ResolvedSubject,
  HierarchicalScope
} from '@restorecommerce/acs-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import {
  UserServiceClient as UserClient,
  UserResponse,
  UserServiceDefinition as UserServiceDefinition
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { FilterOp } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  GraphServiceClient as GraphClient,
  GraphServiceDefinition,
  Options_Direction as Direction,
  TraversalRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph.js';

// Create a ids client instance
let idsClientInstance: UserClient;
export const getUserServiceClient = async () => {
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

// Create a graph client instance for traversal requests
let graphClientInstance: GraphClient;
export const getGraphServiceClient = async () => {
  if (!graphClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    const grpcGraphConfig = cfg.get('client:graph-srv');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    if (grpcGraphConfig) {
      graphClientInstance = createClient({
        ...grpcGraphConfig,
        logger
      }, GraphServiceDefinition, createChannel(grpcGraphConfig.address));
    }
  }
  return graphClientInstance;
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
    created?: Date;
    modified?: Date;
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

export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction, operation: Operation.isAllowed, useCache?: boolean): Promise<DecisionResponse>;
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction, operation: Operation.whatIsAllowed, useCache?: boolean): Promise<PolicySetRQResponse>;

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
  let subject = ctx.subject as Subject;
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
    result = await accessRequest(subject, resource, action, ctx, { operation });
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
  return accessResponse?.filters?.filter(
    (e) => !e.resource && e.resource === resource
  ).flatMap(
    e => e.filters
  ) ?? [];
};

const setNestedChildOrgs = (hrScope: any, targetOrgID, subOrgs) => {
  if (!hrScope?.length === undefined) {
    hrScope = [hrScope];
  }

  for (let subHrScope of hrScope) {
    if (subHrScope.id === targetOrgID) {
      if (subHrScope.children) {
        subHrScope.children.push(...subOrgs);
      }
      else {
        subHrScope.children = [...subOrgs];
      }
      return;
    }
    for (let item of subHrScope.children) {
      if (item.id === targetOrgID) {
        item.children.push(...subOrgs);
        return hrScope;
      } else {
        setNestedChildOrgs(item.children, targetOrgID, subOrgs);
      }
    }
  }
};

export const getSubTreeOrgs = async (
  orgID: string,
  role: string,
  cfg: any,
  graphClient: GraphClient,
): Promise<HierarchicalScope> => {
  const hrScope: HierarchicalScope = { role, id: orgID, children: [] };
  let subOrgTreeList = new Set<string>();
  let traversalResponse: any = [];
  const hierarchicalResources = cfg.get('authorization:hierarchicalResources') ?? [];
  const orgTechUser = cfg.get('techUser');
  for (let hierarchicalResource of hierarchicalResources) {
    const { collection, edge } = hierarchicalResource;
    // search in inbound - org has parent org
    const traversalRequest: TraversalRequest = {
      subject: orgTechUser,
      vertices: { collection_name: collection, start_vertex_ids: [orgID] },
      opts: {
        direction: Direction.INBOUND,
        include_edges: [edge]
      }
    };
    const result = await graphClient.traversal(traversalRequest);
    for await (const partResp of result) {
      if ((partResp && partResp.data && partResp.data.value)) {
        traversalResponse.push(...JSON.parse(partResp.data.value.toString()));
      }
    }

    for (let org of traversalResponse) {
      if (org?._id?.split('/')[0] === collection) {
        delete org._id;
        subOrgTreeList.add(org.id);
      }
    }
  }

  for (let i = 0; i < traversalResponse.length; i++) {
    let targetID = traversalResponse[i].id;
    const subOrgs = traversalResponse.filter((e: any) => e.parent_id === targetID);
    // find hrScopes id and then get the childer object
    const filteredSubOrgFields = [];
    for (let org of subOrgs) {
      filteredSubOrgFields.push({ id: org.id, role, children: [] });
    }
    // leaf node or no more children nodes
    if (filteredSubOrgFields.length === 0) {
      filteredSubOrgFields.push({ id: targetID, role, children: [] });
      targetID = traversalResponse[i].parent_id;
    }
    // set sub orgs on target org
    setNestedChildOrgs(hrScope, targetID, filteredSubOrgFields);
  }
  return hrScope;
};

export const createHRScope = async (
  user: UserResponse,
  token: string,
  graphClient: GraphClient,
  cache: any,
  cfg: any,
  logger: any,
): Promise<ResolvedSubject | undefined> => {
  const subject = user?.payload as ResolvedSubject;
  const roleScopingEntityURN = cfg.get('authorization:urns:roleScopingEntity');
  const roleScopingInstanceURN = cfg.get('authorization:urns:roleScopingInstance');
  if (subject?.role_associations && !subject?.hierarchical_scopes?.length) {
    // create HR scopes iterating through the user's assigned role scoping instances
    let userRoleAssocs = subject.role_associations;
    let assignedUserScopes = new Set<{ userScope: string | undefined; role: string | undefined }>();
    let tokenData;
    // verify the validity of subject tokens
    if (token && user?.payload?.tokens?.length! > 0) {
      for (let tokenInfo of user?.payload?.tokens ?? []) {
        if (tokenInfo.token === token) {
          tokenData = tokenInfo;
          const expiresIn = tokenInfo.expires_in;
          if (expiresIn && expiresIn != new Date(0) && expiresIn < new Date()) {
            logger.info(`Token name ${tokenInfo.name} has expired`);
            return undefined;
          }
        }
      }
    }

    const reducedUserRoleAssocs = tokenData?.scopes?.flatMap(
      (scope: string) => userRoleAssocs?.filter(
        attr => attr.id === scope
      )
    ) ?? userRoleAssocs;

    for (let roleObj of reducedUserRoleAssocs) {
      if (roleObj?.attributes?.length! > 0) {
        for (let roleAttribute of roleObj?.attributes!) {
          if (roleAttribute.id === roleScopingEntityURN) {
            for (let roleScopInstObj of roleAttribute.attributes!) {
              if (roleScopInstObj.id === roleScopingInstanceURN) {
                let obj = { userScope: roleScopInstObj.value, role: roleObj.role };
                assignedUserScopes.add(obj);
              }
            }
          }
        }
      }
    }
    let hrScopes: HierarchicalScope[] = [];
    let userScopesRoleArray = Array.from(assignedUserScopes);
    for (let obj of userScopesRoleArray) {
      try {
        let hrScope = await getSubTreeOrgs(obj.userScope, obj.role, cfg, graphClient);
        if (hrScope) {
          hrScopes.push(hrScope);
        }
      } catch (err) {
        logger.error('Error computing hierarchical scopes', err);
      }
    }
    subject.hierarchical_scopes = hrScopes;
  }
  return subject;
};