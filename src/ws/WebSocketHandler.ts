import "colors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {Types} from "mongoose";
import {ChildProcess} from "child_process";
import {WebSocket, WebSocketServer} from "ws";
import {IncomingMessage, Server as HttpServer} from "http";
import TaskModel from "../models/Task";
import {IdeService} from "./IdeService";
import MemoryModel from "../models/Memory";
import ProjectModel from "../models/Project";
import SyncService from "../services/SyncService";
import SessionService from "../services/SessionService";
import * as pendingAttachments from "../utils/pendingAttachments";
import {addToolToProjectAllowList} from "../permissions/allowList";
import SessionLineModel, {ISessionLine} from "../models/SessionLine";
import {CRLF_REGEX, TRAILING_SLASHES_REGEX} from "../utils/constants";
import MessageModel, {EMessageRole, IMessage} from "../models/Message";
import SessionModel, {ESessionSource, ISession} from "../models/Session";
import {sendMessage, spawnClaude, toContextNdjson} from "./claudeSpawner";
import {buildContentBlocks, downloadJsonlBackup, uploadJsonlBackup} from "../utils/r2";
import {buildLosslessMongoJsonlLines, canBuildLosslessMongoJsonl} from "../utils/sessionJsonl";
import {resolveCanonicalPath, resolveLocalPath, resolveProjectDirHash, toProjectDirHash} from "../utils/resolveProjectDir";
import {addSessionAllowAll, cleanupSession, getPendingApprovalMeta, initSessionAllowAll, registerIdeOpenDiffHook, registerSession, resolveApproval, setSessionProjectDir} from "./toolApprovalStore";
import {
    ClientMessage,
    IAttachmentMeta,
    IEditSessionMessage,
    INewSessionMessage,
    IPendingApprovalMeta,
    IProjectNotAvailableMessage,
    IResumeSessionMessage,
    ISendMessageMessage,
    ISwitchModelMessage,
    IToolApprovalResponseMessage,
} from "../types/ws";

/**
 * Check if the local JSONL session file exists for the given projectDir + sessionId.
 * Claude stores sessions at ~/.claude/projects/{projectDirHash}/{sessionId}.jsonl
 * where projectDirHash replaces all non-alphanumeric chars with '-'.
 */
function isLocalSessionAvailable(projectDirHash: string, sessionId: string): boolean {
    if (!projectDirHash) {
        console.warn(`WebSocket: [TRACE] isLocalSessionAvailable — empty projectDirHash, root-level session files are not valid project sessions → false`.yellow);
        return false;
    }

    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);

    console.log(`WebSocket: [TRACE] isLocalSessionAvailable — checking: ${jsonlPath}`.cyan);

    if (!fs.existsSync(jsonlPath)) {
        console.log(`WebSocket: [TRACE] isLocalSessionAvailable — file NOT found → false`.cyan);
        return false;
    }

    // Validate: if any user/assistant message has empty content, the JSONL is broken.
    // Claude exits with code 1 on resume when it encounters content: [] in the session.
    // Also: a JSONL with only metadata (e.g. last-prompt) and no user/assistant entries
    // is effectively empty — Claude CLI writes last-prompt on every run, even failed ones.
    // Return false so the caller falls back to reconstructing from MongoDB.
    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        console.log(`WebSocket: [TRACE] isLocalSessionAvailable — file found, validating ${lines.length} lines`.cyan);
        let hasConversationEntry: boolean = false;
        for (const line of lines) {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === 'user' || entry.type === 'assistant') {
                hasConversationEntry = true;
                const content = (entry.message as Record<string, unknown>)?.content;
                const contentSummary: string = !content ? 'null/undefined'
                    : Array.isArray(content) ? `ContentBlock[${(content as unknown[]).length}]`
                        : `string(${String(content).length})`;
                console.log(`WebSocket: [TRACE] isLocalSessionAvailable — type=${entry.type} content=${contentSummary}`.cyan);
                if (!content || (Array.isArray(content) && (content as unknown[]).length === 0)) {
                    console.warn(`WebSocket: [TRACE] isLocalSessionAvailable — BROKEN (empty content for ${entry.type}) → false`.yellow);
                    return false;
                }
            }
        }

        if (!hasConversationEntry) {
            console.warn(`WebSocket: [TRACE] isLocalSessionAvailable — BROKEN (no user/assistant entries, only metadata) → false`.yellow);
            return false;
        }
    } catch (err) {
        console.error(`WebSocket: [TRACE] isLocalSessionAvailable — parse error: ${err} → false`.red);
        return false;
    }

    console.log(`WebSocket: [TRACE] isLocalSessionAvailable — VALID → true`.cyan);
    return true;
}

/**
 * Repair a local JSONL session file by stripping trailing orphaned tool_use entries.
 * The Anthropic API returns 400 if the conversation history has tool_use blocks in an
 * assistant message without a matching tool_result in the next user message.
 * This happens when a session is interrupted mid-tool-call (e.g. force quit, tab close).
 *
 * Strategy: walk backwards from the end of the JSONL. If the last user/assistant entry
 * is an assistant message whose content ends with tool_use blocks (no following tool_result),
 * remove it. Repeat until the history ends cleanly.
 */
function repairOrphanedToolUse(projectDirHash: string, sessionId: string): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);

    if (!fs.existsSync(jsonlPath)) return;

    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        let trimCount: number = 0;

        // Walk backwards: remove trailing incomplete-turn entries so the session ends cleanly.
        // Three patterns are handled, and they can alternate (the loop removes all until stable):
        //
        //   A) Trailing metadata entries (last-prompt, queue-operation) — these are bookkeeping
        //      lines written after the last real conversation entry. They are safe to skip so
        //      the repair can reach the actual conversation entries beneath them. A last-prompt
        //      entry is commonly written AFTER an interrupted streaming response, which would
        //      otherwise cause the backward walk to stop prematurely.
        //
        //   B) Trailing assistant entry whose message.stop_reason is null — these are raw
        //      NDJSON-format chunks captured mid-stream before the response was finalized.
        //      They use snake_case session_id, lack parentUuid/cwd/sessionId, and are
        //      structurally different from normal JSONL entries. The Claude CLI rejects the
        //      entire session with "No conversation found" when these are present.
        //
        //   C) Trailing assistant entry that ends with tool_use blocks but has no following
        //      user entry with tool_result — the tool was never executed.
        //
        //   D) Trailing user entry that contains ONLY tool_result blocks but has no following
        //      assistant response — the tool returned its result but Claude never replied.
        //      This is the case that triggers the "Continue from where you left off." synthetic
        //      turn on --resume. Removing it eliminates the synthetic turn entirely.
        //
        // By handling all patterns in a single loop, chains like A→B→C→D are resolved in one pass.
        while (lines.length > 0) {
            const lastLine: string = lines[lines.length - 1];
            const entry = JSON.parse(lastLine) as Record<string, unknown>;
            const message = entry.message as Record<string, unknown> | undefined;
            const content = message?.content;

            // Pattern A: Skip trailing metadata entries so the repair reaches conversation entries
            if (entry.type === 'last-prompt' || entry.type === 'queue-operation') {
                lines.pop();
                trimCount++;
                console.log(`WebSocket: [REPAIR] Removed trailing metadata entry (type: ${entry.type}, trimCount: ${trimCount})`.yellow);
                continue;
            }

            if (entry.type === 'assistant') {
                // Pattern B: Incomplete streaming entry — stop_reason is null, meaning the
                // assistant response was interrupted mid-stream and never finalized. The Claude
                // CLI rejects the session on --resume when these raw NDJSON-format chunks are present.
                if (message?.stop_reason === null) {
                    lines.pop();
                    trimCount++;
                    console.log(`WebSocket: [REPAIR] Removed incomplete streaming assistant entry (stop_reason: null, trimCount: ${trimCount})`.yellow);
                    continue;
                }
                // Pattern C: Orphaned tool_use (no following tool_result)
                if (!Array.isArray(content)) break;
                const hasToolUse: boolean = (content as Record<string, unknown>[]).some(
                    (block: Record<string, unknown>) => block.type === 'tool_use',
                );
                if (!hasToolUse) break;
                lines.pop();
                trimCount++;
                console.log(`WebSocket: [REPAIR] Removed orphaned tool_use assistant entry (trimCount: ${trimCount})`.yellow);
            } else if (entry.type === 'user') {
                // Pattern D: Orphaned tool_result (no following assistant response)
                if (!Array.isArray(content) || content.length === 0) break;
                const hasOnlyToolResults: boolean = (content as Record<string, unknown>[]).every(
                    (block: Record<string, unknown>) => block.type === 'tool_result',
                );
                if (!hasOnlyToolResults) break;
                lines.pop();
                trimCount++;
                console.log(`WebSocket: [REPAIR] Removed orphaned tool_result user entry (trimCount: ${trimCount})`.yellow);
            } else {
                break;
            }
        }

        if (trimCount > 0) {
            fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
            console.log(`WebSocket: [REPAIR] Repaired JSONL — removed ${trimCount} trailing orphaned tool entries from ${jsonlPath}`.yellow);
        }
    } catch (err) {
        console.error(`WebSocket: [REPAIR] Failed to repair JSONL — ${err}`.red);
    }
}

/**
 * Read the first 'cwd' field found in a JSONL session file.
 * Used to detect a mismatch between the path encoded into each JSONL line (from the
 * original session) and the rawProjectDir the file was imported under. When they
 * differ the Claude CLI rejects the session on --resume even though the file exists.
 * Returns null if the file is missing or contains no cwd field.
 */
function readJsonlCwd(projectDirHash: string, sessionId: string): string | null {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
        return null;
    }
    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (typeof entry.cwd === 'string') return entry.cwd;
        }
    } catch {
    }
    return null;
}

/**
 * Patch every line in a JSONL session file that contains a 'cwd' field, replacing its
 * value with newCwd. Used after detecting a cwd mismatch (readJsonlCwd vs rawProjectDir).
 * Only rewrites the file if at least one line was actually changed.
 * Safe to call on a valid JSONL — only the metadata 'cwd' field is touched; conversation
 * content is untouched.
 */
function patchJsonlCwd(projectDirHash: string, sessionId: string, newCwd: string): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);
    try {
        const raw: string = fs.readFileSync(jsonlPath, 'utf-8');
        const lines: string[] = raw.split('\n');
        let patchedCount: number = 0;
        const patched: string[] = lines.map((line: string) => {
            if (!line.trim()) {
                return line;
            }
            try {
                const entry = JSON.parse(line) as Record<string, unknown>;
                if (typeof entry.cwd === 'string' && entry.cwd !== newCwd) {
                    entry.cwd = newCwd;
                    patchedCount++;
                    return JSON.stringify(entry);
                }
            } catch {
            }
            return line;
        });
        if (patchedCount > 0) {
            fs.writeFileSync(jsonlPath, patched.join('\n'), 'utf-8');
            console.log(`WebSocket: [CWD-PATCH] Patched ${patchedCount} line(s) — cwd updated to: "${newCwd}"`.yellow);
        } else {
            console.log('WebSocket: [CWD-PATCH] No lines needed patching'.gray);
        }
    } catch (error: unknown) {
        console.error(`WebSocket: [CWD-PATCH] Failed to patch JSONL cwd — ${error}`.red);
    }
}

