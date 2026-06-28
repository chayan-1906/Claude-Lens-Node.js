import "colors";
import mongoose from "mongoose";
import {getLocalConfig} from "../utils/localConfig";
import {ILocalConfig, IMongoConfiguration} from "../types/setup";

/** Cached MongoDB connection for reuse across requests */
let cachedConnection: typeof mongoose | null = null;

/** Whether event listeners have been registered (avoid duplicate listeners) */
let listenersRegistered: boolean = false;

/**
 * Resolve the effective MONGO_URI:
 *   1. Local config file (~/.claude-lens/config.json) takes priority
 *   2. Falls back to env var / baked-in value
 *   3. Returns undefined if neither exists (setup mode)
 */
function resolveMongoUri(): string | undefined {
    const localConfig: ILocalConfig | null = getLocalConfig();
    if (localConfig) {
        const activeConfig: IMongoConfiguration | undefined = localConfig.configurations.find(
            (config: IMongoConfiguration) => config.id === localConfig.activeConfigId,
        );
        if (activeConfig?.uri) {
            console.log('Database: Resolved URI'.cyan, activeConfig.uri);
            return activeConfig.uri;
        }
    }

    // return MONGO_URI;
}

/**
 * Establish MongoDB connection with pooling and graceful shutdown
 * Accepts an optional explicit URI (used by the setup endpoint)
 * Returns cached connection if already established
 * Returns null if no URI is available (setup mode)
 */
async function connectDB(uri?: string): Promise<typeof mongoose | null> {
    const effectiveUri: string | undefined = uri ?? resolveMongoUri();

    if (!effectiveUri) {
        console.warn('Config Warning: No MONGO_URI configured — running in setup mode'.yellow.bold);
        return null;
    }

    console.log('Database: Effective URI'.cyan, effectiveUri);

    try {
        // If an explicit URI is provided and we already have a connection, close it first
        if (uri && cachedConnection && mongoose.connection.readyState === 1) {
            console.log('Database: Closing existing connection to switch URI'.cyan);
            await closeConnection();
        }

        if (cachedConnection && mongoose.connection.readyState === 1) {
            console.log('Database: Using cached connection'.cyan, {cached: true});
            return cachedConnection;
        }

        const options = {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 300000,
            maxIdleTimeMS: 30000,
            retryWrites: true,
        };

        const connection = await mongoose.connect(effectiveUri, options);

        cachedConnection = connection;
        console.log('SUCCESS: Database connection established'.bgGreen.bold, {host: mongoose.connection.host, pooling: true});

        if (!listenersRegistered) {
            listenersRegistered = true;

            mongoose.connection.on('connected', () => {
                console.log('Background: Mongoose connected to MongoDB'.blue);
            });

            mongoose.connection.on('error', (err) => {
                console.error('Service Error: Mongoose connection failed'.red.bold, err);
            });

            mongoose.connection.on('disconnected', () => {
                console.warn('Config Warning: Mongoose disconnected'.yellow.italic);
                cachedConnection = null;
            });

            process.on('SIGINT', async () => {
                await closeConnection();
                console.log('Background: MongoDB connection closed through app termination (SIGINT)'.blue);
                process.exit(0);
            });

            process.on('SIGTERM', async () => {
                await closeConnection();
                console.log('Background: MongoDB connection closed through app termination (SIGTERM)'.blue);
                process.exit(0);
            });
        }

        return connection;
    } catch (error: any) {
        console.error('Service Error: Database connection failed'.red.bold, error);
        cachedConnection = null;
        throw error;
    }
}

/**
 * Close MongoDB connection gracefully
 */
async function closeConnection() {
    if (cachedConnection) {
        try {
            await mongoose.connection.close();
            cachedConnection = null;
            console.log('SUCCESS: MongoDB connection closed gracefully'.bgGreen.bold);
        } catch (error) {
            console.error('Service Error: Failed to close MongoDB connection'.red.bold, error);
        }
    }
}

export {connectDB, closeConnection};
