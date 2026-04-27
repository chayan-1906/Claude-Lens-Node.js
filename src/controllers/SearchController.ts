import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import SearchService from "../services/SearchService";
import {ISearchQuery, TSearchScope, VALID_SCOPES} from "../types/search";

const searchController = async (req: Request, res: Response): Promise<void> => {
    console.info('Controller: searchController started'.bgBlue.white.bold);

    try {
        const {q, scope, sessionId, projectDir} = req.query as Record<string, string | undefined>;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const skip = Math.max(0, parseInt(req.query.skip as string) || 0);

        if (!q || q.trim().length < 2) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'INVALID_QUERY',
                errorMsg: 'q must be at least 2 characters!',
            }));
            return;
        }

        if (!scope || !VALID_SCOPES.includes(scope as TSearchScope)) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'INVALID_SCOPE',
                errorMsg: `scope must be one of: ${VALID_SCOPES.join(', ')}!`,
            }));
            return;
        }

        if (scope === 'session' && !sessionId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'MISSING_SESSION_ID',
                errorMsg: 'sessionId is required when scope is "session"!',
            }));
            return;
        }

        if (scope === 'project' && !projectDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'MISSING_PROJECT_DIR',
                errorMsg: 'projectDir is required when scope is "project"!',
            }));
            return;
        }

        const query: ISearchQuery = {
            q: q.trim(),
            scope: scope as TSearchScope,
            sessionId,
            projectDir,
            limit,
            skip,
        };

        const results = await SearchService.search(query);
        const totalCount = results.messages.length + results.sessions.length + results.tasks.length + results.memories.length;

        console.log('SUCCESS: Search completed'.bgGreen.bold, {q, scope, totalCount});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Search completed',
            results,
            totalCount,
        }));
    } catch (error: any) {
        console.error('Controller Error: searchController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong during search!',
        }));
    }
};

export {searchController};