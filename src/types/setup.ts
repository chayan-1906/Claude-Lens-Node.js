/** A single saved MongoDB configuration */
export interface IMongoConfiguration {
    id: string;
    name: string;
    uri: string;
    description?: string;
    color: string;
    lastConnectedAt?: string;
}

/** Cloudflare R2 storage credentials for attachment uploads */
export interface IR2Config {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    publicUrl: string;
    bucketName: string;
}

/** A single path mapping — maps multiple absolute paths to one canonical path */
export interface IPathMapping {
    id: string;              // UUID — unique key
    label: string;           // Human-readable, e.g. "claude-lens (NodeJs)"
    paths: string[];         // ALL known absolute paths for the same project
    canonicalPath: string;   // MUST be one of the entries in paths[]
}

/** A detected Claude account from a ~/.claude-.../ directory */
export interface IClaudeAccount {
    configDir: string;
    email: string | null;
    label: string;
    isLoggedIn: boolean;
}

/** Current config schema with multiple configurations */
export interface ILocalConfig {
    configurations: IMongoConfiguration[];
    activeConfigId: string;
    pathMappings: IPathMapping[];
    r2Config?: IR2Config;
    ttsVoiceId?: string;
    ttsRate?: number;
    claudeConfigDir?: string;
}

/** POST /api/v1/setup/configurations — request body */
export interface IAddConfigurationBody {
    name?: string;
    uri?: string;
    description?: string;
    color?: string;
}

/** PUT /api/v1/setup/configurations/:configId — request body */
export interface IEditConfigurationBody {
    name?: string;
    uri?: string;
    description?: string;
    color?: string;
}

/** Route params for configuration endpoints that require :configId */
export interface IConfigIdParams {
    configId?: string;
}

/** POST /api/v1/setup/path-mappings — request body */
export interface IAddPathMappingBody {
    label?: string;
    paths?: string[];
    canonicalPath?: string;
}

/** PUT /api/v1/setup/path-mappings/:mappingId — request body */
export interface IEditPathMappingBody {
    label?: string;
    paths?: string[];
    canonicalPath?: string;
}

/** Route params for path mapping endpoints that require :mappingId */
export interface IMappingIdParams {
    mappingId?: string;
}

/** POST /api/v1/setup/r2-config — request body */
export interface ISaveR2ConfigBody {
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
    publicUrl?: string;
    bucketName?: string;
}

/** POST /api/v1/setup/claude-account — request body */
export interface ISaveClaudeAccountBody {
    claudeConfigDir?: string;
}
