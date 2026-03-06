import "colors";
import mongoose from "mongoose";
import {Request, Response} from "express";
import {ISetupBody} from "../types/setup";
import {connectDB} from "../config/connectDB";
import {ApiResponse} from "../utils/ApiResponse";
import {generateMissingCode} from "../utils/generateErrorCodes";
import {getLocalConfig, ILocalConfig, saveLocalConfig} from "../utils/localConfig";

/**
 * GET /api/v1/setup/status
 * Returns whether the app is configured (has a valid DB connection) or in setup mode
 */
const getSetupStatusController = async (req: Request, res: Response) => {
    console.info('Controller: getStatusController started'.bgBlue.white.bold);

    try {
        const localConfig: ILocalConfig | null = getLocalConfig();
        const dbConnected: boolean = mongoose.connection.readyState === 1;

        console.log('SUCCESS: Status fetched'.bgGreen.bold, {configured: dbConnected, hasLocalConfig: localConfig !== null});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Status fetched!',
            configured: dbConnected,
            hasLocalConfig: localConfig !== null,
        }));
    } catch (error: any) {
        console.error('Controller Error: getStatusController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching status!',
        }));
    }
}

/**
 * POST /api/v1/setup
 * Receives { mongoUri }, validates by test-connecting, saves to local config, connects the app's DB
 */
const setupController = async (req: Request, res: Response) => {
    console.info('Controller: setupController started'.bgBlue.white.bold);

    try {
        const {mongoUri}: ISetupBody = req.body;

        if (!mongoUri) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('mongoUri'),
                errorMsg: 'mongoUri is required!',
            }));
            return;
        }

        // Validate by attempting a test connection
        const testConnection: mongoose.Connection = await mongoose.createConnection(mongoUri, {
            serverSelectionTimeoutMS: 5000,
        }).asPromise();

        await testConnection.close();

        // Test passed — save to local config
        saveLocalConfig({MONGO_URI: mongoUri});

        // Connect the app's main DB using the new URI
        await connectDB(mongoUri);

        console.log('SUCCESS: Setup complete'.bgGreen.bold);
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'MongoDB connected and config saved!',
        }));
    } catch (error: any) {
        console.error('Controller Error: setupController failed'.red.bold, error);
        res.status(400).send(new ApiResponse({
            success: false,
            errorCode: 'INVALID_MONGO_URI',
            errorMsg: error.message || 'Failed to connect to MongoDB with the provided URI!',
        }));
    }
}

export {getSetupStatusController, setupController};
