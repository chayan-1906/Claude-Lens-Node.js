import "colors";
import fs from "fs";
import os from "os";
import path from "path";
import Groq from "groq-sdk";
import mongoose from "mongoose";
import {randomUUID} from "crypto";
import {Request, Response} from "express";
import {initR2Client} from "../utils/r2";
import MemoryModel from "../models/Memory";
import SessionModel from "../models/Session";
import {connectDB} from "../config/connectDB";
import {ApiResponse} from "../utils/ApiResponse";
import {toProjectDirHash} from "../utils/resolveProjectDir";
import {R2_ENDPOINT_REGEX, TRAILING_SLASHES_REGEX} from "../utils/constants";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {clearClaudeConfigDir, generateRandomColor, getGroqConfig, getLocalConfig, getR2Config, saveClaudeConfigDir, saveGroqConfig, saveLocalConfig, saveR2Config} from "../utils/localConfig";
import type {
    IAddConfigurationBody,
    IAddPathMappingBody,
    IClaudeAccount,
    IConfigIdParams,
    IEditConfigurationBody,
    IEditPathMappingBody,
    IGroqConfig,
    ILocalConfig,
    IMappingIdParams,
    IMongoConfiguration,
    IPathMapping,
    IR2Config,
    ISaveClaudeAccountBody,
    ISaveGroqConfigBody,
    ISaveR2ConfigBody,
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
        const r2Config: IR2Config | null = getR2Config();
        const r2Configured: boolean = r2Config !== null;
        const groqConfig: IGroqConfig | null = getGroqConfig();
        const groqConfigured: boolean = groqConfig !== null;
        console.debug('DEBUG: DB readyState'.cyan, {readyState: mongoose.connection.readyState, dbConnected, hasLocalConfig: localConfig !== null, r2Configured, groqConfigured});

        console.log('SUCCESS: Status fetched'.bgGreen.bold, {configured: dbConnected, hasLocalConfig: localConfig !== null, r2Configured, groqConfigured});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Status fetched!',
            configured: dbConnected,
            hasLocalConfig: localConfig !== null,
            r2Configured,
            groqConfigured,
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

// ======================== R2 Config Controllers ========================

/**
 * GET /api/v1/setup/r2-config
 * Returns saved R2 credentials (SECRET_ACCESS_KEY masked to '***')
 */
const getR2ConfigController = async (req: Request, res: Response) => {
    console.info('Controller: getR2ConfigController started'.bgBlue.white.bold);

    try {
        const r2Config: IR2Config | null = getR2Config();

        if (!r2Config) {
            console.log('SUCCESS: R2 config not configured'.bgGreen.bold);
            res.status(200).send(new ApiResponse({
                success: true,
                message: 'R2 config not configured yet!',
                r2Config: null,
            }));
            return;
        }

        console.log('SUCCESS: R2 config fetched'.bgGreen.bold);
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'R2 config fetched!',
            r2Config,
        }));
    } catch (error: any) {
        console.error('Controller Error: getR2ConfigController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching R2 config!',
        }));
    }
}

/**
 * POST /api/v1/setup/r2-config
 * Validates all 5 fields, saves to config.json, injects into process.env, re-initializes S3Client
 */
