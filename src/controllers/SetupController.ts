import "colors";
import mongoose from "mongoose";
import {randomUUID} from "crypto";
import {Request, Response} from "express";
import {connectDB} from "../config/connectDB";
import {ApiResponse} from "../utils/ApiResponse";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {generateRandomColor, getLocalConfig, saveLocalConfig} from "../utils/localConfig";
import type {IAddConfigurationBody, IConfigIdParams, IEditConfigurationBody, ILocalConfig, IMongoConfiguration} from "../types/setup";

/**
 * GET /api/v1/setup/status
 * Returns whether the app is configured (has a valid DB connection) or in setup mode
 */
const getSetupStatusController = async (req: Request, res: Response) => {
    console.info('Controller: getSetupStatusController started'.bgBlue.white.bold);

    try {
        const localConfig: ILocalConfig | null = getLocalConfig();
        const dbConnected: boolean = mongoose.connection.readyState === 1;
        console.debug('DEBUG: DB readyState'.cyan, {readyState: mongoose.connection.readyState, dbConnected, hasLocalConfig: localConfig !== null});

        console.log('SUCCESS: Status fetched'.bgGreen.bold, {configured: dbConnected, hasLocalConfig: localConfig !== null});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Status fetched!',
            configured: dbConnected,
            hasLocalConfig: localConfig !== null,
        }));
    } catch (error: any) {
        console.error('Controller Error: getSetupStatusController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching status!',
        }));
    }
}

/**
 * GET /api/v1/setup/configurations
 * List all saved MongoDB configurations
 */
const getConfigurationsController = async (req: Request, res: Response) => {
    console.info('Controller: getConfigurationsController started'.bgBlue.white.bold);

    try {
        const localConfig: ILocalConfig | null = getLocalConfig();

        const configurations: IMongoConfiguration[] = localConfig?.configurations ?? [];
        const activeConfigId: string = localConfig?.activeConfigId ?? '';

        console.log('SUCCESS: Configurations fetched'.bgGreen.bold, {count: configurations.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Configurations fetched!',
            configurations,
            activeConfigId,
        }));
    } catch (error: any) {
        console.error('Controller Error: getConfigurationsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching configurations!',
        }));
    }
}

/**
 * POST /api/v1/setup/configurations
 * Add a new MongoDB configuration (validates URI via test connection)
 */
const addConfigurationController = async (req: Request, res: Response) => {
    console.info('Controller: addConfigurationController started'.bgBlue.white.bold);

    try {
        const {name, uri, description, color}: IAddConfigurationBody = req.body;

        if (!name) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('name'),
                errorMsg: 'name is required!',
            }));
            return;
        }

        if (!uri) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('uri'),
                errorMsg: 'uri is required!',
            }));
            return;
        }

        // Validate URI via test connection
        console.debug('DEBUG: Attempting test connection for new config'.cyan);
        const testConnection: mongoose.Connection = await mongoose.createConnection(uri, {
            serverSelectionTimeoutMS: 5000,
        }).asPromise();
        await testConnection.close();
        console.debug('DEBUG: Test connection succeeded'.cyan);

        const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: ''};

        const newConfig: IMongoConfiguration = {
            id: randomUUID(),
            name,
            uri,
            description: description || undefined,
            color: color || generateRandomColor(),
        };

        localConfig.configurations.push(newConfig);

        // If this is the first config, make it active
        if (!localConfig.activeConfigId) {
            localConfig.activeConfigId = newConfig.id;
        }

        saveLocalConfig(localConfig);

        console.log('SUCCESS: Configuration added'.bgGreen.bold, {id: newConfig.id, name: newConfig.name});
        res.status(201).send(new ApiResponse({
            success: true,
            message: 'Configuration added!',
            configuration: newConfig,
        }));
    } catch (error: any) {
        console.error('Controller Error: addConfigurationController failed'.red.bold, error);
        res.status(400).send(new ApiResponse({
            success: false,
            errorCode: 'INVALID_MONGO_URI',
            errorMsg: error.message || 'Failed to connect to MongoDB with the provided URI!',
        }));
    }
}

/**
 * PUT /api/v1/setup/configurations/:configId
 * Edit an existing configuration
 */
