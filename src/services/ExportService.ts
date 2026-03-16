import "colors";
import path from "path";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import {APP_VERSION} from "../config/config";
import MessageModel, {IMessage} from "../models/Message";
import SessionModel, {ISession} from "../models/Session";
import {IExportManifest, IExportResult, IExportServiceParams, IManifestSessionEntry} from "../types/export";

/** Marker path segment used to extract relative memory file paths */
const MEMORY_PATH_MARKER: string = '/memory/';

class ExportService {
    /**
     * Assemble a ZIP export for a project (all sessions) or a single session.
     * Appends sessions (.jsonl), memories (.md), tasks (.json), and manifest.json
     * to the provided archiver instance, then finalizes the archive.
     */
    static async exportProject({projectDir, rawProjectDir, sessionId, archive}: IExportServiceParams): Promise<IExportResult> {
        console.log('Service: ExportService.exportProject called'.cyan.italic, {projectDir, sessionId: sessionId ?? 'all'});

        // --- 1. Fetch session(s) ---
        const sessionFilter: Record<string, string> = {projectDir};
        if (sessionId) {
            sessionFilter.sessionId = sessionId;
        }
        const sessions: ISession[] = await SessionModel.find(sessionFilter);
        console.log(`Export: Found ${sessions.length} session(s)`.cyan);

        // --- 2. Build .jsonl files (one per session) ---
        const sessionIndex: IManifestSessionEntry[] = [];

        for (const session of sessions) {
            const messages: IMessage[] = await MessageModel.find(
                {sessionInternalId: session._id},
                null,
                {sort: {timestamp: 1}},
            );

            const jsonlLines: string[] = messages.map((message: IMessage) => JSON.stringify({
                type: message.role === 'user' ? 'user' : 'assistant',
                parentUuid: message.parentUuid ?? null,
                isSidechain: false,
                message: {role: message.role, content: message.content},
                uuid: message.uuid,
                timestamp: message.timestamp,
                sessionId: session.sessionId,
                cwd: session.rawProjectDir,
                gitBranch: session.gitBranch ?? 'HEAD',
                userType: 'external',
                version: 1,
                ...(message.tokenUsage && {tokenUsage: message.tokenUsage}),
            }));

            const jsonlContent: string = jsonlLines.join('\n');
            archive.append(jsonlContent, {name: `projects/${session.sessionId}.jsonl`});

            sessionIndex.push({
                sessionId: session.sessionId,
                title: session.title,
                aiModel: session.aiModel,
                gitBranch: session.gitBranch,
                file: `projects/${session.sessionId}.jsonl`,
            });
        }

        // --- 3. Fetch and append memories (.md) — always all for projectDir ---
        const memories = await MemoryModel.find({projectDir});
        console.log(`Export: Found ${memories.length} memory file(s)`.cyan);

        for (const memory of memories) {
            const markerIndex: number = memory.filePath.lastIndexOf(MEMORY_PATH_MARKER);
            const relPath: string = markerIndex >= 0
                ? memory.filePath.substring(markerIndex + MEMORY_PATH_MARKER.length)
                : path.basename(memory.filePath);
            archive.append(memory.content, {name: `projects/memory/${relPath}`});
        }

        // --- 4. Fetch and append tasks (.json) — scoped to exported sessions ---
        const sessionIds: string[] = sessions.map((s: ISession) => s.sessionId);
        const tasks = await TaskModel.find({sessionId: {$in: sessionIds}});
        console.log(`Export: Found ${tasks.length} task(s)`.cyan);

        for (const task of tasks) {
            const taskObj = task.toObject();
            const {_id, __v, ...cleanTask} = taskObj;
            archive.append(
                JSON.stringify(cleanTask, null, 2),
                {name: `tasks/${task.sessionId}-${task.taskId}.json`},
            );
        }

        // --- 5. Build and append manifest.json ---
        const manifest: IExportManifest = {
            exportedAt: new Date().toISOString(),
            claudeLensVersion: APP_VERSION ?? '1.0.0',
            projectDir: rawProjectDir,
            claudeNativeFolderName: projectDir,
            totalSessions: sessions.length,
            totalMemoryFiles: memories.length,
            totalTasks: tasks.length,
            sessions: sessionIndex,
        };

        archive.append(JSON.stringify(manifest, null, 2), {name: 'manifest.json'});

        // --- 6. Finalize the archive ---
        await archive.finalize();

        console.log('SUCCESS: Export archive finalized'.bgGreen.bold, {
            sessions: sessions.length,
            memories: memories.length,
            tasks: tasks.length,
        });

        return {
            totalSessions: sessions.length,
            totalMemoryFiles: memories.length,
            totalTasks: tasks.length,
        };
    }
}

export default ExportService;