const saveR2ConfigController = async (req: Request, res: Response) => {
    console.info('Controller: saveR2ConfigController started'.bgBlue.white.bold);

    try {
        const {accessKeyId, secretAccessKey, endpoint, publicUrl, bucketName}: ISaveR2ConfigBody = req.body;

        if (!accessKeyId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('accessKeyId'),
                errorMsg: 'accessKeyId is required!',
            }));
            return;
        }

        if (!secretAccessKey) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('secretAccessKey'),
                errorMsg: 'secretAccessKey is required!',
            }));
            return;
        }

        if (!endpoint) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('endpoint'),
                errorMsg: 'endpoint is required!',
            }));
            return;
        }

        if (!R2_ENDPOINT_REGEX.test(endpoint)) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('endpoint'),
                errorMsg: 'endpoint must be a valid Cloudflare R2 URL in the format https://<account-id>.r2.cloudflarestorage.com',
            }));
            return;
        }

        if (!publicUrl) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('publicUrl'),
                errorMsg: 'publicUrl is required!',
            }));
            return;
        }

        if (!bucketName) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('bucketName'),
                errorMsg: 'bucketName is required!',
            }));
            return;
        }

        // If secretAccessKey is masked, preserve the existing value
        let effectiveSecretAccessKey: string = secretAccessKey;
        if (secretAccessKey === '***') {
            const existingConfig: IR2Config | null = getR2Config();
            if (existingConfig) {
                effectiveSecretAccessKey = existingConfig.secretAccessKey;
            } else {
                res.status(400).send(new ApiResponse({
                    success: false,
                    errorCode: generateInvalidCode('secretAccessKey'),
                    errorMsg: 'secretAccessKey cannot be masked when no existing config is saved!',
                }));
                return;
            }
        }

        const r2Config: IR2Config = {
            accessKeyId,
            secretAccessKey: effectiveSecretAccessKey,
            endpoint,
            publicUrl,
            bucketName,
        };

        // Save to ~/.claude-lens/config.json
        saveR2Config(r2Config);

        // Re-initialize S3Client with new credentials (reads from config.json)
        initR2Client();

        console.log('SUCCESS: R2 config saved'.bgGreen.bold);
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'R2 config saved!',
            r2Config: {
                ...r2Config,
                secretAccessKey: '***',
            },
        }));
    } catch (error: any) {
        console.error('Controller Error: saveR2ConfigController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while saving R2 config!',
        }));
    }
}

// ======================== Claude Account Controllers ========================

/**
 * GET /api/v1/setup/accounts
 * Scans $HOME for ~/.claude-.../ directories and returns each as a selectable Claude account.
 * Only includes dirs that contain Claude CLI indicator files (settings.json, history.jsonl,
 * memory.json, accounts.json) — this excludes non-Claude dirs like ~/.claude-lens/.
 * Label is derived from the directory name: .claude → "Default", .claude-personal → "Personal".
 */
const CLAUDE_CLI_INDICATORS: string[] = ['settings.json', 'history.jsonl', 'memory.json', 'accounts.json'];

const getAccountsController = async (req: Request, res: Response) => {
    console.info('Controller: getAccountsController started'.bgBlue.white.bold);

    try {
        const HOME: string = process.env.HOME || os.homedir();

        const defaultClaudeDir: string = path.join(HOME, '.claude');

        const entries: fs.Dirent[] = fs.readdirSync(HOME, {withFileTypes: true});
        const claudeDirs: string[] = entries
            .filter((entry: fs.Dirent) => entry.isDirectory() && /^\.claude/.test(entry.name))
            .map((entry: fs.Dirent) => path.join(HOME, entry.name))
            .filter((configDir: string) =>
                // Exclude ~/.claude/ — it's the system default, explicitly passing it as env var causes issues
                configDir !== defaultClaudeDir
                // Only include dirs with Claude CLI indicator files (excludes ~/.claude-lens/ etc.)
                && CLAUDE_CLI_INDICATORS.some((indicator: string) => fs.existsSync(path.join(configDir, indicator))),
            );

        const accounts: IClaudeAccount[] = claudeDirs.map((configDir: string) => {
            const dirName: string = path.basename(configDir);
            // .claude → "Default", .claude-personal → "Personal", .claude-remix → "Remix"
            const suffix: string = dirName.replace(/^\.claude/, '').replace(/^-/, '');
            const label: string = suffix
                ? suffix.charAt(0).toUpperCase() + suffix.slice(1)
                : 'Default';

            return {
                configDir,
                email: null,
                label,
                isLoggedIn: true,
            };
        });

        console.log('SUCCESS: Accounts fetched'.bgGreen.bold, {count: accounts.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Accounts fetched!',
            accounts,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAccountsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching accounts!',
        }));
    }
}

/**
 * GET /api/v1/setup/claude-account
 * Returns the currently saved claudeConfigDir from ~/.claude-lens/config.json.
 */
const getClaudeAccountController = async (req: Request, res: Response) => {
    console.info('Controller: getClaudeAccountController started'.bgBlue.white.bold);

    try {
        const localConfig: ILocalConfig | null = getLocalConfig();
        const claudeConfigDir: string | null = localConfig?.claudeConfigDir ?? null;

        console.log('SUCCESS: Claude config dir fetched'.bgGreen.bold, {claudeConfigDir});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Claude config dir fetched!',
            claudeConfigDir,
        }));
    } catch (error: any) {
        console.error('Controller Error: getClaudeAccountController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching Claude config dir!',
        }));
    }
}

