/** ------------- Constants and Type Aliases ------------- */

export type McpServerGroup = 'user' | 'project';

/** Raw shape of a single mcpServers entry in .claude.json */
export interface IRawMcpServer {
    type?: string;
    command?: string;
    args?: string[];
    url?: string;
    disabled?: boolean;
}


/** ------------- API response types ------------- */

export interface IMcpServerConfig {
    name: string;
    group: McpServerGroup;
    type: string;
    command?: string;
    args?: string[];
    url?: string;
    disabled: boolean;
}

export interface IGetMcpServersResponse {
    servers?: IMcpServerConfig[];
    error?: string;
}


/** ------------- function params ------------- */