/**
 * Reconstruct a Claude session JSONL file from MongoDB data and write it to
 * ~/.claude/projects/{session.projectDir}/{session.sessionId}.jsonl.
 * Creates the directory if it doesn't exist.
 * Note: tool_use/tool_result blocks and thinking blocks may be absent
 * if they were stripped during the original sync.
 */
function reconstructAndSaveJsonl(session: ISession, messages: IMessage[], localProjectDirHash?: string, localRawProjectDir?: string): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const effectiveHash: string = localProjectDirHash ?? session.projectDir;
    const effectiveCwd: string = localRawProjectDir ?? session.rawProjectDir;
    const sessionDir: string = path.join(claudeProjectsDir, effectiveHash);
    const jsonlPath: string = path.join(sessionDir, `${session.sessionId}.jsonl`);

    fs.mkdirSync(sessionDir, {recursive: true});

    // Normalize: Mongoose documents have schema-defined getters, not own enumerable
    // properties. Spreading them ({...msg}) loses role, uuid, etc. Convert to plain
    // objects up front so all downstream operations (filter, spread, merge) work safely.
    const plain: IMessage[] = messages.map((m: IMessage) => ({
        role: m.role,
        uuid: m.uuid,
        parentUuid: m.parentUuid,
        content: m.content,
        timestamp: m.timestamp,
        aiModel: m.aiModel,
    } as IMessage));

    // Step 1: Filter out messages with empty content (stripped thinking/tool blocks)
    const filtered: IMessage[] = plain.filter((message: IMessage) => {
        const content = message.content;
        if (Array.isArray(content) && content.length === 0) {
            console.warn(`WebSocket: [RECONSTRUCT] Skipping ${message.role} message (uuid: ${message.uuid}) — empty content array`.yellow);
            return false;
        }
        return true;
    });

    // Step 2: Collect all tool_use IDs present in assistant messages
    const toolUseIds: Set<string> = new Set();
    for (const message of filtered) {
        if (message.role === 'assistant' && Array.isArray(message.content)) {
            for (const block of message.content as Record<string, unknown>[]) {
                if (block.type === 'tool_use' && typeof block.id === 'string') {
                    toolUseIds.add(block.id);
                }
            }
        }
    }

    // Step 3: Strip orphaned tool_result blocks (reference tool_use IDs that were stripped)
    // and remove user messages that become empty after stripping
    const cleaned: IMessage[] = [];
    for (const message of filtered) {
        if (message.role === 'user' && Array.isArray(message.content)) {
            const blocks = (message.content as Record<string, unknown>[]).filter((block: Record<string, unknown>) => {
                if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                    if (!toolUseIds.has(block.tool_use_id)) {
                        console.warn(`WebSocket: [RECONSTRUCT] Stripping orphaned tool_result (tool_use_id: ${block.tool_use_id}) from user message (uuid: ${message.uuid})`.yellow);
                        return false;
                    }
                }
                return true;
            });
            if (blocks.length === 0) {
                console.warn(`WebSocket: [RECONSTRUCT] Removing user message (uuid: ${message.uuid}) — all content was orphaned tool_results`.yellow);
                continue;
            }
            cleaned.push({...message, content: blocks} as IMessage);
        } else {
            cleaned.push(message);
        }
    }

    // Step 3.5: Strip orphaned tool_use blocks from assistant messages — the mirror of Step 3.
    // An assistant tool_use block without a matching tool_result in the IMMEDIATELY FOLLOWING
    // user message causes the Anthropic API to return 400 ("tool use concurrency issues").
    // Uses positional pairing instead of a global set to match the API's per-turn adjacency requirement.
    const repaired: IMessage[] = [];
    for (let i = 0; i < cleaned.length; i++) {
        const message: IMessage = cleaned[i];
        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const thisToolUseIds: Set<string> = new Set(
                (message.content as Record<string, unknown>[])
                    .filter((b: Record<string, unknown>) => b.type === 'tool_use' && typeof b.id === 'string')
                    .map((b: Record<string, unknown>) => b.id as string),
            );

            if (thisToolUseIds.size > 0) {
                // Find the immediately following user message — forward scan, no slice allocation
                let nextUser: IMessage | undefined;
                for (let j = i + 1; j < cleaned.length; j++) {
                    if (cleaned[j].role === 'user') {
                        nextUser = cleaned[j];
                        break;
                    }
                }
                const nextUserToolResultIds: Set<string> = new Set(
                    nextUser && Array.isArray(nextUser.content)
                        ? (nextUser.content as Record<string, unknown>[])
                            .filter((b: Record<string, unknown>) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
                            .map((b: Record<string, unknown>) => b.tool_use_id as string)
                        : [],
                );

                const blocks: Record<string, unknown>[] = (message.content as Record<string, unknown>[]).filter(
                    (block: Record<string, unknown>) => {
                        if (block.type === 'tool_use' && typeof block.id === 'string') {
                            if (!nextUserToolResultIds.has(block.id)) {
                                console.warn(
                                    `WebSocket: [RECONSTRUCT] Stripping orphaned tool_use (id: ${block.id}) from assistant message (uuid: ${message.uuid}) — no matching tool_result in next user message`.yellow,
                                );
                                return false;
                            }
                        }
                        return true;
                    },
                );

                if (blocks.length === 0) {
                    console.warn(
                        `WebSocket: [RECONSTRUCT] Removing assistant message (uuid: ${message.uuid}) — all content was orphaned tool_use`.yellow,
                    );
                    continue;
                }
                repaired.push({...message, content: blocks} as IMessage);
            } else {
                repaired.push(message);
            }
        } else {
            repaired.push(message);
        }
    }

    // Step 4: Merge consecutive same-role messages to maintain valid alternation.
    // Filtering empty-content messages can leave consecutive user or assistant entries
    // which the Anthropic API rejects with 400.
    const merged: IMessage[] = [];
    for (const message of repaired) {
        const prev: IMessage | undefined = merged[merged.length - 1];
        if (prev && prev.role === message.role) {
            console.warn(`WebSocket: [RECONSTRUCT] Merging consecutive ${message.role} message (uuid: ${message.uuid}) into previous (uuid: ${prev.uuid})`.yellow);
            // Normalize both to ContentBlock[] and concatenate
            const prevContent: Record<string, unknown>[] = typeof prev.content === 'string'
                ? [{type: 'text', text: prev.content}]
                : prev.content as Record<string, unknown>[];
            const curContent: Record<string, unknown>[] = typeof message.content === 'string'
                ? [{type: 'text', text: message.content}]
                : message.content as Record<string, unknown>[];
            (prev as unknown as Record<string, unknown>).content = [...prevContent, ...curContent];
        } else {
            merged.push(message);
        }
    }

    console.log(`WebSocket: [RECONSTRUCT] Pipeline: ${messages.length} raw → ${filtered.length} filtered → ${cleaned.length} cleaned → ${repaired.length} repaired → ${merged.length} merged`.cyan);

    const lines: string[] = merged
        .map((message: IMessage) => JSON.stringify({
            type: message.role,
            uuid: message.uuid,
            parentUuid: message.parentUuid ?? null,
            sessionId: session.sessionId,
            timestamp: message.timestamp ? (message.timestamp as Date).toISOString() : new Date().toISOString(),
            cwd: effectiveCwd,
            message: {
                role: message.role,
                content: message.content,
                ...(message.aiModel ? {model: message.aiModel} : {}),
            },
        }));

    if (lines.length === 0) {
        console.warn(`WebSocket: [TRACE] reconstructAndSaveJsonl — 0 lines after filter (all messages had empty content?), writing empty JSONL`.yellow);
    }

    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`WebSocket: Reconstructed session JSONL at ${jsonlPath} (${lines.length} messages)`.cyan);
    console.log(`WebSocket: [TRACE] reconstructAndSaveJsonl — written to: ${jsonlPath}, rawProjectDir: ${session.rawProjectDir}`.cyan);
}

/**
 * Restore a Claude session JSONL file from raw lines + SessionLine records stored in MongoDB.
 * This is a lossless restoration — the original JSONL bytes are preserved exactly,
 * unlike reconstructAndSaveJsonl() which reverse-engineers the format from structured data.
 */
function rawLineRestoreJsonl(session: ISession, messages: IMessage[], sessionLines: ISessionLine[], localProjectDirHash?: string): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const effectiveHash: string = localProjectDirHash ?? session.projectDir;
    const sessionDir: string = path.join(claudeProjectsDir, effectiveHash);
    const jsonlPath: string = path.join(sessionDir, `${session.sessionId}.jsonl`);

    fs.mkdirSync(sessionDir, {recursive: true});

    const allLines: string[] = buildLosslessMongoJsonlLines(messages, sessionLines);

    fs.writeFileSync(jsonlPath, allLines.join('\n') + '\n', 'utf-8');
    console.log(`WebSocket: [RAW-RESTORE] Lossless JSONL restored at ${jsonlPath} (${allLines.length} lines from ${messages.length} messages + ${sessionLines.length} session lines)`.green);
}

/**
 * Reconstruct task JSON files from MongoDB and write them to
 * ~/.claude/tasks/{sessionId}/{taskId}.json.
 * Skips if the task directory already exists with files on disk.
 * Returns the number of tasks restored.
 */
async function reconstructAndSaveTasks(sessionId: string): Promise<number> {
    const tasksDir: string = path.join(process.env.HOME || '~', '.claude', 'tasks', sessionId);

    // Skip if local task files already exist
    if (fs.existsSync(tasksDir)) {
        const existing: string[] = fs.readdirSync(tasksDir).filter((name: string) => name.endsWith('.json'));
        if (existing.length > 0) {
            return 0;
        }
    }

    const tasks = await TaskModel.find({sessionId});
    if (tasks.length === 0) {
        return 0;
    }

    fs.mkdirSync(tasksDir, {recursive: true});

    for (const task of tasks) {
        const rawTask = {
            id: task.taskId,
            subject: task.subject,
            description: task.description,
            ...(task.activeForm ? {activeForm: task.activeForm} : {}),
            status: task.status,
            blocks: task.blocks ?? [],
            blockedBy: task.blockedBy ?? [],
        };
        fs.writeFileSync(path.join(tasksDir, `${task.taskId}.json`), JSON.stringify(rawTask, null, 2), 'utf-8');
    }

    console.log(`WebSocket: Reconstructed ${tasks.length} task(s) at ${tasksDir}`.cyan);
    return tasks.length;
}

/** Marker path segment used to extract relative memory file paths */
const MEMORY_PATH_MARKER: string = '/memory/';

/**
 * Reconstruct all memory files from MongoDB and write them to
 * ~/.claude/projects/{projectDir}/memory/.
 * Skips if the memory directory already exists with files on disk.
 * Returns true if any files were restored.
 */
