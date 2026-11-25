import { isNullish, omitBy, isDeepEqual } from 'remeda';
import { RedisClientType } from 'redis';
import {
  CommandInterface, Server, GraphDatabaseProvider
} from '@restorecommerce/chassis-srv';
import { Events } from '@restorecommerce/kafka-client';
import { Logger } from '@restorecommerce/logger';
import { ServiceConfig } from '@restorecommerce/service-config';

export class ResourceCommandInterface extends CommandInterface {
  edgeCfg: any;
  // graphName: any;
  constructor(
    server: Server,
    cfg: ServiceConfig,
    readonly logger: Logger,
    events: Events,
    redisClient: RedisClientType<any, any>
  ) {
    super(server, cfg, logger, events, redisClient as any);
    const graphCfg = cfg.get('graph');
    if (graphCfg && graphCfg.vertices) {
      this.edgeCfg = graphCfg.vertices;
      // this.graphName = cfg.graph.graphName;
    }
  }

  override makeResourcesRestoreSetup(db: GraphDatabaseProvider, resource: string, collectionName?: string): any {
    const decodeBufferField = this.decodeBufferField;
    const edgeCfg = this.edgeCfg;
    collectionName ??= `${resource}s`;
    return {
      [`${resource}Created`]: async function restoreCreated(
        message: any,
        context: any,
        config: any,
        eventName: string
      ): Promise<any> {
        decodeBufferField(message, resource);
        if (edgeCfg[collectionName]) {
          const result = await db.findByID(collectionName, message.id);
          if (result?.length > 0) {
            return {};
          }
          await db.createVertex(collectionName, message);
          // Based on graphCfg create the necessary edges
          for (const eachEdgeCfg of edgeCfg[collectionName]) {
            const fromIDkey = eachEdgeCfg?.from;
            const from_id = message[fromIDkey];
            const toIDkey = eachEdgeCfg?.to;
            const to_id = message[toIDkey];
            const fromVerticeName = collectionName;
            const toVerticeName = eachEdgeCfg?.toVerticeName;
            if (fromVerticeName && toVerticeName) {
              await db.addEdgeDefinition(eachEdgeCfg.edgeName, [fromVerticeName],
                [toVerticeName]);
            }
            if (from_id && to_id) {
              if (Array.isArray(to_id)) {
                for (const toID of to_id) {
                  await db.createEdge(eachEdgeCfg.edgeName, undefined as any,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                }
                continue;
              }
              await db.createEdge(eachEdgeCfg.edgeName, undefined as any,
                `${fromVerticeName}/${from_id}`, `${toVerticeName}/${to_id}`);
            }
          }
        } else {
          await db.insert(collectionName, message);
        }
        return {};
      },
      [`${resource}Modified`]: async function restoreModified(
        message: any,
        context: any,
        config: any,
        eventName: string
      ): Promise<any> {
        decodeBufferField(message, resource);
        // Based on graphcfg update necessary edges
        if (edgeCfg[collectionName]) {
          const foundDocs = await db.find(collectionName, { id: message.id });
          const dbDoc = foundDocs[0];
          for (const eachEdgeCfg of edgeCfg[collectionName]) {
            const toIDkey = eachEdgeCfg?.to;
            const modified_to_idValues: string | string[] = message[toIDkey];
            const db_to_idValues: string | string[] = dbDoc[toIDkey];
            if (Array.isArray(modified_to_idValues)) {
              modified_to_idValues.sort();
            }
            if (Array.isArray(db_to_idValues)) {
              db_to_idValues.sort();
            }
            // delete and recreate only if there is a difference in references
            if (!isDeepEqual(modified_to_idValues, db_to_idValues)) {
              const fromIDkey = eachEdgeCfg?.from;
              const from_id = message[fromIDkey];
              const fromVerticeName = collectionName;
              const toVerticeName = eachEdgeCfg?.toVerticeName;

              const edgeCollectionName = eachEdgeCfg?.edgeName;
              const outgoingEdges: any = await db.getOutEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              for (const outgoingEdge of outgoingEdges) {
                const removedEdge = await db.removeEdge(edgeCollectionName, outgoingEdge._id);
                this.logger?.silly('Edge deleted:', removedEdge);
              }
              // Create new edges
              if (from_id && modified_to_idValues) {
                if (Array.isArray(modified_to_idValues)) {
                  for (const toID of modified_to_idValues) {
                    await db.createEdge(eachEdgeCfg?.edgeName, undefined as any,
                      `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                  }
                  continue;
                }
                await db.createEdge(edgeCollectionName, undefined as any,
                  `${fromVerticeName}/${from_id}`, `${toVerticeName}/${modified_to_idValues}`);
              }
            }
          }
        }
        message = omitBy(message, isNullish);
        await db.update(collectionName, message);
        return {};
      },
      [`${resource}Deleted`]: async function restoreDeleted(
        message: any,
        context: any,
        config: any,
        eventName: string
      ): Promise<any> {
        if (edgeCfg[collectionName]) {
          // Modify the Ids to include documentHandle
          await db.removeVertex(collectionName, `${collectionName}/${message.id}`);
        } else {
          await db.delete(collectionName, [message.id]);
        }
        return {};
      }
    };
  }
}
