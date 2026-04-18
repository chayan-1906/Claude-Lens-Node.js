import "colors";
import {Request, Response} from "express";
import McpService from "../services/McpService";
import {ApiResponse} from "../utils/ApiResponse";

const getMcpServersController = async (req: Request, res: Response) => {
    console.info('Controller: getMcpServersController started'.bgBlue.white.bold);

    try {
        const {servers, error} = await McpService.getMcpServers();

        if (error || !servers) {
            console.warn('WARN: McpService.getMcpServers returned error'.yellow.bold, {error});
            res.status(500).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg: 'Failed to retrieve MCP servers!',
            }));
            return;
        }

        console.log('SUCCESS: MCP servers fetched'.bgGreen.bold, {count: servers.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'MCP servers have been fetched!',
            servers,
        }));
    } catch (error: any) {
        console.error('Controller Error: getMcpServersController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving MCP servers!',
        }));
    }
};

export {getMcpServersController};