async function reconstructAndSaveMemory(localProjectDirHash: string): Promise<boolean> {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const memoryDir: string = path.join(claudeProjectsDir, localProjectDirHash, 'memory');

    // Query MongoDB with the canonical hash — sync always stores canonical.
    // Write files to the local hash directory so Claude finds them.
    const canonicalHash: string = resolveProjectDirHash(localProjectDirHash);
    const memories = await MemoryModel.find({projectDir: canonicalHash});
    if (memories.length === 0) {
        return false;
    }

    fs.mkdirSync(memoryDir, {recursive: true});

    let writtenCount: number = 0;
    for (const memory of memories) {
        // Extract relative path after /memory/ marker — mirrors ExportService pattern
        const markerIndex: number = memory.filePath.lastIndexOf(MEMORY_PATH_MARKER);
        const relPath: string = markerIndex >= 0
            ? memory.filePath.substring(markerIndex + MEMORY_PATH_MARKER.length)
            : path.basename(memory.filePath);
        const outputPath: string = path.join(memoryDir, relPath);
        // Per-file merge: only write files missing from disk — preserves local edits
        if (fs.existsSync(outputPath)) continue;
        fs.mkdirSync(path.dirname(outputPath), {recursive: true});
        fs.writeFileSync(outputPath, memory.content, 'utf-8');
        writtenCount++;
    }

    if (writtenCount > 0) {
        console.log(`WebSocket: Reconstructed ${writtenCount}/${memories.length} memory file(s) at ${memoryDir}`.cyan);
    }
    return writtenCount > 0;
}

/**
 * Walk the parentUuid-linked message tree and return only the active branch.
 * Matches the getActiveBranch logic in the frontend — always picks the latest child.
 */
function getActiveBranch(messages: IMessage[]): IMessage[] {
    const hasTreeData: boolean = messages.some((m: IMessage) => m.parentUuid !== undefined && m.parentUuid !== null);
    if (!hasTreeData) return messages;

    const childrenMap: Map<string | null, IMessage[]> = new Map();
    for (const msg of messages) {
        const key: string | null = msg.parentUuid ?? null;
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(msg);
    }

    const result: IMessage[] = [];
    let currentUuid: string | null = null;
    while (true) {
        const children: IMessage[] | undefined = childrenMap.get(currentUuid);
        if (!children?.length) break;
        const next: IMessage = children.reduce((a: IMessage, b: IMessage) =>
            new Date(a.timestamp as Date) > new Date(b.timestamp as Date) ? a : b,
        );
        result.push(next);
        currentUuid = next.uuid;
    }
    return result;
}

/**
 * Kill the Claude process and its entire process group.
 * Step 1: SIGTERM (graceful shutdown).
 * Step 2: SIGKILL after 500ms if still alive (force kill).
 * Uses negative PID to kill the entire process group (requires detached: true on spawn).
 */
function killClaudeProcess(claudeProcess: ChildProcess): void {
    if (!claudeProcess || claudeProcess.killed) return;

    const pid: number | undefined = claudeProcess.pid;

    // Step 1: Graceful shutdown
    if (pid) {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            claudeProcess.kill('SIGTERM');
        }
    } else {
        claudeProcess.kill('SIGTERM');
    }

    // Step 2: Force kill if still alive after 500ms
    const forceKillTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!claudeProcess.killed) {
            console.log('WebSocket: Claude process still alive after 500ms — sending SIGKILL'.yellow);
            if (pid) {
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch {
                    claudeProcess.kill('SIGKILL');
                }
            } else {
                claudeProcess.kill('SIGKILL');
            }
        }
    }, 500);

    claudeProcess.once('exit', () => clearTimeout(forceKillTimer));
}

/**
 * Attach a WebSocketServer to the given HTTP server at path /ws.
 * Handles message routing, claude process lifecycle, and auto-sync.
 * No auth needed — both servers always run locally on the same Mac inside the .app bundle.
 *
 * Protocol:
 *   new_session / resume_session  → spawns a persistent claude process, sends first message
 *   send_message                  → writes follow-up message to the same process stdin (no re-spawn)
 *   ping                          → pong
 *   WS close                      → kills the process, triggers auto-sync
 */
