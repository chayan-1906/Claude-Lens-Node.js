import "colors";
import archiver from "archiver";
import {Request, Response} from "express";
import {IExportParams} from "../types/export";
import {ApiResponse} from "../utils/ApiResponse";
import ExportService from "../services/ExportService";
import SessionModel, {ISession} from "../models/Session";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const exportProjectController = async (req: Request, res: Response) => {
    console.info('Controller: exportProjectController started'.bgBlue.white.bold);

    try {
        const {projectDir}: Partial<IExportParams> = req.params;
        const sessionId: string | undefined = req.query.sessionId as string | undefined;

        // --- Validate projectDir ---
        if (!projectDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('projectDir'),
                errorMsg: 'projectDir is required!',
            }));
            return;
        }

        // --- Resolve rawProjectDir from any session in this project ---
        const session: ISession | null = await SessionModel.findOne({projectDir}, {rawProjectDir: 1}).lean();
        if (!session) {
            res.status(404).send(new ApiResponse({
                success: false,
                errorCode: generateNotFoundCode('project'),
                errorMsg: `No sessions found for projectDir: ${projectDir}!`,
            }));
            return;
        }
        const rawProjectDir: string = session.rawProjectDir;

        // --- If sessionId provided, verify it belongs to this project ---
        if (sessionId) {
            const sessionExists: ISession | null = await SessionModel.findOne({sessionId, projectDir}).lean();
            if (!sessionExists) {
                res.status(404).send(new ApiResponse({
                    success: false,
                    errorCode: generateNotFoundCode('session'),
                    errorMsg: `No session found with sessionId: ${sessionId} in projectDir: ${projectDir}!`,
                }));
                return;
            }
        }

        // --- Build filename and set response headers ---
        const slug: string = rawProjectDir.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
        const ts: string = new Date().toISOString().replace(/[:.]/g, '-');
        const filename: string = `claude-lens-export-${slug}-${ts}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        // --- Create archive and pipe to response ---
        const archive: archiver.Archiver = archiver('zip', {zlib: {level: 9}});

        archive.on('error', (error: Error) => {
            console.error('Archive Error: ZIP creation failed'.red.bold, error);
            // If headers already sent, we can only destroy the stream
            if (!res.headersSent) {
                res.status(500).send(new ApiResponse({
                    success: false,
                    errorMsg: 'Failed to create ZIP archive!',
                }));
            } else {
                res.destroy();
            }
        });

        archive.pipe(res);

        // --- Delegate ZIP assembly to service ---
        const {totalSessions, totalMemoryFiles, totalTasks, error} = await ExportService.exportProject({projectDir, rawProjectDir, sessionId, archive});

        console.log('SUCCESS: Export streamed'.bgGreen.bold, {projectDir, sessionId: sessionId ?? 'all', totalSessions, totalMemoryFiles, totalTasks});
    } catch (error: any) {
        console.error('Controller Error: exportProjectController failed'.red.bold, error);
        if (!res.headersSent) {
            res.status(500).send(new ApiResponse({
                success: false,
                errorMsg: error.message || 'Something went wrong while exporting the project!',
            }));
        } else {
            res.destroy();
        }
    }
}

export {exportProjectController};