const editConfigurationController = async (req: Request, res: Response) => {
    console.info('Controller: editConfigurationController started'.bgBlue.white.bold);

    try {
        const {configId}: Partial<IConfigIdParams> = req.params;
        const {name, uri, description, color}: IEditConfigurationBody = req.body;

        if (!configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('configId'),
                errorMsg: 'configId is required!',
            }));
            return;
        }

        const localConfig: ILocalConfig | null = getLocalConfig();
        if (!localConfig) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('config'),
                errorMsg: 'No configurations found!',
            }));
            return;
        }

        const configIndex: number = localConfig.configurations.findIndex((c) => c.id === configId);
        if (configIndex === -1) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('configuration'),
                errorMsg: `Configuration with id ${configId} not found!`,
            }));
            return;
        }

        // If URI is being changed, validate via test connection
        if (uri && uri !== localConfig.configurations[configIndex].uri) {
            console.debug('DEBUG: URI changed, testing new connection'.cyan);
            const testConnection: mongoose.Connection = await mongoose.createConnection(uri, {
                serverSelectionTimeoutMS: 5000,
            }).asPromise();
            await testConnection.close();
            console.debug('DEBUG: New URI test connection succeeded'.cyan);
        }

        // Update fields (only provided ones)
        if (name !== undefined) localConfig.configurations[configIndex].name = name;
        if (uri !== undefined) localConfig.configurations[configIndex].uri = uri;
        if (description !== undefined) localConfig.configurations[configIndex].description = description || undefined;
        if (color !== undefined) localConfig.configurations[configIndex].color = color;

        saveLocalConfig(localConfig);

        console.log('SUCCESS: Configuration updated'.bgGreen.bold, {configId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Configuration updated!',
            configuration: localConfig.configurations[configIndex],
        }));
    } catch (error: any) {
        console.error('Controller Error: editConfigurationController failed'.red.bold, error);
        const isConnectionError: boolean = error.message?.includes('connect') || error.name === 'MongoServerSelectionError';
        res.status(isConnectionError ? 400 : 500).send(new ApiResponse({
            success: false,
            errorCode: isConnectionError ? 'INVALID_MONGO_URI' : 'INTERNAL_SERVER_ERROR',
            errorMsg: error.message || 'Failed to update configuration!',
        }));
    }
}

/**
 * DELETE /api/v1/setup/configurations/:configId
 * Delete a configuration (prevent deleting the active one)
 */
const deleteConfigurationController = async (req: Request, res: Response) => {
    console.info('Controller: deleteConfigurationController started'.bgBlue.white.bold);

    try {
        const {configId}: Partial<IConfigIdParams> = req.params;

        if (!configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('configId'),
                errorMsg: 'configId is required!',
            }));
            return;
        }

        const localConfig: ILocalConfig | null = getLocalConfig();
        if (!localConfig) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('config'),
                errorMsg: 'No configurations found!',
            }));
            return;
        }

        const configIndex: number = localConfig.configurations.findIndex((c) => c.id === configId);
        if (configIndex === -1) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('configuration'),
                errorMsg: `Configuration with id ${configId} not found!`,
            }));
            return;
        }

        // Prevent deleting the active configuration
        if (localConfig.activeConfigId === configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'ACTIVE_CONFIG_DELETE',
                errorMsg: 'Cannot delete the active configuration! Switch to another configuration first.',
            }));
            return;
        }

        localConfig.configurations.splice(configIndex, 1);
        saveLocalConfig(localConfig);

        console.log('SUCCESS: Configuration deleted'.bgGreen.bold, {configId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Configuration deleted!',
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteConfigurationController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting configuration!',
        }));
    }
}

/**
 * POST /api/v1/setup/configurations/:configId/test
 * Test connection to a configuration's MongoDB URI without saving or switching
 */
const testConfigurationController = async (req: Request, res: Response) => {
    console.info('Controller: testConfigurationController started'.bgBlue.white.bold);

    try {
        const {configId}: Partial<IConfigIdParams> = req.params;

        if (!configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('configId'),
                errorMsg: 'configId is required!',
            }));
            return;
        }

        const localConfig: ILocalConfig | null = getLocalConfig();
        if (!localConfig) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('config'),
                errorMsg: 'No configurations found!',
            }));
            return;
        }

        const config: IMongoConfiguration | undefined = localConfig.configurations.find((c) => c.id === configId);
        if (!config) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('configuration'),
                errorMsg: `Configuration with id ${configId} not found!`,
            }));
            return;
        }

        console.debug('DEBUG: Testing connection for config'.cyan, {configId, name: config.name});
        const testConnection: mongoose.Connection = await mongoose.createConnection(config.uri, {
            serverSelectionTimeoutMS: 5000,
        }).asPromise();
        await testConnection.close();

        console.log('SUCCESS: Test connection passed'.bgGreen.bold, {configId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Connection test passed!',
        }));
    } catch (error: any) {
        console.error('Controller Error: testConfigurationController failed'.red.bold, error);
        res.status(400).send(new ApiResponse({
            success: false,
            errorCode: 'INVALID_MONGO_URI',
            errorMsg: error.message || 'Failed to connect to MongoDB!',
        }));
    }
}

