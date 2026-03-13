import "colors";
import mongoose from "mongoose";

/**
 * Drop a collection if it has 0 documents to reclaim fragmented storage.
 * MongoDB does not release disk space after deletes — dropping + recreating
 * (auto-handled by Mongoose schemas on next access) is the only way on M0 free tier.
 *
 * Fails silently — a reclaim failure should never break the calling operation.
 */
async function reclaimCollectionStorage(collectionName: string): Promise<void> {
    try {
        const db: mongoose.mongo.Db | undefined = mongoose.connection.db;
        if (!db) return;

        const count: number = await db.collection(collectionName).countDocuments();
        if (count > 0) return;

        await db.dropCollection(collectionName);
        console.log(`Storage: Dropped empty '${collectionName}' collection to reclaim fragmented space`.green);
    } catch (error: unknown) {
        // NamespaceNotFound (collection already gone) — safe to ignore
        const code: number | undefined = (error as any)?.code;
        if (code === 26) return;

        console.error(`Storage: Failed to reclaim '${collectionName}'`.red, error);
    }
}

export {reclaimCollectionStorage};
