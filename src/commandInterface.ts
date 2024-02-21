import * as _ from 'lodash-es';
import { RedisClientType } from 'redis';
import {
  CommandInterface, Server, GraphDatabaseProvider
} from '@restorecommerce/chassis-srv';
import { Events } from '@restorecommerce/kafka-client';

export class ResourceCommandInterface extends CommandInterface {
  edgeCfg: any;
  // graphName: any;
  constructor(server: Server, cfg: any, logger: any, events: Events, redisClient: RedisClientType<any, any>) {
    super(server, cfg, logger, events, redisClient);
    let graphCfg = cfg.get('graph');
    if (graphCfg && graphCfg.vertices) {
      this.edgeCfg = graphCfg.vertices;
      // this.graphName = cfg.graph.graphName;
    }
  }

  makeResourcesRestoreSetup(db: GraphDatabaseProvider, resource: string): any {
    const that = this;
    const collectionName = `${resource}s`;
    return {
      [`${resource}Created`]: async function restoreCreated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        that.decodeBufferField(message, resource);
        if (that.edgeCfg[collectionName]) {
          const result = await db.findByID(collectionName, message.id);
          if (result?.length > 0) {
            return {};
          }
          await db.createVertex(collectionName, message);
          // Based on graphCfg create the necessary edges
          for (let eachEdgeCfg of that.edgeCfg[collectionName]) {
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
              if (_.isArray(to_id)) {
                for (let toID of to_id) {
                  await db.createEdge(eachEdgeCfg.edgeName, null,
                    `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                }
                continue;
              }
              await db.createEdge(eachEdgeCfg.edgeName, null,
                `${fromVerticeName}/${from_id}`, `${toVerticeName}/${to_id}`);
            }
          }
        } else {
          await db.insert(collectionName, message);
        }
        return {};
      },
      [`${resource}Modified`]: async function restoreModified(message: any, context: any, config: any,
        eventName: string): Promise<any> {
        that.decodeBufferField(message, resource);
        // Based on graphcfg update necessary edges
        if (that.edgeCfg[collectionName]) {
          const foundDocs = await db.find(collectionName, { id: message.id });
          const dbDoc = foundDocs[0];
          for (let eachEdgeCfg of that.edgeCfg[collectionName]) {
            const toIDkey = eachEdgeCfg?.to;
            let modified_to_idValues = message[toIDkey];
            let db_to_idValues = dbDoc[toIDkey];
            if (_.isArray(modified_to_idValues)) {
              modified_to_idValues = _.sortBy(modified_to_idValues);
            }
            if (_.isArray(db_to_idValues)) {
              db_to_idValues = _.sortBy(db_to_idValues);
            }
            // delete and recreate only if there is a difference in references
            if (!_.isEqual(modified_to_idValues, db_to_idValues)) {
              const fromIDkey = eachEdgeCfg?.from;
              const from_id = message[fromIDkey];
              const fromVerticeName = collectionName;
              const toVerticeName = eachEdgeCfg?.toVerticeName;

              const edgeCollectionName = eachEdgeCfg?.edgeName;
              let outgoingEdges: any = await db.getOutEdges(edgeCollectionName, `${collectionName}/${dbDoc.id}`);
              for (let outgoingEdge of outgoingEdges) {
                const removedEdge = await db.removeEdge(edgeCollectionName, outgoingEdge._id);
              }
              // Create new edges
              if (from_id && modified_to_idValues) {
                if (_.isArray(modified_to_idValues)) {
                  for (let toID of modified_to_idValues) {
                    await db.createEdge(eachEdgeCfg?.edgeName, null,
                      `${fromVerticeName}/${from_id}`, `${toVerticeName}/${toID}`);
                  }
                  continue;
                }
                await db.createEdge(edgeCollectionName, null,
                  `${fromVerticeName}/${from_id}`, `${toVerticeName}/${modified_to_idValues}`);
              }
            }
          }
        }
        message = _.omitBy(message, _.isNil);
        await db.update(collectionName, message);
        return {};
      },
      [`${resource}Deleted`]: async function restoreDeleted(message: any, context: any, config: any,
        eventName: string): Promise<any> {
        if (that.edgeCfg[collectionName]) {
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