function attachWebSocket(httpServer: HttpServer): WebSocketServer {
    const webSocketServer: WebSocketServer = new WebSocketServer({server: httpServer, path: '/ws'});

    webSocketServer.on('connection', (webSocket: WebSocket, _req: IncomingMessage) => {
        console.log('WebSocket: Client connected'.green.bold);

        let claudeProcess: ChildProcess | null = null;
        let syncTimer: ReturnType<typeof setTimeout> | null = null;
        let activeSessionId: string | null = null;
        let activeEffortLevel: string | null = null;
        let activeThinking: boolean | null = null;

        // --- IDE (IntelliJ) state ---
        let ideService: IdeService | null = null;
        let ideConnectedInfo: { ideName: string; port: number } | null = null;
        let activeProjectDir: string | null = null;  // raw cwd from system event — used to resolve relative tool paths
        let lastDiffTabName: string | null = null;   // tab_name of the last openDiff — closed on approval/deny
        let lastDiffRequestId: string | null = null; // requestId of the tool approval linked to the current diff
        let lastDiffFilePath: string | null = null;  // absolute path of the file being diffed
        let pendingIdeOverwrite: { filePath: string; content: string } | null = null; // user-modified content from IDE Apply — re-written after Claude writes

        /** Forward IDE MCP events to the WebSocket client */
        const onIdeEvent = (event: Record<string, unknown>): void => {
            if (event.type === 'ide_connected') {
                ideConnectedInfo = {ideName: event.ideName as string, port: event.port as number};
            } else if (event.type === 'ide_disconnected') {
                ideConnectedInfo = null;
            }

            // IDE Apply/Reject → auto-resolve the web UI tool approval
            if (event.type === 'ide_diff_applied' || event.type === 'ide_diff_rejected') {
                if (lastDiffRequestId) {
                    const decision: 'allow' | 'deny' = event.type === 'ide_diff_applied' ? 'allow' : 'deny';
                    console.log(`IdeService: IDE ${decision === 'allow' ? 'Apply' : 'Reject'} → auto-resolving approval (requestId: ${lastDiffRequestId})`.cyan);

                    // If IDE Apply: store user-modified content to re-write after Claude writes.
                    // Claude's tool execution overwrites IntelliJ's write; we restore user's version
                    // once the tool_result event confirms Claude finished.
                    if (event.type === 'ide_diff_applied' && lastDiffFilePath) {
                        const savedContent: string | undefined = event.savedContent as string | undefined;
                        if (savedContent !== undefined) {
                            pendingIdeOverwrite = {filePath: lastDiffFilePath, content: savedContent};
                            console.log(`IdeService: Stored user's IDE modifications (${savedContent.length} chars) — will re-apply after Claude writes`.cyan);
                        }
                    }

                    resolveApproval(lastDiffRequestId, {permissionDecision: decision});
                    // Tell frontend to dismiss the approval prompt
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'tool_approval_auto_resolved', requestId: lastDiffRequestId, decision}));
                    }
                    // Close the diff tab
                    if (lastDiffTabName && ideService?.isConnected) {
                        ideService.closeTab(lastDiffTabName);
                    }
                    lastDiffRequestId = null;
                    lastDiffTabName = null;
                    lastDiffFilePath = null;
                }
                return; // Don't forward internal diff events to frontend
            }

            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify(event));
            }
        }

        /** Best-effort IDE auto-connect — silent if IDE not running */
        const autoConnectIde = (): void => {
            console.log('IdeService: Auto-connect attempt...'.cyan);
            // Skip if already connected (e.g., session spawn after initial connection)
            if (ideService?.isConnected) {
                console.log('IdeService: Auto-connect skipped — already connected'.gray);
                return;
            }
            ideService = new IdeService(onIdeEvent);
            ideService.connect()
                .then(() => {
                    console.log('IdeService: Auto-connect succeeded'.green);
                })
                .catch((error: unknown) => {
                    console.log(`IdeService: Auto-connect failed — ${error}`.gray);
                    ideService = null;
                });
        }

        // Auto-connect IDE on WebSocket connection (before any session spawns)
        // so the indicator shows immediately when the page loads.
        autoConnectIde();

        /** Handle /ide slash command — (re)connect or re-confirm existing connection */
        const handleIdeCommand = async (): Promise<void> => {
            if (ideService?.isConnected) {
                // Already connected — re-send status as confirmation
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(JSON.stringify({
                        type: 'ide_connected',
                        ideName: ideConnectedInfo?.ideName ?? 'Unknown IDE',
                        port: ideConnectedInfo?.port ?? 0,
                    }));
                }
                return;
            }
            // Attempt (re)connect
            ideService = new IdeService(onIdeEvent);
            try {
                await ideService.connect();
                // ide_connected event already forwarded via onIdeEvent
            } catch (error: unknown) {
                ideService = null;
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(JSON.stringify({type: 'ide_error', message: String(error)}));
                }
            }
        }

        // --- Direct-write state: write messages to MongoDB as they stream ---
        let directWriteSessionOid: Types.ObjectId | null = null;
        let lastWrittenUuid: string | null = null;
        // Dedup guard for upsertSessionOnInit. Claude CLI emits multiple `system` events
        // per spawn (init, plus events like compact_boundary) — without this set, each one
        // re-runs the Session+Project upserts in parallel, and the concurrent Project
        // upserts race on the rawProjectDir/projectDir unique indexes (E11000).
        const upsertedSessionIds: Set<string> = new Set<string>();
        // Holds attachment metadata uploaded for a new_session before its real
        // sessionId arrives via the system event. Pushed to the per-session
        // queue (and cleared) inside onSystemEvent. resume_session/send_message
        // know the sessionId up front and push directly without staging here.
        let stagedNewSessionAttachmentMeta: IAttachmentMeta[] | null = null;

        // --- JSONL backup state: debounce, size threshold tracking, idle timer, upload serialization ---
        let lastBackupTimestamp: number = 0;
        let lastSizeThreshold: number = 0;
        let idleBackupTimer: ReturnType<typeof setTimeout> | null = null;
        let backupInFlight: boolean = false;
        let backupNeededAfterInflight: { sessionId: string; reason: string; } | null = null;

        /**
         * Best-effort JSONL backup to R2 — reads local JSONL file, uploads, respects 30s debounce.
         * Serialized: only one upload runs at a time. If a second backup is requested while one is in
         * flight, it is queued and executed immediately after the current upload completes (bypassing
         * the debounce, since new data was written during the in-flight upload).
         * Async + non-blocking: callers fire-and-forget (catch errors internally).
         */
        const backupSessionJsonl = async (sessionId: string, reason: string, bypassDebounce: boolean = false): Promise<void> => {
            const now: number = Date.now();
            console.log(`DIAGNOSTIC: backupSessionJsonl called sessionId=${sessionId} reason=${reason} bypassDebounce=${bypassDebounce} msSinceLastBackup=${lastBackupTimestamp ? now - lastBackupTimestamp : 'first'}`.bgMagenta.white.bold);
            if (!bypassDebounce && now - lastBackupTimestamp < 30_000) {
                console.log(`DIAGNOSTIC: backupSessionJsonl SKIPPED reason=${reason} cause=debounce`.bgMagenta.white.bold);
                console.log(`R2: Skipping JSONL backup (debounce) — ${reason}`.cyan);
                return;
            }
            if (!activeProjectDir) {
                console.log(`DIAGNOSTIC: backupSessionJsonl SKIPPED reason=${reason} cause=no_activeProjectDir`.bgMagenta.white.bold);
                return;
            }

            if (backupInFlight) {
                backupNeededAfterInflight = {sessionId, reason};
                console.log(`DIAGNOSTIC: backupSessionJsonl QUEUED reason=${reason} cause=in_flight`.bgMagenta.white.bold);
                console.log(`R2: JSONL backup queued (upload in flight) — ${reason}`.cyan);
                return;
            }

            const hash: string = toProjectDirHash(activeProjectDir);
            const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${sessionId}.jsonl`);
            if (!fs.existsSync(jsonlPath)) {
                console.log(`DIAGNOSTIC: backupSessionJsonl SKIPPED reason=${reason} cause=no_disk_file path=${jsonlPath}`.bgMagenta.white.bold);
                return;
            }

            backupInFlight = true;
            try {
                const content: Buffer = fs.readFileSync(jsonlPath);
                const lineCount: number = content.toString('utf-8').split('\n').filter((line: string) => line.trim().length > 0).length;
                console.log(`DIAGNOSTIC: backupSessionJsonl READING DISK reason=${reason} sessionId=${sessionId} bytes=${content.length} nonEmptyLines=${lineCount} path=${jsonlPath}`.bgMagenta.white.bold);
                await uploadJsonlBackup(sessionId, content);
                lastBackupTimestamp = Date.now();
                console.log(`R2: JSONL backup complete — trigger: ${reason}`.green);
            } catch (error: unknown) {
                console.warn(`R2: JSONL backup failed — ${reason}: ${error}`.yellow);
            } finally {
                backupInFlight = false;
                if (backupNeededAfterInflight) {
                    const {sessionId: pendSid, reason: pendReason} = backupNeededAfterInflight;
                    backupNeededAfterInflight = null;
                    backupSessionJsonl(pendSid, `${pendReason}_deferred`, true).catch(() => {});
                }
            }
        }

        /** Reset the idle backup timer — fires once after 5 minutes of no user messages */
        const resetIdleBackupTimer = (): void => {
            if (idleBackupTimer) {
                clearTimeout(idleBackupTimer);
            }
            if (!activeSessionId) {
                return;
            }
            const sid: string = activeSessionId;
            idleBackupTimer = setTimeout(() => {
                idleBackupTimer = null;
                backupSessionJsonl(sid, 'idle_5m');
            }, 5 * 60 * 1000);
        }

        const triggerResultEventBackup = (): void => {
            if (activeSessionId) {
                backupSessionJsonl(activeSessionId, 'result_event').catch(() => {
                });
            }
        }

        /** Register session → WS mapping when system event provides the session_id. Also triggers direct-write session upsert so messages can be saved immediately */
        const onSystemEvent = (event: Record<string, unknown>): void => {
            // After IDE Apply: Claude writes its original content (overwriting user modifications).
            // When the tool_result arrives (user event), Claude is done writing — re-apply
            // the user's IDE modifications so their edits persist.
            if (pendingIdeOverwrite && event.type === 'user') {
                const msg = event.message as Record<string, unknown> | undefined;
                const content = msg?.content as Array<Record<string, unknown>> | undefined;
                if (content?.some((b: Record<string, unknown>) => b.type === 'tool_result')) {
                    try {
                        fs.writeFileSync(pendingIdeOverwrite.filePath, pendingIdeOverwrite.content, 'utf-8');
                        console.log(`IdeService: Re-applied user's IDE modifications to ${pendingIdeOverwrite.filePath} (${pendingIdeOverwrite.content.length} chars)`.green.bold);
                    } catch (error: unknown) {
                        console.warn(`IdeService: Failed to re-apply IDE modifications — ${error}`.yellow);
                    }
                    pendingIdeOverwrite = null;
                }
            }

            if (event.type === 'system' && event.session_id) {
                activeSessionId = event.session_id as string;
                // Only update activeProjectDir when cwd is actually present in the system event.
                // Using || null would overwrite the eagerly-set value (from spawnMessage.projectDir)
                // with null whenever a second system event fires without a cwd field (e.g. MCP server
                // init events), silently triggering a full-scan autoSync({}) instead of a scoped one.
                // Also strip trailing slashes for consistency with the eager-assignment path.
                if (event.cwd) {
                    activeProjectDir = (event.cwd as string).replace(TRAILING_SLASHES_REGEX, '');
                }
                // Drain any new_session attachment metadata staged before the
                // real sessionId was known. The system event arrives on every
                // session start; the staged value is per-spawn, so this only
                // fires once per new_session with attachments.
                if (stagedNewSessionAttachmentMeta) {
                    pendingAttachments.push(activeSessionId, stagedNewSessionAttachmentMeta);
                    console.log(`WebSocket: pendingAttachments queued ${stagedNewSessionAttachmentMeta.length} item(s) for new_session ${activeSessionId}`.cyan);
                    stagedNewSessionAttachmentMeta = null;
                }
                registerSession(activeSessionId, webSocket);
                setSessionProjectDir(activeSessionId, activeProjectDir);
                if (activeProjectDir) {
                    initSessionAllowAll(activeSessionId, activeProjectDir);
                }
                upsertSessionOnInit(event);

                // Trigger #4: start idle backup timer when session begins
                resetIdleBackupTimer();

                // Register IDE openDiff hook — fires when a tool approval is requested,
                // opening the diff in IntelliJ in sync with the web UI DiffView prompt.
                registerIdeOpenDiffHook(activeSessionId, (toolName: string, toolInput: Record<string, unknown>, requestId: string): void => {
                    if (!ideService?.isConnected) return;
                    if (toolName !== 'Write' && toolName !== 'Edit') return;

                    const rawPath: string = (toolInput.file_path as string) ?? '';
                    if (!rawPath) return;

                    // Resolve relative paths against the session cwd — IntelliJ requires absolute paths
                    const filePath: string = path.isAbsolute(rawPath)
                        ? rawPath
                        : activeProjectDir
                            ? path.resolve(activeProjectDir, rawPath)
                            : rawPath;

                    // Compute new file content — IntelliJ reads old content from disk via old_file_path
                    let newContent: string;
                    if (toolName === 'Write') {
                        newContent = (toolInput.content as string) ?? '';
                    } else {
                        // Edit: apply old_string → new_string replacement on the current file
                        const fileExists: boolean = fs.existsSync(filePath);
                        const existing: string = fileExists ? fs.readFileSync(filePath, 'utf-8') : '';
                        const oldStr: string = (toolInput.old_string as string) ?? '';
                        const newStr: string = (toolInput.new_string as string) ?? '';
                        const replaceAll: boolean = (toolInput.replace_all as boolean) ?? false;

                        console.log(
                            `IdeService: openDiff debug — fileExists=${fileExists}` +
                            ` existingLen=${existing.length} existingHasCRLF=${existing.includes('\r\n')}` +
                            ` oldStrLen=${oldStr.length} oldStrHasCRLF=${oldStr.includes('\r\n')}` +
                            ` oldStrPreview=${JSON.stringify(oldStr.slice(0, 80))}`.gray,
                        );

                        const applyReplace = (src: string, search: string): string => (replaceAll && search) ? src.split(search).join(newStr) : src.replace(search, newStr);

                        newContent = applyReplace(existing, oldStr);

                        // Fallback: retry with CRLF-normalised strings when exact match fails
                        if (newContent === existing && oldStr) {
                            console.warn(
                                `IdeService: openDiff — exact match failed for ${filePath}` +
                                ` (existingHasCRLF=${existing.includes('\r\n')}, oldStrHasCRLF=${oldStr.includes('\r\n')})`.yellow,
                            );
                            const normalizedExisting: string = existing.replace(CRLF_REGEX, '\n');
                            const normalizedOld: string = oldStr.replace(CRLF_REGEX, '\n');
                            const normalizedResult: string = applyReplace(normalizedExisting, normalizedOld);
                            if (normalizedResult !== normalizedExisting) {
                                newContent = normalizedResult;
                                console.warn(`IdeService: openDiff — CRLF-normalised fallback succeeded for ${filePath}`.yellow);
                            } else {
                                // old_string not found — file doesn't exist yet or content has already changed.
                                // Skip openDiff: showing "Contents are identical" in IntelliJ is misleading.
                                console.warn(`IdeService: openDiff — old_string not found in ${filePath}, skipping diff`.yellow);
                                return;
                            }
                        }
                    }

                    console.log(`IdeService: Opening diff for ${filePath}`.cyan);
                    lastDiffTabName = path.basename(filePath);
                    lastDiffRequestId = requestId;
                    lastDiffFilePath = filePath;
                    ideService!.openDiff(filePath, newContent, lastDiffTabName);
                });
            }
        }

        /**
         * Upsert the Session document in MongoDB when the system event arrives.
         * This ensures the Session exists before any message direct-writes,
         * so messages have a valid sessionInternalId reference.
         * Called from onSystemEvent-like hooks passed to spawnClaude.
         */
        const upsertSessionOnInit = async (event: Record<string, unknown>): Promise<void> => {
            if (event.type !== 'system' || !event.session_id) return;
            const sessionId: string = event.session_id as string;

            // Synchronous dedup — Claude CLI emits multiple `system` events per spawn
            // (init, compact_boundary, etc.). Without this guard, each event launches
            // parallel Session+Project upserts and the concurrent Project upserts race
            // on the rawProjectDir/projectDir unique indexes (E11000).
            if (upsertedSessionIds.has(sessionId)) return;
            upsertedSessionIds.add(sessionId);

            // Fall back to activeProjectDir when the system event omits cwd (e.g. MCP init events,
            // older CLI versions). Without the fallback, MongoDB gets projectDir: "" and the session
            // becomes permanently unresumable — the same failure mode as b9e1e513.
            const cwd: string = (event.cwd as string) || activeProjectDir || '';
            const model: string = (event.model as string) || '';
            const canonicalCwd: string = resolveCanonicalPath(cwd);
            const projectDir: string = toProjectDirHash(canonicalCwd);

            try {
                const session = await SessionModel.findOneAndUpdate(
                    {sessionId},
                    {
                        $setOnInsert: {title: '(live session)', source: ESessionSource.WEBUI},
                        $set: {projectDir, rawProjectDir: canonicalCwd, aiModel: model},
                    },
                    {upsert: true, returnDocument: 'after'},
                );
                directWriteSessionOid = session!._id as Types.ObjectId;
                lastWrittenUuid = null;
                console.log(`WebSocket: [direct-write] Session upserted — sessionId: ${sessionId}, _id: ${directWriteSessionOid}`.green);
            } catch (error: unknown) {
                // Roll back the dedup so a later system event can retry the upsert.
                upsertedSessionIds.delete(sessionId);
                console.error(`WebSocket: [direct-write] Failed to upsert Session — sessionId: ${sessionId}, error: ${error}`.red);
                return;
            }

            try {
                await ProjectModel.findOneAndUpdate(
                    {projectDir},
                    {
                        $setOnInsert: {rawProjectDir: canonicalCwd},
                        $set: {lastSessionAt: new Date()},
                        $unset: {orphanedAt: ''},
                    },
                    {upsert: true},
                );
                console.log(`WebSocket: [direct-write] Project upserted — projectDir: ${projectDir}`.green);
            } catch (error: unknown) {
                // E11000 means another concurrent path created the project first — the
                // end state matches what we wanted, so treat this as benign. Anything
                // else is a real error.
                const code: number | undefined = (error as {code?: number} | null)?.code;
                if (code === 11000) {
                    console.log(`WebSocket: [direct-write] Project already exists (concurrent insert resolved) — projectDir: ${projectDir}`.gray);
                } else {
                    console.error(`WebSocket: [direct-write] Failed to upsert Project — projectDir: ${projectDir}, error: ${error}`.red);
                }
            }
        }

        /**
         * Write a single user/assistant message to MongoDB in real-time.
         * Called by claudeSpawner's onMessage hook for every complete event.
         * Uses the uuid as dedup key — safe to call even if JSONL sync later
         * tries to insert the same message (unique index prevents duplicates).
         * parentUuid is NOT available in stream-json events, so we chain messages
         * using lastWrittenUuid. The JSONL sync on process_exit backfills the
         * correct parentUuid from the JSONL file (see SyncService.syncFile).
         */
        const directWriteMessage = async (event: Record<string, unknown>): Promise<void> => {
            if (!directWriteSessionOid) return;

            const uuid: string | undefined = event.uuid as string | undefined;
            if (!uuid) {
                console.warn('WebSocket: [direct-write] Skipping event without uuid'.yellow);
                return;
            }

            const role: EMessageRole = event.type as EMessageRole; // 'assistant' or 'user'
            const msgObj = event.message as Record<string, unknown> | undefined;
            if (!msgObj) return;

            const content = msgObj.content as string | Record<string, unknown>[];
            const aiModel: string | undefined = role === EMessageRole.ASSISTANT ? (msgObj.model as string | undefined) : undefined;

            // Extract token usage from assistant events
            let tokenUsage: Record<string, number> | undefined;
            if (role === EMessageRole.ASSISTANT && msgObj.usage) {
                const usage = msgObj.usage as Record<string, number>;
                tokenUsage = {
                    inputTokens: usage.input_tokens ?? 0,
                    outputTokens: usage.output_tokens ?? 0,
                    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
                    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
                };
            }

            // Capture parentUuid and update lastWrittenUuid SYNCHRONOUSLY before
            // the async MongoDB write. This prevents a race condition where two
            // concurrent writes (flush assistant + user event) both read the same
            // stale lastWrittenUuid, breaking the parentUuid chain and causing
            // getActiveBranch to orphan messages.
            const parentUuid: string | undefined = lastWrittenUuid ?? undefined;
            lastWrittenUuid = uuid;

            // Attachments are NOT attributed here — Claude CLI does not echo the
            // human-typed user message on stream-json stdout (only writes it to
            // JSONL). The first `role: 'user'` event seen here is always a
            // synthetic tool_result, which would be the wrong message to stamp.
            // Attribution happens in SyncService.syncFile after the JSONL sync
            // inserts the authoritative human user message.

            // Extract raw lines attached by claudeSpawner (_rawLines is not part of the protocol —
            // it's an internal field added before calling onMessage for lossless restore support)
            const rawLines: string[] | undefined = event._rawLines as string[] | undefined;

            try {
                await MessageModel.create({
                    uuid,
                    parentUuid,
                    sessionInternalId: directWriteSessionOid,
                    role,
                    content,
                    aiModel,
                    effortLevel: role === EMessageRole.ASSISTANT ? (activeEffortLevel ?? undefined) : undefined,
                    thinking: role === EMessageRole.ASSISTANT ? (activeThinking ?? undefined) : undefined,
                    timestamp: new Date(),
                    tokenUsage,
                    ...(rawLines && rawLines.length > 0 ? {rawLines} : {}),
                });
                console.log(`WebSocket: [direct-write] Saved ${role} message (uuid: ${uuid})`.green);
            } catch (error: unknown) {
                // E11000 duplicate key error = message already exists (e.g. from a prior sync) — safe to ignore
                if (error instanceof Error && error.message.includes('E11000')) {
                    console.log(`WebSocket: [direct-write] Skipped duplicate ${role} message (uuid: ${uuid})`.gray);
                } else {
                    console.error(`WebSocket: [direct-write] Failed to save ${role} message — ${error}`.red);
                }
            }
        }

        /**
         * Schedule a sync callback with 3000ms delay (debounced).
         * Claude emits the result event before finishing JSONL writes,
         * so the delay gives it time to flush. Cancels any pending timer.
         * TODO: If 3s is still insufficient for large sessions, replace the
         *  fixed delay with JSONL file-size polling (check every 500ms until
         *  size stabilizes, then sync). Requires passing the JSONL path here.
         */
        const scheduleSync = (fn: () => void | Promise<void>): void => {
            if (syncTimer) clearTimeout(syncTimer);
            syncTimer = setTimeout(() => {
                syncTimer = null;
                Promise.resolve(fn()).catch((error: unknown) => {
                    console.error(`WebSocket: scheduleSync callback failed — ${error}`.red);
                });
            }, 3000);
        }

        /**
         * Cancel any pending scheduled sync and run the given callback immediately.
         * Used on process_exit where JSONL writes are guaranteed complete.
         */
        const flushSync = (fn: () => void | Promise<void>): void => {
            if (syncTimer) {
                console.debug('DEBUG: Clearing pending sync timer — process_exit takes priority'.cyan);
                clearTimeout(syncTimer);
                syncTimer = null;
            }
            Promise.resolve(fn()).catch((error: unknown) => {
                console.error(`WebSocket: flushSync callback failed — ${error}`.red);
            });
        }

        /**
         * Persist contextWindowSize + contextTokensUsed from the result event to MongoDB.
         * Called immediately when a result event arrives (before the debounced sync).
         * contextWindowSize is account-level (Pro=200k, Team=10M) — stored per session
         * so historical sessions can display accurate context info.
         *
         * Uses the last assistant event's per-call usage (attached by claudeSpawner as
         * _lastAssistantUsage) for accurate context — result.usage is cumulative across
         * all API calls/turns in the interaction, NOT the current context size.
         */
        const persistResultContext = async (resultEvent: Record<string, unknown>): Promise<void> => {
            if (!activeSessionId) return;

            // Prefer last assistant's per-call usage (actual context) over cumulative result.usage.
            // result.usage is cumulative across all API calls/turns — NOT the current context size.
            // claudeSpawner attaches the last assistant event's usage as _lastAssistantUsage.
            const lastAssistantUsage = resultEvent._lastAssistantUsage as Record<string, number> | undefined;
            const resultUsage = resultEvent.usage as Record<string, number> | undefined;
            const usage: Record<string, number> | undefined = lastAssistantUsage ?? resultUsage;
            const modelUsage = resultEvent.modelUsage as Record<string, Record<string, number>> | undefined;
            if (!usage) return;

            const totalInput: number = (usage.input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0)
                + (usage.cache_read_input_tokens ?? 0);

            // Skip persisting when all tokens are 0 — rejected API call (e.g. "Prompt is too long")
            // would overwrite valid previous context data with zeros
            if (totalInput === 0) return;

            const modelKey: string | undefined = modelUsage ? Object.keys(modelUsage)[0] : undefined;
            const contextWindow: number | undefined = modelKey ? modelUsage?.[modelKey]?.contextWindow : undefined;

            const update: Record<string, number> = {contextTokensUsed: totalInput};
            if (contextWindow) {
                update.contextWindowSize = contextWindow;
            }

            try {
                await SessionModel.findOneAndUpdate(
                    {sessionId: activeSessionId},
                    {$set: update},
                );
                console.log(`WebSocket: Persisted context — sessionId: ${activeSessionId}, tokens: ${totalInput}${lastAssistantUsage ? ' (per-call)' : ' (cumulative fallback)'}, contextWindow: ${contextWindow ?? 'unchanged'}`.cyan);
            } catch (error: unknown) {
                console.error(`WebSocket: Failed to persist context — ${error}`.red);
            }
        }

        /** Sync then label the active session as web-UI originated.
         *  After sync completes, sends a sync_complete event to the frontend
         *  so it can refetch the session with the full data (including the
         *  human-typed user message that only exists in the JSONL file). */
        const autoSyncWebUI = async (): Promise<void> => {
            // DIAGNOSTIC: snapshot disk JSONL line count at the moment sync starts
            // (compare against the line count seen by the immediate result_event backup
            // to prove/disprove the flush-gap hypothesis).
            if (activeSessionId && activeProjectDir) {
                try {
                    const hash: string = toProjectDirHash(activeProjectDir);
                    const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${activeSessionId}.jsonl`);
                    if (fs.existsSync(jsonlPath)) {
                        const content: string = fs.readFileSync(jsonlPath, 'utf-8');
                        const lineCount: number = content.split('\n').filter((line: string) => line.trim().length > 0).length;
                        console.log(`DIAGNOSTIC: autoSyncWebUI disk snapshot sessionId=${activeSessionId} bytes=${content.length} nonEmptyLines=${lineCount}`.bgMagenta.white.bold);
                    } else {
                        console.log(`DIAGNOSTIC: autoSyncWebUI disk snapshot sessionId=${activeSessionId} status=file_missing path=${jsonlPath}`.bgMagenta.white.bold);
                    }
                } catch (error: unknown) {
                    console.log(`DIAGNOSTIC: autoSyncWebUI disk snapshot error=${error instanceof Error ? error.message : String(error)}`.bgMagenta.white.bold);
                }
            }
            await autoSync(activeProjectDir);
            if (activeSessionId) {
                try {
                    await SessionModel.updateOne(
                        {sessionId: activeSessionId},
                        {$set: {source: ESessionSource.WEBUI}},
                    );
                } catch (error: unknown) {
                    console.error(`WebSocket: Failed to set session source to WEBUI — ${error}`.red);
                }
            }
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify({type: 'sync_complete', sessionId: activeSessionId}));
                console.log('WebSocket: Sent sync_complete event to frontend'.green);
            }
        }

        webSocket.on('message', async (raw: Buffer) => {
            let clientMessage: ClientMessage;
            try {
                clientMessage = JSON.parse(raw.toString()) as ClientMessage;
            } catch {
                sendError(webSocket, 'Invalid JSON');
                return;
            }

            switch (clientMessage.type) {
                case 'request_ide_status': {
                    // Frontend requests current IDE status on mount — reply immediately
                    if (ideService?.isConnected && ideConnectedInfo && webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'ide_connected', ideName: ideConnectedInfo.ideName, port: ideConnectedInfo.port}));
                    }
                    break;
                }

                case 'ping': {
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'pong'}));
                    }
                    break;
                }

                case 'new_session':
                case 'resume_session': {
                    if (claudeProcess) {
                        sendError(webSocket, 'Session already active on this connection. Use send_message to continue or close and reconnect!');
                        return;
                    }

                    const hasAttachments: boolean = !!(clientMessage.attachments && clientMessage.attachments.length > 0);
                    if ((!clientMessage.text || !clientMessage.text.trim()) && !hasAttachments) {
                        sendError(webSocket, 'Message text or attachments required!');
                        return;
                    }

                    if (clientMessage.type === 'resume_session' && !clientMessage.newProjectDir) {
                        console.log(`WebSocket: [TRACE] resume_session — sessionId: ${clientMessage.sessionId}`.cyan);
                        const {session, messages, error} = await SessionService.getSessionBySessionId(clientMessage.sessionId);
                        console.log(`WebSocket: [TRACE] DB fetch — session: ${session ? `found (projectDir: ${session.projectDir}, rawProjectDir: ${session.rawProjectDir})` : 'null'}, messages: ${messages?.length ?? 0}, error: ${error ?? 'none'}`.cyan);

                        if (error || !session) {
                            console.log(`WebSocket: [TRACE] DB error or session not found — falling through to let claude handle it`.cyan);
                        } else {
                            // Cross-machine resume: the canonical rawProjectDir may not exist
                            // on this machine (e.g. /Users/... on Mac Mini is /Volumes/... on
                            // MacBook Air). Resolve to whichever path mapping variant actually
                            // exists locally, and compute the matching hash for JSONL lookup.
                            const localRawProjectDir: string = resolveLocalPath(session.rawProjectDir);
                            const localProjectDirHash: string = toProjectDirHash(localRawProjectDir);
                            console.log(`WebSocket: [TRACE] Path resolution — canonical: ${session.rawProjectDir}, local: ${localRawProjectDir}, localHash: ${localProjectDirHash}`.cyan);

                            let localAvailable: boolean = isLocalSessionAvailable(localProjectDirHash, clientMessage.sessionId);

                            // Restore: if local JSONL is missing/broken, try R2 backup before MongoDB reconstruction
                            if (!localAvailable) {
                                console.log(`WebSocket: [TRACE] Local JSONL unavailable/broken — trying R2 restore`.cyan);
                                try {
                                    const r2Content: string | null = await downloadJsonlBackup(clientMessage.sessionId);
                                    if (r2Content) {
                                        const jsonlDir: string = path.join(process.env.HOME || '~', '.claude', 'projects', localProjectDirHash);
                                        fs.mkdirSync(jsonlDir, {recursive: true});
                                        fs.writeFileSync(path.join(jsonlDir, `${clientMessage.sessionId}.jsonl`), r2Content);
                                        console.log(`WebSocket: [TRACE] Restored JSONL from R2 backup (${(Buffer.byteLength(r2Content) / 1024).toFixed(1)} KB)`.green);
                                        localAvailable = isLocalSessionAvailable(localProjectDirHash, clientMessage.sessionId);
                                        if (localAvailable) {
                                            console.log('WebSocket: [TRACE] R2-restored JSONL is valid — skipping reconstruction'.green);
                                        } else {
                                            console.warn('WebSocket: [TRACE] R2-restored JSONL is invalid — falling through to reconstruction'.yellow);
                                        }
                                    }
                                } catch (r2Error: unknown) {
                                    console.warn(`WebSocket: [TRACE] R2 restore failed — ${r2Error}`.yellow);
                                }
                            }

                            if (!localAvailable) {
                                console.log(`WebSocket: [TRACE] Local JSONL unavailable/broken — restore path`.cyan);
                                if (!messages || messages.length === 0) {
                                    sendError(webSocket, `Cannot resume: session ${clientMessage.sessionId} has no messages in MongoDB and local files are missing.`);
                                    break;
                                }
                                const sessionLines: ISessionLine[] = await SessionLineModel.find(
                                    {sessionId: clientMessage.sessionId},
                                    null,
                                    {sort: {lineIndex: 1}},
                                );
                                console.log(`WebSocket: [TRACE] Messages from MongoDB (${messages.length}):`);
                                messages.forEach((message: IMessage, index: number) => {
                                    const contentSummary: string = Array.isArray(message.content)
                                        ? `ContentBlock[${message.content.length}]`
                                        : `string(${String(message.content).length})`;
                                    console.log(`WebSocket: [TRACE]   [${index}] role=${message.role} uuid=${message.uuid} rawLines=${message.rawLines?.length ?? 0} content=${contentSummary}`.cyan);
                                });
                                try {
                                    if (canBuildLosslessMongoJsonl(messages, sessionLines)) {
                                        console.log('WebSocket: [TRACE] Messages + SessionLine records available — using lossless restore'.green);
                                        rawLineRestoreJsonl(session, messages, sessionLines, localProjectDirHash);
                                    } else {
                                        const missingCount: number = messages.filter((message: IMessage) => !message.rawLines || message.rawLines.length === 0).length;
                                        console.warn(`WebSocket: [TRACE] Lossless Mongo restore unavailable (missingRawLines=${missingCount}, sessionLines=${sessionLines.length}) — falling back to reconstruction`.yellow);
                                        reconstructAndSaveJsonl(session, messages, localProjectDirHash, localRawProjectDir);
                                    }
                                } catch (reconstructionError: unknown) {
                                    sendError(webSocket, `Failed to restore session files: ${reconstructionError}`);
                                    break;
                                }

                                try {
                                    await reconstructAndSaveTasks(clientMessage.sessionId);
                                } catch (taskError: unknown) {
                                    console.error(`WebSocket: Failed to reconstruct tasks — ${taskError}`.red);
                                }

                                // Set cwd to the local path so claude --resume hashes correctly
                                clientMessage.projectDir = localRawProjectDir;
                                console.log(`WebSocket: [TRACE] Reconstruction done — cwd set to: ${clientMessage.projectDir}`.cyan);
                            } else {
                                // Detect and fix cwd mismatch before spawning.
                                // The Claude CLI validates that the 'cwd' baked into each JSONL line
                                // hashes to the same directory the file lives in. When a session is
                                // imported with a remapped projectDir the internal cwd still references
                                // the original path — the CLI rejects the session with "No conversation
                                // found" even though the file is present and otherwise valid.
                                // Fix: patch the cwd field on every line in-place so the JSONL matches
                                // the new location. Only the metadata field is changed; content is untouched.
                                let effectiveRawProjectDir: string = localRawProjectDir;
                                const jsonlCwd: string | null = readJsonlCwd(localProjectDirHash, clientMessage.sessionId);
                                if (!effectiveRawProjectDir && jsonlCwd) {
                                    // DB has empty projectDir — recover the real cwd from the JSONL and heal MongoDB
                                    effectiveRawProjectDir = jsonlCwd;
                                    await SessionModel.updateOne(
                                        {sessionId: clientMessage.sessionId},
                                        {$set: {projectDir: toProjectDirHash(jsonlCwd), rawProjectDir: jsonlCwd}},
                                    );
                                    console.log(`WebSocket: [TRACE] Recovered projectDir from JSONL cwd: ${jsonlCwd} — DB healed`.green);
                                } else if (effectiveRawProjectDir && jsonlCwd && jsonlCwd !== effectiveRawProjectDir) {
                                    console.log(`WebSocket: [TRACE] JSONL cwd mismatch — internal: "${jsonlCwd}", expected: "${effectiveRawProjectDir}" — patching`.yellow);
                                    patchJsonlCwd(localProjectDirHash, clientMessage.sessionId, effectiveRawProjectDir);
                                }
                                // Set cwd even when local JSONL is valid — claude --resume hashes cwd
                                // to locate the session file, so it must match the local project dir
                                clientMessage.projectDir = effectiveRawProjectDir;
                                console.log(`WebSocket: [TRACE] Local JSONL valid — skipping reconstruction, cwd set to: ${effectiveRawProjectDir}`.cyan);
                            }

                            // Always attempt memory restore — runs in both localAvailable and reconstruction
                            // paths. reconstructAndSaveMemory is idempotent: no-ops if the memory dir
                            // already exists with files on disk.
                            try {
                                await reconstructAndSaveMemory(localProjectDirHash);
                            } catch (memoryError: unknown) {
                                console.error(`WebSocket: Failed to reconstruct memory files — ${memoryError}`.red);
                            }

                            // Repair: strip trailing orphaned tool_use entries from the JSONL.
                            // The Anthropic API returns 400 if an assistant tool_use has no matching tool_result.
                            repairOrphanedToolUse(localProjectDirHash, clientMessage.sessionId);

                            // Guard: verify the resolved local project dir exists on disk before spawning.
                            // Without this, spawn('claude', args, {cwd: missing_dir}) crashes with ENOENT.
                            if (!fs.existsSync(clientMessage.projectDir!)) {
                                console.warn(`WebSocket: [TRACE] projectDir does not exist on disk: ${clientMessage.projectDir}`.yellow);
                                if (webSocket.readyState === WebSocket.OPEN) {
                                    const projectNotAvailable: IProjectNotAvailableMessage = {
                                        type: 'project_not_available',
                                        sessionId: clientMessage.sessionId,
                                        projectDir: clientMessage.projectDir!,
                                        warning: `Project directory "${clientMessage.projectDir}" does not exist on this machine. The session cannot be resumed here.`,
                                        session: session as unknown as Record<string, unknown>,
                                        messages: (messages ?? []) as unknown as Record<string, unknown>[],
                                    };
                                    webSocket.send(JSON.stringify(projectNotAvailable));
                                }
                                break;
                            }
                        }
                        // MongoDB error or session not in DB — fall through and let claude handle it
                    }

                    // new_session: restore memories from MongoDB so Claude has project context
                    // from day one on a machine that has never run this project locally.
                    if (clientMessage.type === 'new_session' && clientMessage.projectDir) {
                        const newSessionHash: string = toProjectDirHash(clientMessage.projectDir.replace(TRAILING_SLASHES_REGEX, ''));
                        try {
                            await reconstructAndSaveMemory(newSessionHash);
                        } catch (memoryError: unknown) {
                            console.error(`WebSocket: Failed to restore memory files for new session — ${memoryError}`.red);
                        }
                    }

                    const spawnMessage: INewSessionMessage | IResumeSessionMessage = (clientMessage.type === 'resume_session' && clientMessage.newProjectDir)
                        ? ({type: 'new_session', text: clientMessage.text, projectDir: clientMessage.newProjectDir} as INewSessionMessage)
                        : clientMessage;

                    activeEffortLevel = spawnMessage.effort ?? null;
                    activeThinking = typeof spawnMessage.thinking === 'boolean' ? spawnMessage.thinking : null;

                    // Build multimodal content blocks if attachments are present
                    let firstMsgContentBlocks: Record<string, unknown>[] | undefined;
                    if (clientMessage.attachments && clientMessage.attachments.length > 0) {
                        // For resume_session the sessionId is known; for new_session generate a temporary UUID
                        // (R2 key prefix only — the real CLI session ID arrives later in the system event)
                        const r2SessionId: string = clientMessage.type === 'resume_session'
                            ? clientMessage.sessionId
                            : crypto.randomUUID();
                        console.log(`WebSocket: ${clientMessage.type} with ${clientMessage.attachments.length} attachment(s) — uploading to R2 (r2SessionId: ${r2SessionId})`.cyan);
                        try {
                            const result = await buildContentBlocks(clientMessage.attachments, r2SessionId, clientMessage.text);
                            firstMsgContentBlocks = result.blocks;
                            // Queue the metadata so SyncService can attribute it to the human user
                            // message after JSONL sync. resume_session has the real sessionId now;
                            // new_session must wait for the system event to learn its real id.
                            if (clientMessage.type === 'resume_session') {
                                pendingAttachments.push(clientMessage.sessionId, result.attachmentMeta);
                            } else {
                                stagedNewSessionAttachmentMeta = result.attachmentMeta;
                            }
                        } catch (uploadError: unknown) {
                            sendError(webSocket, `Failed to upload attachments: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
                            break;
                        }
                    }

                    // Eagerly set activeProjectDir from the spawn message so autoSync is
                    // scoped to the current project even if the system event arrives after
                    // process_exit (e.g. Claude exits immediately with an error before emitting it).
                    // Strip trailing slashes: SyncService.resolveProjectDirs converts the path with
                    // NON_ALPHANUMERIC_REGEX, so a trailing slash becomes a trailing '-' which
                    // won't match the actual ~/.claude/projects/ subdirectory, silently no-op-ing the sync.
                    if (spawnMessage.projectDir) {
                        activeProjectDir = spawnMessage.projectDir.replace(TRAILING_SLASHES_REGEX, '');
                    }

                    // Eagerly register session WS before spawn to eliminate race with PreToolUse hook.
                    // For resume_session, sessionId is known now. For new_session, it's unknown until
                    // the system event — the retry loop in createApproval bridges that window instead.
                    if (spawnMessage.type === 'resume_session') {
                        registerSession((spawnMessage as IResumeSessionMessage).sessionId, webSocket);
                        console.log(`WebSocket: [TRACE] Eagerly registered session WS before spawn (sessionId: ${(spawnMessage as IResumeSessionMessage).sessionId})`.cyan);
                    }
                    console.log(`WebSocket: [TRACE] Spawning claude — type: ${spawnMessage.type}, cwd: ${spawnMessage.projectDir ?? 'undefined (inherits server cwd)'}`.cyan);
                    claudeProcess = spawnClaude(spawnMessage, webSocket, (resultEvent: Record<string, unknown>) => {
                        // Persist context immediately for existing sessions (resume).
                        // Also persist AFTER sync for new sessions (sync creates the session first).
                        // Both calls are safe: zero-guard skips rejected results, $set is idempotent.
                        persistResultContext(resultEvent);

                        // Trigger #3: size threshold backup (every 5MB boundary crossed)
                        if (activeSessionId && activeProjectDir) {
                            const hash: string = toProjectDirHash(activeProjectDir);
                            const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${activeSessionId}.jsonl`);
                            try {
                                const stats: fs.Stats = fs.statSync(jsonlPath);
                                const currentThreshold: number = Math.floor(stats.size / (5 * 1024 * 1024));
                                if (currentThreshold > lastSizeThreshold) {
                                    lastSizeThreshold = currentThreshold;
                                    backupSessionJsonl(activeSessionId, `size_threshold_${currentThreshold * 5}MB`);
                                }
                            } catch { /* file not yet written — skip */
                            }
                        }

                        // R2 backup runs AFTER the 3s scheduleSync window so Claude has
                        // finished flushing assistant content to the JSONL file. Doing it
                        // immediately on the result event captures a truncated file
                        // (the result event is emitted before JSONL writes complete).
                        // bypassDebounce=true: post-sync content is authoritative, must
                        // overwrite any earlier debounced upload.
                        scheduleSync(async (): Promise<void> => {
                            await autoSyncWebUI();
                            await persistResultContext(resultEvent);
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_sync', true);
                            }
                        });
                    }, onSystemEvent, undefined, undefined, directWriteMessage, firstMsgContentBlocks);

                    // Best-effort IDE auto-connect on session start
                    autoConnectIde();

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: claude process exited with code ${code}`.cyan);

                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }

                        // Flush: cancel any pending result-event sync and run immediately.
                        // On exit all JSONL writes are guaranteed complete — this is the
                        // authoritative sync that captures the final state.
                        // R2 backup runs after sync so the final, complete JSONL replaces
                        // any earlier debounced/in-flight upload (bypassDebounce=true).
                        flushSync(async (): Promise<void> => {
                            await autoSyncWebUI();
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_exit_sync', true);
                            }
                        });

                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: claude process error — ${error.message}`.red);
                        sendError(webSocket, `Failed to spawn claude: ${error.message}`);
                        claudeProcess = null;
                    });
                    break;
                }

                case 'edit_session': {
                    // Trigger #1: snapshot JSONL before destructive edit (fire-and-forget)
                    if (activeSessionId) {
                        backupSessionJsonl(activeSessionId, 'before_edit_session');
                    }

                    // Kill existing claude process if active (live chat edit scenario)
                    if (claudeProcess) {
                        console.log('WebSocket: edit_session — killing active claude process before forking'.yellow);
                        killClaudeProcess(claudeProcess);
                        claudeProcess = null;
                    }

                    const editMsg: IEditSessionMessage = clientMessage as IEditSessionMessage;

                    if (!editMsg.text || !editMsg.text.trim()) {
                        sendError(webSocket, 'Message text is required!');
                        return;
                    }

                    if (!editMsg.sessionId) {
                        sendError(webSocket, 'sessionId is required for edit_session!');
                        return;
                    }

                    // Fetch parent session + full message history from MongoDB
                    const {session: parentSession, messages: rawMessages, error: sessionError} = await SessionService.getSessionBySessionId(editMsg.sessionId);
                    if (sessionError || !parentSession) {
                        sendError(webSocket, `Session not found: ${editMsg.sessionId}`);
                        break;
                    }

                    const oldSessionId: string = editMsg.sessionId;
                    const oldTitle: string = parentSession.title;
                    let newSessionId: string | null = null;
                    let parentSessionIdSet: boolean = false;

                    // Capture new session_id from the system event + register for tool approval + upsert session for direct-write
                    const captureSessionId = (event: Record<string, unknown>): void => {
                        if (event.type === 'system') {
                            newSessionId = event.session_id as string;
                            activeSessionId = newSessionId;
                            if (event.cwd) {
                                activeProjectDir = (event.cwd as string).replace(TRAILING_SLASHES_REGEX, '');
                            }
                            registerSession(activeSessionId, webSocket);
                            setSessionProjectDir(activeSessionId, activeProjectDir);
                            if (activeProjectDir) {
                                initSessionAllowAll(activeSessionId, activeProjectDir);
                            }
                            upsertSessionOnInit(event);
                            console.log(`WebSocket: edit_session — new session_id captured: ${newSessionId}`.cyan);
                        }
                    };

                    // After each sync: set parentSessionId + inherit title on the new session
                    const afterEditSync = async (): Promise<void> => {
                        await autoSyncWebUI();
                        if (newSessionId && !parentSessionIdSet) {
                            parentSessionIdSet = true;
                            try {
                                const updated = await SessionModel.findOneAndUpdate(
                                    {sessionId: newSessionId},
                                    {$set: {parentSessionId: oldSessionId, title: oldTitle}},
                                );
                                if (!updated) {
                                    // Race condition: session not yet synced — retry after 2 seconds
                                    setTimeout(async () => {
                                        await SessionModel.findOneAndUpdate(
                                            {sessionId: newSessionId!},
                                            {$set: {parentSessionId: oldSessionId, title: oldTitle}},
                                        );
                                    }, 2000);
                                }
                                console.log(`WebSocket: edit_session — set parentSessionId=${oldSessionId} on ${newSessionId}`.cyan);
                            } catch (err: unknown) {
                                console.error(`WebSocket: edit_session — failed to set parentSessionId: ${err}`.red);
                            }
                        }
                    }

                    // Build context: apply getActiveBranch then slice at editAtUuid (or take all for regenerate)
                    const activeMessages: IMessage[] = getActiveBranch(rawMessages || []);
                    let contextMessages: IMessage[];
                    if (editMsg.editAtUuid) {
                        const cutIndex: number = activeMessages.findIndex((m: IMessage) => m.uuid === editMsg.editAtUuid);
                        contextMessages = cutIndex >= 0 ? activeMessages.slice(0, cutIndex + 1) : activeMessages;
                        console.log(`WebSocket: edit_session — edit mode, cutIndex: ${cutIndex}, contextMessages: ${contextMessages.length}`.cyan);
                    } else {
                        contextMessages = activeMessages;
                        console.log(`WebSocket: edit_session — regenerate mode, contextMessages: ${contextMessages.length}`.cyan);
                    }

                    const contextNdjson: string | undefined = contextMessages.length > 0 ? toContextNdjson(contextMessages) : undefined;
                    const contextUserCount: number = contextMessages.filter((m: IMessage) => m.role === 'user').length;
                    const spawnMsg: INewSessionMessage = {
                        type: 'new_session',
                        text: editMsg.text,
                        projectDir: editMsg.projectDir || parentSession.rawProjectDir,
                    };

                    console.log(`WebSocket: edit_session — spawning fresh session (cwd: ${spawnMsg.projectDir}, contextUserCount: ${contextUserCount})`.cyan);
                    claudeProcess = spawnClaude(spawnMsg, webSocket, (resultEvent: Record<string, unknown>) => {
                        persistResultContext(resultEvent);

                        // Trigger #3: size threshold backup (every 5MB boundary crossed)
                        if (activeSessionId && activeProjectDir) {
                            const hash: string = toProjectDirHash(activeProjectDir);
                            const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${activeSessionId}.jsonl`);
                            try {
                                const stats: fs.Stats = fs.statSync(jsonlPath);
                                const currentThreshold: number = Math.floor(stats.size / (5 * 1024 * 1024));
                                if (currentThreshold > lastSizeThreshold) {
                                    lastSizeThreshold = currentThreshold;
                                    backupSessionJsonl(activeSessionId, `size_threshold_${currentThreshold * 5}MB`);
                                }
                            } catch { /* file not yet written — skip */
                            }
                        }

                        // R2 backup runs AFTER sync — see new_session handler for rationale.
                        scheduleSync(async (): Promise<void> => {
                            await afterEditSync();
                            await persistResultContext(resultEvent);
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_sync', true);
                            }
                        });
                    }, captureSessionId, contextNdjson, contextUserCount, directWriteMessage);

                    // Best-effort IDE auto-connect on edit_session start
                    autoConnectIde();

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: edit_session claude process exited with code ${code}`.cyan);
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }
                        flushSync(async (): Promise<void> => {
                            await afterEditSync();
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_exit_sync', true);
                            }
                        });
                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: edit_session claude process error — ${error.message}`.red);
                        sendError(webSocket, `Failed to spawn claude: ${error.message}`);
                        claudeProcess = null;
                    });
                    break;
                }

                case 'send_message': {
                    if (!claudeProcess) {
                        sendError(webSocket, 'No active session. Send new_session or resume_session first!');
                        return;
                    }

                    const sendMsg: ISendMessageMessage = clientMessage as ISendMessageMessage;
                    const hasAttachments: boolean = !!(sendMsg.attachments && sendMsg.attachments.length > 0);

                    if ((!sendMsg.text || !sendMsg.text.trim()) && !hasAttachments) {
                        sendError(webSocket, 'Message text or attachments required!');
                        return;
                    }

                    // Intercept /ide — connect to IntelliJ IDE, do NOT forward to Claude
                    if (sendMsg.text?.trim() === '/ide') {
                        console.log('WebSocket: Intercepted /ide command — handling IDE connection'.cyan);
                        handleIdeCommand();
                        break;
                    }

                    if (hasAttachments && activeSessionId) {
                        console.log(`WebSocket: send_message with ${sendMsg.attachments!.length} attachment(s) — uploading to R2`.cyan);
                        try {
                            const result = await buildContentBlocks(sendMsg.attachments!, activeSessionId, sendMsg.text);
                            pendingAttachments.push(activeSessionId, result.attachmentMeta);
                            sendMessage(claudeProcess, sendMsg.text, result.blocks);
                        } catch (uploadError: unknown) {
                            sendError(webSocket, `Failed to upload attachments: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
                            return;
                        }
                    } else {
                        console.log('WebSocket: Sending follow-up message to existing claude process'.cyan);
                        sendMessage(claudeProcess, sendMsg.text);
                    }

                    // Trigger #4: reset idle backup timer on every user message
                    resetIdleBackupTimer();
                    break;
                }

                case 'stop_execution': {
                    if (!claudeProcess) {
                        sendError(webSocket, 'No active session to stop!');
                        break;
                    }
                    console.log('WebSocket: Received stop_execution — killing claude process (SIGTERM → SIGKILL)'.yellow);
                    killClaudeProcess(claudeProcess);
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'session_stopped'}));
                    }
                    break;
                }

                case 'switch_model': {
                    const switchMsg: ISwitchModelMessage = clientMessage as ISwitchModelMessage;

                    if (!claudeProcess || !activeSessionId) {
                        sendError(webSocket, 'No active session to switch model!');
                        break;
                    }

                    if (!switchMsg.model) {
                        sendError(webSocket, 'Model is required for switch_model!');
                        break;
                    }

                    console.log(`WebSocket: Received switch_model — switching to ${switchMsg.model} (killing current process)`.yellow);

                    // Fetch session to get projectDir for re-spawn cwd
                    const {session: switchSession, error: switchError} = await SessionService.getSessionBySessionId(activeSessionId);
                    if (switchError || !switchSession) {
                        sendError(webSocket, `Failed to fetch session for model switch: ${switchError ?? 'session not found'}`);
                        break;
                    }

                    // Trigger #2: snapshot JSONL before kill + respawn (fire-and-forget)
                    backupSessionJsonl(activeSessionId, 'before_switch_model');

                    // Kill existing process
                    killClaudeProcess(claudeProcess);
                    claudeProcess = null;

                    // Re-spawn with --resume --model (no initial message — user sends via send_message)
                    activeEffortLevel = switchMsg.effort ?? null;
                    activeThinking = typeof switchMsg.thinking === 'boolean' ? switchMsg.thinking : null;
                    const resumeMsg: IResumeSessionMessage = {
                        type: 'resume_session',
                        sessionId: activeSessionId,
                        text: '',
                        projectDir: switchSession.rawProjectDir,
                        model: switchMsg.model,
                        effort: switchMsg.effort,
                        thinking: switchMsg.thinking,
                    };

                    // Eagerly set activeProjectDir so autoSync stays scoped after the model switch,
                    // even if the system event fires without a cwd or arrives after process_exit.
                    if (resumeMsg.projectDir) {
                        activeProjectDir = resumeMsg.projectDir.replace(TRAILING_SLASHES_REGEX, '');
                    }

                    registerSession(resumeMsg.sessionId, webSocket);
                    console.log(`WebSocket: [TRACE] Eagerly registered session WS before switch spawn (sessionId: ${resumeMsg.sessionId})`.cyan);
                    claudeProcess = spawnClaude(resumeMsg, webSocket, (resultEvent: Record<string, unknown>) => {
                        persistResultContext(resultEvent);

                        // Trigger #3: size threshold backup (every 5MB boundary crossed)
                        if (activeSessionId && activeProjectDir) {
                            const hash: string = toProjectDirHash(activeProjectDir);
                            const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${activeSessionId}.jsonl`);
                            try {
                                const stats: fs.Stats = fs.statSync(jsonlPath);
                                const currentThreshold: number = Math.floor(stats.size / (5 * 1024 * 1024));
                                if (currentThreshold > lastSizeThreshold) {
                                    lastSizeThreshold = currentThreshold;
                                    backupSessionJsonl(activeSessionId, `size_threshold_${currentThreshold * 5}MB`);
                                }
                            } catch { /* file not yet written — skip */
                            }
                        }

                        // R2 backup runs AFTER sync — see new_session handler for rationale.
                        scheduleSync(async (): Promise<void> => {
                            await autoSyncWebUI();
                            await persistResultContext(resultEvent);
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_sync', true);
                            }
                        });
                    }, onSystemEvent, undefined, undefined, directWriteMessage);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: switch_model claude process exited with code ${code}`.cyan);
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }
                        flushSync(async (): Promise<void> => {
                            await autoSyncWebUI();
                            if (activeSessionId) {
                                await backupSessionJsonl(activeSessionId, 'after_exit_sync', true);
                            }
                        });
                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: switch_model claude process error — ${error.message}`.red);
                        sendError(webSocket, `Failed to spawn claude after model switch: ${error.message}`);
                        claudeProcess = null;
                    });

                    // Notify frontend that the model was switched
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'model_switched', model: switchMsg.model}));
                    }
                    break;
                }

                case 'tool_approval_response': {
                    const approvalMsg: IToolApprovalResponseMessage = clientMessage as IToolApprovalResponseMessage;
                    console.log(`WebSocket: Received tool_approval_response (requestId: ${approvalMsg.requestId}, decision: ${approvalMsg.decision}, allowAll: ${approvalMsg.allowAll ?? false})`.cyan);

                    // Allow All — persist to the active project's settings.local.json AND cache
                    // in this session so the running claude -p spawn stops prompting immediately.
                    // Errors are surfaced to the frontend but never block the current approval:
                    // the user already consented to THIS call, so we still resolve it as 'allow'.
                    if (approvalMsg.allowAll === true && approvalMsg.decision === 'allow') {
                        const meta: IPendingApprovalMeta | null = getPendingApprovalMeta(approvalMsg.requestId);
                        if (meta && activeProjectDir) {
                            try {
                                await addToolToProjectAllowList(activeProjectDir, meta.toolName);
                                addSessionAllowAll(meta.sessionId, meta.toolName);
                            } catch (error: unknown) {
                                const message: string = error instanceof Error ? error.message : String(error);
                                console.error(`WebSocket: Allow-All persistence failed for '${meta.toolName}' — ${message}`.red);
                                if (webSocket.readyState === WebSocket.OPEN) {
                                    webSocket.send(JSON.stringify({
                                        type: 'error',
                                        message: `Failed to persist Allow All for ${meta.toolName}: ${message}!`,
                                    }));
                                }
                            }
                        } else if (meta && !activeProjectDir) {
                            addSessionAllowAll(meta.sessionId, meta.toolName);
                            console.warn(`WebSocket: Allow-All for '${meta.toolName}' cached in session only — no activeProjectDir to persist to`.yellow);
                            if (webSocket.readyState === WebSocket.OPEN) {
                                webSocket.send(JSON.stringify({
                                    type: 'error',
                                    message: `Allow All for ${meta.toolName} is active for this session only — project directory not yet known, could not persist!`,
                                }));
                            }
                        }
                    }

                    const resolved: boolean = resolveApproval(approvalMsg.requestId, {
                        permissionDecision: approvalMsg.decision,
                        permissionDecisionReason: approvalMsg.reason,
                    });
                    if (!resolved) {
                        console.warn(`WebSocket: No pending approval found for requestId: ${approvalMsg.requestId} — telling frontend to dismiss stale modal`.yellow);
                        // Approval no longer pending (already resolved/cleaned up). Tell the frontend
                        // to drop any lingering queue entries for this requestId so the user stops
                        // seeing the stale modal.
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({
                                type: 'tool_approval_auto_resolved',
                                requestId: approvalMsg.requestId,
                                decision: approvalMsg.decision,
                            }));
                        }
                    }

                    // Cancel the pending openDiff call (user approved via web UI, not IDE)
                    // and close the diff tab in IntelliJ
                    if (ideService?.isConnected) {
                        ideService.cancelPendingDiff();
                        if (lastDiffTabName) {
                            ideService.closeTab(lastDiffTabName);
                        }
                    }
                    lastDiffTabName = null;
                    lastDiffRequestId = null;
                    lastDiffFilePath = null;
                    pendingIdeOverwrite = null; // web UI took over — no IDE overwrite needed
                    break;
                }

                case 'backup_session': {
                    const backupMsg = clientMessage as { type: 'backup_session'; sessionId?: string };
                    const backupSessionId: string | null = activeSessionId ?? backupMsg.sessionId ?? null;

                    if (!backupSessionId) {
                        sendError(webSocket, 'No session to backup!');
                        break;
                    }

                    // Trigger #7: manual backup button — supports both active and historical sessions
                    const doBackup = async (): Promise<void> => {
                        // For active sessions, backupSessionJsonl already knows the projectDir
                        if (activeSessionId && backupSessionId === activeSessionId) {
                            await backupSessionJsonl(activeSessionId, 'manual_button');
                            return;
                        }

                        // For historical sessions: look up projectDir from MongoDB, read local JSONL, upload
                        const {session: backupSession} = await SessionService.getSessionBySessionId(backupSessionId);
                        if (!backupSession) throw new Error('Session not found in MongoDB');

                        const localRawProjectDir: string = resolveLocalPath(backupSession.rawProjectDir);
                        const hash: string = toProjectDirHash(localRawProjectDir);
                        const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', hash, `${backupSessionId}.jsonl`);

                        if (!fs.existsSync(jsonlPath)) throw new Error('Local JSONL file not found');

                        const content: Buffer = fs.readFileSync(jsonlPath);
                        await uploadJsonlBackup(backupSessionId, content);
                        console.log(`R2: JSONL backup complete — trigger: manual_button (historical)`.green);
                    };

                    doBackup().then(() => {
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'backup_complete', success: true}));
                        }
                    }).catch((err: unknown) => {
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'backup_complete', success: false, message: `Backup failed: ${err}`}));
                        }
                    });
                    break;
                }

                default: {
                    sendError(webSocket, `Unknown message type: ${(clientMessage as any).type}`);
                }
            }
        });

        webSocket.on('close', () => {
            console.log('WebSocket: Client disconnected'.yellow);

            // Trigger #6: snapshot JSONL on session close (fire-and-forget)
            if (activeSessionId) {
                backupSessionJsonl(activeSessionId, 'ws_close');
            }

            // Clear idle backup timer
            if (idleBackupTimer) {
                clearTimeout(idleBackupTimer);
                idleBackupTimer = null;
            }

            if (activeSessionId) {
                cleanupSession(activeSessionId);
                activeSessionId = null;
            }
            if (claudeProcess) {
                console.log('WebSocket: Killing claude process (SIGTERM → SIGKILL)'.yellow);
                killClaudeProcess(claudeProcess);
                claudeProcess = null;
            }
            if (ideService) {
                ideService.disconnect();
                ideService = null;
            }
        });

        webSocket.on('error', (error: Error) => {
            console.error(`WebSocket: Connection error — ${error.message}`.red);
        });
    });

    console.log('WebSocket: WebSocketServer attached at /ws'.green.bold);

    return webSocketServer;
}

/**
 * Send an error message to the client
 */
function sendError(webSocket: WebSocket, message: string): void {
    if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({type: 'error', message}));
    }
}

/**
 * Trigger a scoped sync after each completed turn (result event).
 * When rawProjectDir is provided, only the active project is synced (sessions,
 * tasks, memories). Falls back to full sync if rawProjectDir is unknown.
 * Runs in the background — does not block the WebSocket connection.
 */
async function autoSync(rawProjectDir: string | null): Promise<void> {
    try {
        console.log('WebSocket: Auto-syncing conversation to MongoDB...'.cyan);
        const result = await SyncService.sync(rawProjectDir ? {projectDirs: [rawProjectDir]} : {});
        console.log('WebSocket: Auto-sync complete'.green, result);
    } catch (error: unknown) {
        console.error(`WebSocket: Auto-sync failed — ${error}`.red);
    }
}

export {attachWebSocket};
