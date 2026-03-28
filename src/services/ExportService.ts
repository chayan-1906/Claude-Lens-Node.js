import "colors";
import fs from "fs";
import path from "path";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import {APP_VERSION} from "../config/config";
import {CLAUDE_PROJECTS_DIR} from "../utils/constants";
import MessageModel, {IMessage} from "../models/Message";
import SessionModel, {ISession} from "../models/Session";
import {downloadJsonlBackup, uploadJsonlBackup} from "../utils/r2";
import {IExportManifest, IExportResult, IExportServiceParams, IManifestSessionEntry} from "../types/export";

/** Marker path segment used to extract relative memory file paths */
const MEMORY_PATH_MARKER: string = '/memory/';

/**
 * Parse raw JSONL content and build a UUID → rawLines map.
 * Replicates the merge logic from parseJsonlFile: consecutive assistant entries
 * with the same message.id are grouped under the last entry's UUID, matching
 * how SyncService stores merged messages in MongoDB.
 */
function buildRawLinesMap(jsonlContent: string): Map<string, string[]> {
    const lines: string[] = jsonlContent.split('\n');
    const result: Map<string, string[]> = new Map();
    let lastAssistantMsgId: string | null = null;
    let lastMergedUuid: string | null = null;

    for (const line of lines) {
        const trimmed: string = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }

        const lineType: string = parsed.type as string;
        if (lineType !== 'user' && lineType !== 'assistant') continue;

        const message: Record<string, unknown> | undefined = parsed.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const role: string = message.role as string;
        if (role !== 'user' && role !== 'assistant') continue;

        const uuid: string = parsed.uuid as string;
        const msgId: string | undefined = message.id as string | undefined;

        // Merge consecutive assistant entries with same message.id (mirrors parseJsonlFile)
        if (role === 'assistant' && msgId && msgId === lastAssistantMsgId && lastMergedUuid) {
            const existing: string[] | undefined = result.get(lastMergedUuid);
            if (existing) {
                existing.push(line);
                // Re-key from old UUID to new UUID (last entry wins)
                result.delete(lastMergedUuid);
                result.set(uuid, existing);
                lastMergedUuid = uuid;
                continue;
            }
        }

        result.set(uuid, [line]);

        if (role === 'assistant') {
            lastAssistantMsgId = msgId ?? null;
            lastMergedUuid = uuid;
        } else {
            lastAssistantMsgId = null;
            lastMergedUuid = null;
        }
    }

    return result;
}

/**
 * Build a fallback rawLines map for messages that lack rawLines in MongoDB.
 *
 * JSONL source priority chain (most → least faithful):
 *   1. rawLines from MongoDB  — handled inline in exportProject, not here
 *   2. On-disk JSONL file     — ~/.claude/projects/{projectDir}/{sessionId}.jsonl
 *   3. R2 JSONL backup        — cloud backup from a previous sync/export
 *   4. Reconstruction         — last resort, lossy (parallel tool_use blocks lost)
 */
async function buildFallbackRawLinesMap(session: ISession): Promise<Map<string, string[]>> {
    // Priority 2: on-disk JSONL
    const jsonlPath: string = path.join(CLAUDE_PROJECTS_DIR, session.projectDir, `${session.sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
        try {
            const content: string = fs.readFileSync(jsonlPath, 'utf-8');
            const map: Map<string, string[]> = buildRawLinesMap(content);
            if (map.size > 0) {
                console.log(`Export: Loaded ${map.size} message(s) from on-disk JSONL`.cyan);
                return map;
            }
        } catch (err: unknown) {
            console.warn(`Export: Failed to read on-disk JSONL — ${err}`.yellow);
        }
    }

    // Priority 3: R2 JSONL backup
    const r2Content: string | null = await downloadJsonlBackup(session.sessionId);
    if (r2Content) {
        const map: Map<string, string[]> = buildRawLinesMap(r2Content);
        if (map.size > 0) {
            console.log(`Export: Loaded ${map.size} message(s) from R2 backup`.cyan);
            return map;
        }
    }

    return new Map();
}

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

            // Build fallback map only if any message lacks rawLines.
            // This avoids unnecessary disk/R2 reads when all messages have rawLines.
            const needsFallback: boolean = messages.some((m: IMessage) => !m.rawLines || m.rawLines.length === 0);
            const fallbackMap: Map<string, string[]> = needsFallback
                ? await buildFallbackRawLinesMap(session)
                : new Map();

            /*
             * JSONL source priority chain (per message):
             *   1. rawLines from MongoDB  — lossless original JSONL lines stored during sync
             *   2. On-disk / R2 fallback  — parsed via buildRawLinesMap with merge logic
             *   3. Reconstruction         — last resort, LOSSY: parallel tool_use blocks
             *                               from merged assistant messages may be lost,
             *                               causing "tool use concurrency" 400 errors
             *                               when Claude Code resumes the session
             */
            const jsonlLines: string[] = messages.flatMap((message: IMessage) => {
                // Priority 1: rawLines from MongoDB
                if (message.rawLines && message.rawLines.length > 0) {
                    return message.rawLines;
                }
                // Priority 2/3: rawLines from on-disk JSONL or R2 backup
                const fallbackLines: string[] | undefined = fallbackMap.get(message.uuid);
                if (fallbackLines && fallbackLines.length > 0) {
                    return fallbackLines;
                }
                // Priority 4: reconstruct from structured data (lossy)
                return [JSON.stringify({
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
                })];
            });

            console.debug('DEBUG: Session JSONL built'.cyan, {sessionId: session.sessionId, messages: messages.length});
            const jsonlContent: string = jsonlLines.join('\n');
            archive.append(jsonlContent, {name: `projects/${session.sessionId}.jsonl`});

            // Best-effort R2 backup on export (fire-and-forget)
            uploadJsonlBackup(session.sessionId, jsonlContent).catch(() => {
            });

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
        console.debug('DEBUG: Manifest written'.cyan, {projectDir, totalSessions: sessions.length, totalMemoryFiles: memories.length, totalTasks: tasks.length});

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