/**
 * POST /api/v1/setup/claude-account
 * Saves the selected CLAUDE_CONFIG_DIR to ~/.claude-lens/config.json.
 * Only accepts paths matching $HOME/.claude* to prevent path traversal.
 */
const saveClaudeAccountController = async (req: Request, res: Response) => {
    console.info('Controller: saveClaudeAccountController started'.bgBlue.white.bold);

    try {
        const {claudeConfigDir}: ISaveClaudeAccountBody = req.body;

        // Empty string = revert to system default (clear any saved override)
        if (claudeConfigDir === '') {
            clearClaudeConfigDir();
            console.log('SUCCESS: Claude config dir cleared (system default)'.bgGreen.bold);
            res.status(200).send(new ApiResponse({
                success: true,
                message: 'Reverted to system default!',
            }));
            return;
        }

        if (!claudeConfigDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('claudeConfigDir'),
                errorMsg: 'claudeConfigDir is required!',
            }));
            return;
        }

        const HOME: string = process.env.HOME || os.homedir();
        const resolvedDir: string = path.resolve(claudeConfigDir.replace(/^~/, HOME));
        const isValid: boolean = resolvedDir.startsWith(HOME + path.sep) && /^\.claude/.test(path.basename(resolvedDir));

        if (!isValid) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('claudeConfigDir'),
                errorMsg: 'claudeConfigDir must be a ~/.claude* directory!',
            }));
            return;
        }

        saveClaudeConfigDir(resolvedDir);

        console.log('SUCCESS: Claude config dir saved'.bgGreen.bold, {claudeConfigDir: resolvedDir});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Claude config dir saved!',
        }));
    } catch (error: any) {
        console.error('Controller Error: saveClaudeAccountController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while saving Claude config dir!',
        }));
    }
}

/**
 * GET /api/v1/setup/groq-config
 * Returns saved Groq credentials
 */
const getGroqConfigController = async (req: Request, res: Response) => {
    console.info('Controller: getGroqConfigController started'.bgBlue.white.bold);

    try {
        const groqConfig: IGroqConfig | null = getGroqConfig();

        if (!groqConfig) {
            console.log('SUCCESS: Groq config not configured'.bgGreen.bold);
            res.status(200).send(new ApiResponse({
                success: true,
                message: 'Groq config not configured yet!',
                groqConfig: null,
            }));
            return;
        }

        console.log('SUCCESS: Groq config fetched'.bgGreen.bold);
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Groq config fetched!',
            groqConfig,
        }));
    } catch (error: any) {
        console.error('Controller Error: getGroqConfigController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching Groq config!',
        }));
    }
}

/**
 * POST /api/v1/setup/groq-config
 * Validates apiKey against Groq API, saves to config.json
 */
const saveGroqConfigController = async (req: Request, res: Response) => {
    console.info('Controller: saveGroqConfigController started'.bgBlue.white.bold);

    try {
        const {apiKey}: ISaveGroqConfigBody = req.body;

        if (!apiKey) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('apiKey'),
                errorMsg: 'apiKey is required!',
            }));
            return;
        }

        // Validate key against Groq API — lightweight models.list() call
        try {
            const groq: Groq = new Groq({apiKey});
            await groq.models.list();
        } catch (validationError: any) {
            const isAuthError: boolean = validationError?.status === 401 || validationError?.status === 403;
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('apiKey'),
                errorMsg: isAuthError
                    ? 'apiKey is invalid — Groq rejected the key. Please check and try again.'
                    : 'Could not validate key against Groq — check the key and your network connection.',
            }));
            return;
        }

        const groqConfig: IGroqConfig = {apiKey};

        // Save to ~/.claude-lens/config.json
        saveGroqConfig(groqConfig);

        console.log('SUCCESS: Groq config saved'.bgGreen.bold);
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Groq config saved!',
            groqConfig,
        }));
    } catch (error: any) {
        console.error('Controller Error: saveGroqConfigController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while saving Groq config!',
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
    getR2ConfigController,
    saveR2ConfigController,
    getGroqConfigController,
    saveGroqConfigController,
    getAccountsController,
    getClaudeAccountController,
    saveClaudeAccountController,
};