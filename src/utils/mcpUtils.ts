import "colors";
import fs from "fs";
import {IMcpServerConfig, IRawMcpServer, McpServerGroup} from "../types/mcp";

function parseMcpServers(filePath: string, group: McpServerGroup): IMcpServerConfig[] {
    if (!fs.existsSync(filePath)) {
        console.debug(`DEBUG: MCP config not found at ${filePath}`.cyan);
        return [];
    }

    try {
        const raw: string = fs.readFileSync(filePath, 'utf-8');
        const parsed: Record<string, unknown> = JSON.parse(raw);
        const mcpServers = parsed.mcpServers as Record<string, IRawMcpServer> | undefined;

        if (!mcpServers || typeof mcpServers !== 'object') return [];

        return Object.entries(mcpServers).map(([name, config]: [string, IRawMcpServer]) => ({
            name,
            group,
            type: config.type ?? 'stdio',
            command: config.command,
            args: config.args,
            url: config.url,
            disabled: config.disabled ?? false,
        }));
    } catch (error: any) {
        console.warn(`WARN: Failed to parse MCP config at ${filePath}`.yellow.bold, error.message);
        return [];
    }
}

export {parseMcpServers};
