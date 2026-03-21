/** A single saved MongoDB configuration */
export interface IMongoConfiguration {
    id: string;
    name: string;
    uri: string;
    description?: string;
    color: string;
    lastConnectedAt?: string;
}

/** Current config schema with multiple configurations */
export interface ILocalConfig {
    configurations: IMongoConfiguration[];
    activeConfigId: string;
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