/**
 * POST /api/v1/setup/configurations/:configId/activate
 * Switch the active configuration (close old connection, connect new)
 */
const activateConfigurationController = async (req: Request, res: Response) => {
    console.info('Controller: activateConfigurationController started'.bgBlue.white.bold);

    try {
        const {configId}: Partial<IConfigIdParams> = req.params;

        if (!configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('configId'),
                errorMsg: 'configId is required!',
            }));
            return;
        }

        const localConfig: ILocalConfig | null = getLocalConfig();
        if (!localConfig) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('config'),
                errorMsg: 'No configurations found!',
            }));
            return;
        }

        const config: IMongoConfiguration | undefined = localConfig.configurations.find((config: IMongoConfiguration) => config.id === configId);
        if (!config) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('configuration'),
                errorMsg: `Configuration with id ${configId} not found!`,
            }));
            return;
        }

        // Already active
        if (localConfig.activeConfigId === configId) {
            res.status(200).send(new ApiResponse({
                success: true,
                message: 'Configuration is already active!',
            }));
            return;
        }

        // Connect to the new URI (connectDB handles closing old connection)
        console.debug('DEBUG: Activating configuration'.cyan, {configId, name: config.name});
        await connectDB(config.uri);

        // Update active config and lastConnectedAt
        localConfig.activeConfigId = configId;
        config.lastConnectedAt = new Date().toISOString();
        saveLocalConfig(localConfig);

        console.log('SUCCESS: Configuration activated'.bgGreen.bold, {configId, name: config.name});
        res.status(200).send(new ApiResponse({
            success: true,
            message: `Switched to "${config.name}"!`,
        }));
    } catch (error: any) {
        console.error('Controller Error: activateConfigurationController failed'.red.bold, error);
        res.status(400).send(new ApiResponse({
            success: false,
            errorCode: 'INVALID_MONGO_URI',
            errorMsg: error.message || 'Failed to connect to the selected configuration!',
        }));
    }
}

/**
 * GET /api/v1/setup/configurations/:configId/projects
 * Quick preview of projects stored in a configuration's MongoDB
 */
const getConfigProjectsController = async (req: Request, res: Response) => {
    console.info('Controller: getConfigProjectsController started'.bgBlue.white.bold);

    let tempConnection: mongoose.Connection | null = null;

    try {
        const {configId}: Partial<IConfigIdParams> = req.params;

        if (!configId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('configId'),
                errorMsg: 'configId is required!',
            }));
            return;
        }

        const localConfig: ILocalConfig | null = getLocalConfig();
        if (!localConfig) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('config'),
                errorMsg: 'No configurations found!',
            }));
            return;
        }

        const config: IMongoConfiguration | undefined = localConfig.configurations.find((config: IMongoConfiguration) => config.id === configId);
        if (!config) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('configuration'),
                errorMsg: `Configuration with id ${configId} not found!`,
            }));
            return;
        }

        // Open a temporary connection to fetch projects
        console.debug('DEBUG: Opening temp connection for project preview'.cyan, {configId});
        tempConnection = await mongoose.createConnection(config.uri, {
            serverSelectionTimeoutMS: 5000,
        }).asPromise();

        // Use the sessions collection to aggregate unique projects
        const sessionsCollection = tempConnection.collection('sessions');
        const projects = await sessionsCollection.aggregate([
            {
                $group: {
                    _id: {
                        rawProjectDir: '$rawProjectDir',
                        projectDir: '$projectDir',
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    rawProjectDir: '$_id.rawProjectDir',
                    projectDir: '$_id.projectDir',
                },
            },
        ]).toArray();

        console.log('SUCCESS: Config projects fetched'.bgGreen.bold, {configId, count: projects.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Projects fetched!',
            projects,
        }));
    } catch (error: any) {
        console.error('Controller Error: getConfigProjectsController failed'.red.bold, error);
        res.status(400).send(new ApiResponse({
            success: false,
            errorCode: 'INVALID_MONGO_URI',
            errorMsg: error.message || 'Failed to fetch projects from the configuration!',
        }));
    } finally {
        if (tempConnection) {
            await tempConnection.close();
            console.debug('DEBUG: Temp connection closed'.cyan);
        }
    }
}

export {
    getSetupStatusController,
    getConfigurationsController,
    addConfigurationController,
    editConfigurationController,
    deleteConfigurationController,
    testConfigurationController,
    activateConfigurationController,
    getConfigProjectsController,
};