import "colors";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import {Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import MessageModel from "../models/Message";
import {IExportManifest} from "../types/export";
import SessionModel, {ESessionSource} from "../models/Session";
import {CLAUDE_PROJECTS_DIR, NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import {IImportResult, IImportServiceParams, IJsonlLine} from "../types/import";

class ImportService {
    /**
     * Import a Claude Lens export ZIP into MongoDB and write .jsonl + .md files
     * back to ~/.claude/projects/ so Claude Code CLI can natively resume sessions.
     */
    static async importProject({zipBuffer, remappedProjectDir}: IImportServiceParams): Promise<IImportResult> {
        console.log('Service: ImportService.importProject called'.cyan.italic, {zipBuffer, remappedProjectDir});

        // --- 1. Parse ZIP ---
        const zip: AdmZip = new AdmZip(zipBuffer);
        const manifestEntry: AdmZip.IZipEntry | null = zip.getEntry('manifest.json');
        if (!manifestEntry) {
            throw new Error('Invalid Claude Lens backup: manifest.json missing!');
        }

        console.debug('DEBUG: Manifest found, parsing'.cyan);
        const manifest: IExportManifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
        console.log('Import: manifest parsed'.cyan, {
            projectDir: manifest.projectDir,
            totalSessions: manifest.totalSessions,
            totalMemoryFiles: manifest.totalMemoryFiles,
            totalTasks: manifest.totalTasks,
        });

        // --- 2. Resolve projectDir (use remapped if provided) ---
        const rawProjectDir: string = remappedProjectDir || manifest.projectDir;
        const projectDir: string = remappedProjectDir
            ? remappedProjectDir.replace(NON_ALPHANUMERIC_REGEX, '-')
            : manifest.claudeNativeFolderName;

        console.log('Import: resolved paths'.cyan, {rawProjectDir, projectDir});

        // --- 3. Ensure ~/.claude/projects/{projectDir}/ exists on disk ---
        const projectDiskDir: string = path.join(CLAUDE_PROJECTS_DIR, projectDir);
        const memoryDiskDir: string = path.join(projectDiskDir, 'memory');
        fs.mkdirSync(projectDiskDir, {recursive: true});
        fs.mkdirSync(memoryDiskDir, {recursive: true});

        // --- 4. Import sessions + messages from .jsonl files ---
        let totalMessages: number = 0;

        for (const sessionEntry of manifest.sessions) {
            const jsonlEntry = zip.getEntry(sessionEntry.file);
            if (!jsonlEntry) {
                console.warn(`Import: JSONL file not found in ZIP: ${sessionEntry.file}!`.yellow);
                continue;
            }

            const jsonlContent: string = jsonlEntry.getData().toString('utf-8');
            const lines: string[] = jsonlContent.split('\n').filter((line: string) => line.trim().length > 0);

            if (lines.length === 0) {
                console.warn(`Import: Empty JSONL file: ${sessionEntry.file}!`.yellow);
                continue;
            }

            // Parse first line to get session-level metadata
            const firstLine: IJsonlLine = JSON.parse(lines[0]);

            // Upsert Session document
            const session = await SessionModel.findOneAndUpdate(
                {sessionId: sessionEntry.sessionId},
                {
                    title: sessionEntry.title,
                    titleRenamed: sessionEntry.titleRenamed ?? false,
                    description: sessionEntry.description,
                    aiModel: sessionEntry.aiModel,
                    projectDir,
                    rawProjectDir,
                    gitBranch: sessionEntry.gitBranch ?? firstLine.gitBranch,
                    source: ESessionSource.TERMINAL,
                },
                {upsert: true, returnDocument: 'after'},
            );

            const sessionInternalId: Types.ObjectId = session._id as Types.ObjectId;

            // Find existing message UUIDs to avoid duplicates
            const existingDocs = await MessageModel.find(
                {sessionInternalId},
                {uuid: 1},
            ).lean();
            const existingUuids: Set<string> = new Set(
                existingDocs.map((document) => document.uuid as string),
            );

            // Parse and insert new messages.
            // Assistant JSONL lines lack a timestamp field and Claude CLI splits each content
            // block (thinking, text, tool_use) into a separate line sharing the same message.id.
            // We must: (a) derive timestamps from the last user message, (b) merge consecutive
            // assistant entries with the same message.id — mirroring parseJsonlFile's logic.
            const newMessages: Record<string, unknown>[] = [];
            let lastTimestamp: Date = new Date(firstLine.timestamp ?? Date.now());
            let lastAssistantMsgId: string | null = null;

            for (const line of lines) {
                const parsed: IJsonlLine = JSON.parse(line);
                if (existingUuids.has(parsed.uuid)) continue;

                const role: string = parsed.message.role;
                const timestamp: Date = parsed.timestamp
                    ? new Date(parsed.timestamp)
                    : lastTimestamp;
                if (parsed.timestamp) {
                    lastTimestamp = timestamp;
                }

                const msgId: string | undefined = parsed.message.id;

                // Merge consecutive assistant entries with the same message.id
                if (role === 'assistant' && msgId && msgId === lastAssistantMsgId && newMessages.length > 0) {
                    const lastMsg: Record<string, unknown> = newMessages[newMessages.length - 1];
                    if (Array.isArray(lastMsg.content) && Array.isArray(parsed.message.content)) {
                        (lastMsg.content as Record<string, unknown>[]).push(...parsed.message.content);
                        lastMsg.uuid = parsed.uuid;
                        lastMsg.timestamp = timestamp;
                        (lastMsg.rawLines as string[]).push(line);
                        continue;
                    }
                }

                newMessages.push({
                    uuid: parsed.uuid,
                    parentUuid: parsed.parentUuid ?? undefined,
                    sessionInternalId,
                    role,
                    content: parsed.message.content,
                    timestamp,
                    rawLines: [line],
                    ...(parsed.tokenUsage && {tokenUsage: parsed.tokenUsage}),
                });

                if (role === 'assistant') {
                    lastAssistantMsgId = msgId ?? null;
                } else {
                    lastAssistantMsgId = null;
                }
            }

            if (newMessages.length > 0) {
                await MessageModel.insertMany(newMessages, {ordered: false});
            }
            totalMessages += newMessages.length;
            console.debug('DEBUG: Session imported'.cyan, {sessionId: sessionEntry.sessionId, totalLines: lines.length, existingUuids: existingUuids.size, newMessages: newMessages.length});

            // Write .jsonl back to disk for Claude Code CLI resume
            const jsonlDiskPath: string = path.join(projectDiskDir, `${sessionEntry.sessionId}.jsonl`);
            fs.writeFileSync(jsonlDiskPath, jsonlContent, 'utf-8');
            console.log(`  Import: wrote ${sessionEntry.sessionId}.jsonl to disk!`.green);
        }

        // --- 5. Import memories (.md files) ---
        let totalMemoryFiles: number = 0;
        const memoryEntries: AdmZip.IZipEntry[] = zip.getEntries().filter((entry) => entry.entryName.startsWith('projects/memory/') && !entry.isDirectory);

        for (const memoryEntry of memoryEntries) {
            const content: string = memoryEntry.getData().toString('utf-8');
            // Extract relative path after 'projects/memory/'
            const relPath: string = memoryEntry.entryName.substring('projects/memory/'.length);

            // Use {projectDir, filePath: relPath} as upsert key — mirrors SyncService which stores
            // just the filename (not the full absolute path) to avoid duplicate docs across machines.
            await MemoryModel.findOneAndUpdate(
                {projectDir, filePath: relPath},
                {projectDir, filePath: relPath, content},
                {upsert: true},
            );

            // Write .md back to disk
            const diskPath: string = path.join(memoryDiskDir, relPath);
            const memoryFileDir: string = path.dirname(diskPath);
            fs.mkdirSync(memoryFileDir, {recursive: true});
            fs.writeFileSync(diskPath, content, 'utf-8');
            totalMemoryFiles++;
            console.log(`  Import: wrote memory/${relPath} to disk`.green);
        }

        // --- 6. Import tasks (.json files) ---
        let totalTasks: number = 0;
        const taskEntries: AdmZip.IZipEntry[] = zip.getEntries().filter((entry) => entry.entryName.startsWith('tasks/') && !entry.isDirectory);

        console.debug('DEBUG: Importing tasks'.cyan, {taskEntries: taskEntries.length});
        for (const taskEntry of taskEntries) {
            const taskData = JSON.parse(taskEntry.getData().toString('utf-8'));

            await TaskModel.findOneAndUpdate(
                {sessionId: taskData.sessionId, taskId: taskData.taskId},
                {
                    sessionId: taskData.sessionId,
                    taskId: taskData.taskId,
                    subject: taskData.subject,
                    description: taskData.description,
                    activeForm: taskData.activeForm,
                    status: taskData.status,
                    blocks: taskData.blocks ?? [],
                    blockedBy: taskData.blockedBy ?? [],
                },
                {upsert: true},
            );

            totalTasks++;
        }

        console.log('SUCCESS: Import completed'.bgGreen.bold, {
            sessions: manifest.sessions.length,
            messages: totalMessages,
            memories: totalMemoryFiles,
            tasks: totalTasks,
        });

        return {
            totalSessions: manifest.sessions.length,
            totalMessages,
            totalMemoryFiles,
            totalTasks,
        };
    }
}

export default ImportService;
