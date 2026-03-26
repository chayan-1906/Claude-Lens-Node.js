import "colors";
import mongoose from "mongoose";
import {randomUUID} from "crypto";
import {Request, Response} from "express";
import MemoryModel from "../models/Memory";
import SessionModel from "../models/Session";
import {connectDB} from "../config/connectDB";
import {ApiResponse} from "../utils/ApiResponse";
import {TRAILING_SLASHES_REGEX} from "../utils/constants";
import {toProjectDirHash} from "../utils/resolveProjectDir";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {generateRandomColor, getLocalConfig, saveLocalConfig} from "../utils/localConfig";
import type {
    IAddConfigurationBody,
    IAddPathMappingBody,
    IConfigIdParams,
    IEditConfigurationBody,
    IEditPathMappingBody,
    ILocalConfig,
    IMappingIdParams,
    IMongoConfiguration,
    IPathMapping
} from "../types/setup";

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

        const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: '', pathMappings: []};

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
            errorCode: generateInvalidCode('mongoURI'),
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
            errorCode: isConnectionError ? generateInvalidCode('mongoURI') : 'INTERNAL_SERVER_ERROR',
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
            errorCode: generateInvalidCode('mongoURI'),
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
            errorCode: generateInvalidCode('mongoURI'),
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
            errorCode: generateInvalidCode('mongoURI'),
            errorMsg: error.message || 'Failed to fetch projects from the configuration!',
        }));
    } finally {
        if (tempConnection) {
            await tempConnection.close();
            console.debug('DEBUG: Temp connection closed'.cyan);
        }
    }
}

// ======================== Path Mapping Controllers ========================

/**
 * GET /api/v1/setup/path-mappings
 * List all saved path mappings
 */
const getPathMappingsController = async (req: Request, res: Response) => {
    console.info('Controller: getPathMappingsController started'.bgBlue.white.bold);

    try {
        const localConfig: ILocalConfig | null = getLocalConfig();
        const pathMappings: IPathMapping[] = localConfig?.pathMappings ?? [];

        console.log('SUCCESS: Path mappings fetched'.bgGreen.bold, {count: pathMappings.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Path mappings fetched!',
            pathMappings,
        }));
    } catch (error: any) {
        console.error('Controller Error: getPathMappingsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching path mappings!',
        }));
    }
}

/**
 * POST /api/v1/setup/path-mappings
 * Create a new path mapping
 */
const createPathMappingController = async (req: Request, res: Response) => {
    console.info('Controller: createPathMappingController started'.bgBlue.white.bold);

    try {
        const {label, paths, canonicalPath}: IAddPathMappingBody = req.body;

        if (!label) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('label'),
                errorMsg: 'label is required!',
            }));
            return;
        }

        if (!paths || paths.length < 2) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('paths'),
                errorMsg: 'At least 2 paths are required!',
            }));
            return;
        }

        if (!canonicalPath) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('canonicalPath'),
                errorMsg: 'canonicalPath is required!',
            }));
            return;
        }

        // Strip trailing slashes for consistent matching
        const normalizedPaths: string[] = paths.map((project: string) => project.replace(TRAILING_SLASHES_REGEX, ''));
        const normalizedCanonical: string = canonicalPath.replace(TRAILING_SLASHES_REGEX, '');

        // Validate canonical is one of the paths
        if (!normalizedPaths.includes(normalizedCanonical)) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('canonicalPath'),
                errorMsg: 'canonicalPath must be one of the entries in paths!',
            }));
            return;
        }

        const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: '', pathMappings: []};
        if (!localConfig.pathMappings) {
            localConfig.pathMappings = [];
        }

        const newMapping: IPathMapping = {
            id: randomUUID(),
            label,
            paths: normalizedPaths,
            canonicalPath: normalizedCanonical,
        };

        localConfig.pathMappings.push(newMapping);
        saveLocalConfig(localConfig);

        console.log('SUCCESS: Path mapping created'.bgGreen.bold, {id: newMapping.id, label: newMapping.label});
        res.status(201).send(new ApiResponse({
            success: true,
            message: 'Path mapping created!',
            pathMapping: newMapping,
        }));
    } catch (error: any) {
        console.error('Controller Error: createPathMappingController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while creating path mapping!',
        }));
    }
}

/**
 * PUT /api/v1/setup/path-mappings/:mappingId
 * Edit an existing path mapping
 */
