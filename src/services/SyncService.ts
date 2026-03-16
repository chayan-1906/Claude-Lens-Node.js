import "colors";
import fs from "fs";
import path from "path";
import {Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import MessageModel from "../models/Message";
import {findJsonlFiles} from "../utils/findJsonlFiles";
import {parseJsonlFile} from "../utils/parseJsonlFile";
import {NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import SessionModel, {ESessionSource} from "../models/Session";
import {ALL_SYNC_TARGETS, IParsedFile, IParsedMessage, ISyncMemoriesResponse, ISyncParams, ISyncResponse, ISyncTasksResponse, RawTask, SyncTarget} from "../types/sync";

// --- Constants ---

const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');
const CLAUDE_TASKS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'tasks');

class SyncService {
    /**
     * Main sync orchestrator — reads local Claude data and upserts to MongoDB
     * Replaces the standalone sync.ts script for use via API
     */
    static async sync({projectDirs, targets}: ISyncParams): Promise<ISyncResponse> {
        console.log('Service: SyncService.sync called'.cyan.italic, {targets});

        const activeTargets: SyncTarget[] = (targets && targets.length > 0) ? targets : ALL_SYNC_TARGETS;
        const result: ISyncResponse = {};
        console.debug('DEBUG: Active sync targets'.cyan, {activeTargets});

        // Resolve directories once — used by sessions, and to derive filters for tasks and memories
        const isFiltered: boolean = projectDirs !== undefined && projectDirs.length > 0;
        const directories: string[] = isFiltered
            ? SyncService.resolveProjectDirs(projectDirs!)
            : SyncService.getAllProjectDirs();
        console.debug('DEBUG: Resolved directories'.cyan, {isFiltered, count: directories.length});

        // Pre-compute JSONL file list if needed by sessions or task filtering
        const needsJsonlFiles: boolean = activeTargets.includes('sessions') || (isFiltered && activeTargets.includes('tasks'));
        const jsonlFiles: string[] = needsJsonlFiles ? findJsonlFiles(directories) : [];

        // Sync sessions (JSONL files → Session + Message documents)
        if (activeTargets.includes('sessions')) {
            console.log(`Sync: Found ${jsonlFiles.length} session file(s)`.cyan);

            let totalSynced: number = 0;
            let totalNew: number = 0;
            let totalSkipped: number = 0;
            let totalErrors: number = 0;

            for (const file of jsonlFiles) {
                const filename: string = path.basename(file);
                try {
                    const parsedFile: IParsedFile | null = parseJsonlFile(file);
                    if (!parsedFile) {
                        totalSkipped++;
                        continue;
                    }

                    const newCount: number = await SyncService.syncFile(parsedFile);
                    totalSynced++;
                    totalNew += newCount;

                    if (newCount > 0) {
                        console.log(`  Synced: ${filename} — ${newCount} new message(s)`.green);
                    }
                } catch (error: unknown) {
                    console.error(`Error: ${filename} — ${error}`.red);
                    totalErrors++;
                }
            }

            result.sessions = {synced: totalSynced, newMessages: totalNew, skipped: totalSkipped, errors: totalErrors};
        }

        // Sync tasks (~/.claude/tasks/ → Task documents)
        // When filtered, derive allowed sessionIds from the JSONL filenames in the selected projects
        if (activeTargets.includes('tasks')) {
            const allowedSessionIds: Set<string> | undefined = isFiltered
                ? new Set(jsonlFiles.map((file: string) => path.basename(file, '.jsonl')))
                : undefined;
            const taskResult: ISyncTasksResponse = await SyncService.syncTasks(allowedSessionIds);
            console.log(`Sync Tasks: new=${taskResult.synced}, updated=${taskResult.updated}`.cyan);
            result.tasks = taskResult;
        }

        // Sync memories (~/.claude/projects/*/memory/MEMORY.md → Memory documents)
        // When filtered, only sync memory from the selected project directories
        if (activeTargets.includes('memories')) {
            const memoryResult: ISyncMemoriesResponse = await SyncService.syncMemories(isFiltered ? directories : undefined);
            console.log(`Sync Memories: new=${memoryResult.synced}, updated=${memoryResult.updated}`.cyan);
            result.memories = memoryResult;
        }

        console.log('Service: SyncService.sync complete'.cyan.italic);

        return result;
    }

    /**
     * Get all project directories under ~/.claude/projects/
     */
    public static getAllProjectDirs(): string[] {
        if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
            return [];
        }

        const projects: string[] = fs.readdirSync(CLAUDE_PROJECTS_DIR, {withFileTypes: true})
            .filter((entry: fs.Dirent) => entry.isDirectory())
            .map((entry: fs.Dirent) => path.join(CLAUDE_PROJECTS_DIR, entry.name));
        console.debug('Projects:'.cyan, projects);
        return projects;
    }

    /**
     * Resolve user-provided paths to ~/.claude/projects/ directories
     * Accepts:
     *   - Folder names under ~/.claude/projects/ (e.g. "-Users-padmanabhadas-Chayan-Personal-NodeJs")
     *   - Real project paths (e.g. "/Users/padmanabhadas/Chayan_Personal/NodeJs") — converted to dash-name
     *   - Full absolute paths (e.g. "/Users/padmanabhadas/.claude/projects/-Users-...")
     */
    private static resolveProjectDirs(paths: string[]): string[] {
        const validPaths: string[] = [];

        for (const p of paths) {
            // 1. Try as folder name directly under ~/.claude/projects/
            const directPath: string = path.join(CLAUDE_PROJECTS_DIR, p);
            if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
                validPaths.push(directPath);
                continue;
            }

            // 2. Try converting real project path to dash-separated Claude directory name
            const claudeDirName: string = p.replace(NON_ALPHANUMERIC_REGEX, '-');
            const claudePath: string = path.join(CLAUDE_PROJECTS_DIR, claudeDirName);
            if (fs.existsSync(claudePath) && fs.statSync(claudePath).isDirectory()) {
                validPaths.push(claudePath);
                continue;
            }

            // 3. Try the path as-is (full absolute path)
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                validPaths.push(p);
                continue;
            }

            console.warn(`Sync: Skipping invalid path: ${p}`.yellow);
        }

        console.debug('DEBUG: Resolved project dirs'.cyan, {requested: paths.length, resolved: validPaths.length});
        return validPaths;
    }

    /**
     * Sync a single JSONL file to MongoDB
     * Upserts session, incrementally inserts only new messages
     */
    private static async syncFile(parsedFile: IParsedFile): Promise<number> {
        const session = await SessionModel.findOneAndUpdate(
            {sessionId: parsedFile.sessionId},
            {
                title: parsedFile.title,
                aiModel: parsedFile.aiModel,
                projectDir: parsedFile.projectDir,
                rawProjectDir: parsedFile.rawProjectDir,
                gitBranch: parsedFile.gitBranch,
                slug: parsedFile.slug,
                source: ESessionSource.WEBUI,
                contextTokensUsed: parsedFile.contextTokensUsed,
                contextWindowSize: 200000,
            },
            {upsert: true, returnDocument: 'after'},
        );

        const sessionInternalId: Types.ObjectId = session._id as Types.ObjectId;

        const existingDocs = await MessageModel.find(
            {sessionInternalId},
            {uuid: 1},
        ).lean();
        const existingUuids: Set<string> = new Set(
            existingDocs.map((document) => document.uuid as string)
        );

        console.debug('DEBUG: Deduplication check'.cyan, {sessionId: parsedFile.sessionId, totalMessages: parsedFile.messages.length, existingUuids: existingUuids.size});

        const newMessages = parsedFile.messages
            .filter((parsedMessage: IParsedMessage) => !existingUuids.has(parsedMessage.uuid))
            .map((parsedMessage: IParsedMessage) => ({
                uuid: parsedMessage.uuid,
                parentUuid: parsedMessage.parentUuid,
                sessionInternalId,
                role: parsedMessage.role,
                content: parsedMessage.content,
                aiModel: parsedMessage.aiModel,
                timestamp: parsedMessage.timestamp,
                tokenUsage: parsedMessage.tokenUsage,
            }));

        if (newMessages.length > 0) {
            await MessageModel.insertMany(newMessages, {ordered: false});
        }

        return newMessages.length;
    }

    /**
     * Sync tasks from ~/.claude/tasks/ to MongoDB
     * When allowedSessionIds is provided, only syncs tasks belonging to those sessions
     */
    private static async syncTasks(allowedSessionIds?: Set<string>): Promise<ISyncTasksResponse> {
        if (!fs.existsSync(CLAUDE_TASKS_DIR)) {
            console.debug('DEBUG: Tasks directory not found, skipping'.cyan, {path: CLAUDE_TASKS_DIR});
            return {synced: 0, updated: 0};
        }

        const sessionDirectories: fs.Dirent[] = fs.readdirSync(CLAUDE_TASKS_DIR, {withFileTypes: true})
            .filter((entry: fs.Dirent) => entry.isDirectory());
        console.debug('DEBUG: Task session directories found'.cyan, {count: sessionDirectories.length, filtered: !!allowedSessionIds});

        let synced: number = 0;
        let updated: number = 0;

        for (const sessionDirectory of sessionDirectories) {
            const sessionId: string = sessionDirectory.name;

            if (allowedSessionIds && !allowedSessionIds.has(sessionId)) {
                continue;
            }

            const sessionPath: string = path.join(CLAUDE_TASKS_DIR, sessionId);
            const taskFiles: string[] = fs.readdirSync(sessionPath)
                .filter((name: string) => name.endsWith('.json'));

            for (const taskFile of taskFiles) {
                try {
                    const raw: string = fs.readFileSync(path.join(sessionPath, taskFile), 'utf-8');
                    const task: RawTask = JSON.parse(raw) as RawTask;

                    const existing = await TaskModel.findOneAndUpdate(
                        {sessionId, taskId: task.id},
                        {
                            sessionId,
                            taskId: task.id,
                            subject: task.subject,
                            description: task.description,
                            activeForm: task.activeForm,
                            status: task.status,
                            blocks: task.blocks ?? [],
                            blockedBy: task.blockedBy ?? [],
                        },
                        {upsert: true, returnDocument: 'before'},
                    );

                    if (existing === null) {
                        synced++;
                    } else {
                        updated++;
                    }
                } catch (error: unknown) {
                    console.error(`Error: ${taskFile} (session: ${sessionId}) — ${error}`.red);
                }
            }
        }

        return {synced, updated};
    }

    /**
     * Sync all .md files from ~/.claude/projects/{project}/memory/ to MongoDB
     * When filteredDirs is provided, only syncs memory from those directories
     */
    private static async syncMemories(filteredDirs?: string[]): Promise<ISyncMemoriesResponse> {
        const dirs: string[] = filteredDirs ?? SyncService.getAllProjectDirs();
        console.debug('DEBUG: Syncing memories'.cyan, {directories: dirs.length, filtered: !!filteredDirs});

        let synced: number = 0;
        let updated: number = 0;

        for (const dir of dirs) {
            const projectDirName: string = path.basename(dir);
            const memoryDir: string = path.join(dir, 'memory');

            if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
                continue;
            }

            const mdFiles: string[] = fs.readdirSync(memoryDir)
                .filter((name: string) => name.endsWith('.md'));

            for (const mdFile of mdFiles) {
                const memoryFilePath: string = path.join(memoryDir, mdFile);

                try {
                    const content: string = fs.readFileSync(memoryFilePath, 'utf-8');

                    const existing = await MemoryModel.findOneAndUpdate(
                        {filePath: memoryFilePath},
                        {
                            projectDir: projectDirName,
                            filePath: memoryFilePath,
                            content,
                        },
                        {upsert: true, returnDocument: 'before'},
                    );

                    if (existing === null) {
                        synced++;
                    } else {
                        updated++;
                    }
                } catch (error: unknown) {
                    console.error(`Error: ${projectDirName}/memory/${mdFile} — ${error}`.red);
                }
            }
        }

        return {synced, updated};
    }
}

export default SyncService;
