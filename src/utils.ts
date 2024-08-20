import {
  AuthZAction,
  accessRequest,
  DecisionResponse,
  Operation,
  PolicySetRQResponse,
  ResolvedSubject,
  HierarchicalScope,
  ACSClientOptions,
  ACSClientContext,
  type Resource,
} from '@restorecommerce/acs-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import {
  UserServiceClient as UserClient,
  UserResponse,
  UserServiceDefinition as UserServiceDefinition
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user.js';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { createLogger } from '@restorecommerce/logger';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import {
  Subject,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import {
  FilterOp
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import {
  GraphServiceClient as GraphClient,
  GraphServiceDefinition,
  Options_Direction as Direction,
  TraversalRequest
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph.js';
export { Resource as ACSResource };

// Create a ids client instance
let idsClientInstance: UserClient;
const cfg = createServiceConfig(process.cwd());
export const getUserServiceClient = () => {
  if (!idsClientInstance) {
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
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

/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function resolveSubject(subject: Subject) {
  if (subject) {
    const idsClient = getUserServiceClient();
    const resp = await idsClient?.findByToken({ token: subject.token });
    if (resp?.payload?.id) {
      subject.id = resp.payload.id;
    }
  }
  return subject;
}

export async function checkAccessRequest(
  ctx: ACSClientContext,
  resource: Resource[],
  action: AuthZAction,
  operation: Operation.isAllowed,
  useCache?: boolean
): Promise<DecisionResponse>;

export async function checkAccessRequest(
  ctx: ACSClientContext,
  resource: Resource[],
  action: AuthZAction,
  operation: Operation.whatIsAllowed,
  useCache?: boolean
): Promise<PolicySetRQResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
export async function checkAccessRequest(
  ctx: ACSClientContext,
  resource: Resource[],
  action: AuthZAction,
  operation: Operation,
): Promise<DecisionResponse | PolicySetRQResponse> {
  try {
    const subject = ctx.subject as Subject;
    if (!subject?.id && subject?.token) {
      await resolveSubject(subject);
    }
    return await accessRequest(
      subject,
      resource,
      action,
      ctx,
      {
        operation,
        roleScopingEntityURN: cfg?.get('authorization:urns:roleScopingEntityURN')
      } as ACSClientOptions
    );
  } catch (err: any) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code ?? 500,
        message: err.details ?? err.message ?? 'Unknown Error!',
      }
    };
  }

}

/**
 * accessResponse returned from `acs-client` contains the filters for the list of
 * resources requested and it returns resource filter map, below api
 * returns applicable `Filters[]` for the specified resource, it iterates through
 * the ACS response and returns the applicable `Filters[]` for the resource.
 * @param accessResponse ACS response
 * @param enitity enitity name
 */
export const getACSFilters = (
  accessResponse: PolicySetRQResponse,
  resource: string
): FilterOp[] => accessResponse?.filters?.find(
  (e) => e?.resource === resource
    && e?.filters[0]?.filters?.length
)?.filters ?? [];

const setNestedChildOrgs = (hrScope: any, targetOrgID: string, subOrgs: any[]) => {
  if (!hrScope) {
    return;
  }

  if (!Array.isArray(hrScope)) {
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
        return;
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
  const traversalResponse: any = [];
  const hierarchicalResources = cfg.get('authorization:hierarchicalResources') ?? [];
  for (let hierarchicalResource of hierarchicalResources) {
    const { collection, edge } = hierarchicalResource;
    // search in inbound - org has parent org
    const traversalRequest: TraversalRequest = {
      vertices: { collection_name: collection, start_vertex_ids: [orgID] },
      opts: {
        direction: Direction.INBOUND,
        include_edges: [edge]
      }
    };
    const result = graphClient.traversal(traversalRequest);
    for await (const partResp of result) {
      if ((partResp?.data?.value)) {
        traversalResponse.push(...JSON.parse(partResp.data.value.toString()));
      }
    }
  }

  for (let item of traversalResponse) {
    const targetID = item.id;
    const subOrgs = traversalResponse.filter((e: any) => e.parent_id === targetID);

    // find hrScopes id and then get the childer object
    const filteredSubOrgFields = subOrgs.map(
      (org: any) => ({ id: org.id, role, children: new Array() })
    );

    if (filteredSubOrgFields.length === 0) {
      // set as root node
      hrScope.children.push({ id: targetID, role, children: new Array() });
    }
    else {
      // nest filtered orgs as tree forest
      setNestedChildOrgs(hrScope, targetID, filteredSubOrgFields);
    }
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
        for (const roleAttribute of roleObj?.attributes!) {
          if (roleAttribute.id === roleScopingEntityURN) {
            for (const roleScopInstObj of roleAttribute.attributes!) {
              if (roleScopInstObj.id === roleScopingInstanceURN) {
                const obj = { userScope: roleScopInstObj.value, role: roleObj.role };
                assignedUserScopes.add(obj);
              }
            }
          }
        }
      }
    }
    const hrScopes: HierarchicalScope[] = [];
    const userScopesRoleArray = Array.from(assignedUserScopes);
    for (let obj of userScopesRoleArray) {
      try {
        const hrScope = await getSubTreeOrgs(obj.userScope, obj.role, cfg, graphClient);
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