const updatePathMappingController = async (req: Request, res: Response) => {
    console.info('Controller: updatePathMappingController started'.bgBlue.white.bold);

    try {
        const {mappingId}: Partial<IMappingIdParams> = req.params;
        const {label, paths, canonicalPath}: IEditPathMappingBody = req.body;

        if (!mappingId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('mappingId'),
                errorMsg: 'mappingId is required!',
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
        if (!localConfig.pathMappings) {
            localConfig.pathMappings = [];
        }

        const mappingIndex: number = localConfig.pathMappings.findIndex((m: IPathMapping) => m.id === mappingId);
        if (mappingIndex === -1) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('pathMapping'),
                errorMsg: `Path mapping with id ${mappingId} not found!`,
            }));
            return;
        }

        // Apply updates
        if (label !== undefined) localConfig.pathMappings[mappingIndex].label = label;
        if (paths !== undefined) {
            if (paths.length < 2) {
                res.status(400).send(new ApiResponse({
                    success: false,
                    errorCode: generateInvalidCode('paths'),
                    errorMsg: 'At least 2 paths are required!',
                }));
                return;
            }
            localConfig.pathMappings[mappingIndex].paths = paths.map((p: string) => p.replace(TRAILING_SLASHES_REGEX, ''));
        }
        if (canonicalPath !== undefined) {
            localConfig.pathMappings[mappingIndex].canonicalPath = canonicalPath.replace(TRAILING_SLASHES_REGEX, '');
        }

        // Validate canonical is still in paths after updates
        const currentMapping: IPathMapping = localConfig.pathMappings[mappingIndex];
        if (!currentMapping.paths.includes(currentMapping.canonicalPath)) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('canonicalPath'),
                errorMsg: 'canonicalPath must be one of the entries in paths!',
            }));
            return;
        }

        saveLocalConfig(localConfig);

        console.log('SUCCESS: Path mapping updated'.bgGreen.bold, {mappingId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Path mapping updated!',
            pathMapping: currentMapping,
        }));
    } catch (error: any) {
        console.error('Controller Error: updatePathMappingController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while updating path mapping!',
        }));
    }
}

/**
 * DELETE /api/v1/setup/path-mappings/:mappingId
 * Delete a path mapping
 */
const deletePathMappingController = async (req: Request, res: Response) => {
    console.info('Controller: deletePathMappingController started'.bgBlue.white.bold);

    try {
        const {mappingId}: Partial<IMappingIdParams> = req.params;

        if (!mappingId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('mappingId'),
                errorMsg: 'mappingId is required!',
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
        if (!localConfig.pathMappings) {
            localConfig.pathMappings = [];
        }

        const mappingIndex: number = localConfig.pathMappings.findIndex((m: IPathMapping) => m.id === mappingId);
        if (mappingIndex === -1) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('pathMapping'),
                errorMsg: `Path mapping with id ${mappingId} not found!`,
            }));
            return;
        }

        localConfig.pathMappings.splice(mappingIndex, 1);
        saveLocalConfig(localConfig);

        console.log('SUCCESS: Path mapping deleted'.bgGreen.bold, {mappingId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Path mapping deleted!',
        }));
    } catch (error: any) {
        console.error('Controller Error: deletePathMappingController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting path mapping!',
        }));
    }
}

/**
 * POST /api/v1/setup/path-mappings/:mappingId/merge
 * Migrate existing Session + Memory docs with non-canonical paths to use the canonical path
 * This is a one-time operation to unify previously split data
 */
const mergePathMappingController = async (req: Request, res: Response) => {
    console.info('Controller: mergePathMappingController started'.bgBlue.white.bold);

    try {
        const {mappingId}: Partial<IMappingIdParams> = req.params;

        if (!mappingId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('mappingId'),
                errorMsg: 'mappingId is required!',
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
        if (!localConfig.pathMappings) {
            localConfig.pathMappings = [];
        }

        const mapping: IPathMapping | undefined = localConfig.pathMappings.find((m: IPathMapping) => m.id === mappingId);
        if (!mapping) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('pathMapping'),
                errorMsg: `Path mapping with id ${mappingId} not found!`,
            }));
            return;
        }

        const canonicalHash: string = toProjectDirHash(mapping.canonicalPath);

        // Build list of non-canonical hashes and raw paths to migrate
        const nonCanonicalPaths: string[] = mapping.paths.filter((p: string) => p !== mapping.canonicalPath);
        const nonCanonicalHashes: string[] = nonCanonicalPaths.map((p: string) => toProjectDirHash(p));

        let sessionsUpdated: number = 0;
        let memoriesUpdated: number = 0;

        // Migrate sessions: update projectDir and rawProjectDir for all non-canonical variants
        if (nonCanonicalHashes.length > 0) {
            const sessionResult = await SessionModel.updateMany(
                {projectDir: {$in: nonCanonicalHashes}},
                {$set: {projectDir: canonicalHash, rawProjectDir: mapping.canonicalPath}},
            );
            sessionsUpdated = sessionResult.modifiedCount;
            console.debug('DEBUG: Sessions migrated'.cyan, {sessionsUpdated, nonCanonicalHashes});
        }

        // Migrate memories: update projectDir for all non-canonical variants
        if (nonCanonicalHashes.length > 0) {
            const memoryResult = await MemoryModel.updateMany(
                {projectDir: {$in: nonCanonicalHashes}},
                {$set: {projectDir: canonicalHash}},
            );
            memoriesUpdated = memoryResult.modifiedCount;
            console.debug('DEBUG: Memories migrated'.cyan, {memoriesUpdated});
        }

        console.log('SUCCESS: Path mapping merge complete'.bgGreen.bold, {mappingId, sessionsUpdated, memoriesUpdated});
        res.status(200).send(new ApiResponse({
            success: true,
            message: `Merge complete! ${sessionsUpdated} session(s) and ${memoriesUpdated} memory doc(s) updated.`,
            sessionsUpdated,
            memoriesUpdated,
        }));
    } catch (error: any) {
        console.error('Controller Error: mergePathMappingController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while merging path mapping data!',
        }));
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
    getPathMappingsController,
    createPathMappingController,
    updatePathMappingController,
    deletePathMappingController,
    mergePathMappingController,
};