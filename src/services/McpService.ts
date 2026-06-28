import "colors";
import path from "path";
import {parseMcpServers} from "../utils/mcpUtils";
import {getClaudeConfigDir} from "../utils/localConfig";
import {IMcpServerConfig, IGetMcpServersResponse} from "../types/mcp";

class McpService {
    static async getMcpServers(): Promise<IGetMcpServersResponse> {
        console.log('Service: McpService.getMcpServers called'.cyan.italic);

        const home: string = process.env.HOME || '~';
        const claudeConfigDir: string | undefined = getClaudeConfigDir();

        const primaryConfigPath: string = claudeConfigDir
            ? path.join(claudeConfigDir, '.claude.json')
            : path.join(home, '.claude.json');

        const servers: IMcpServerConfig[] = parseMcpServers(primaryConfigPath, 'user');

        if (claudeConfigDir) {
            const defaultConfigPath: string = path.join(home, '.claude.json');
            if (defaultConfigPath !== primaryConfigPath) {
                const defaultServers: IMcpServerConfig[] = parseMcpServers(defaultConfigPath, 'user');
                const existingNames: Set<string> = new Set(servers.map((s: IMcpServerConfig) => s.name));
                for (const server of defaultServers) {
                    if (!existingNames.has(server.name)) {
                        servers.push(server);
                    }
                }
            }
        }

        console.log('Service: McpService.getMcpServers resolved'.cyan, {count: servers.length});
        return {servers};
    }
}

export default McpService;
