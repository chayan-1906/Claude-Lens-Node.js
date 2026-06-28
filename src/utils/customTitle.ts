import "colors";
import fs from "fs";
import path from "path";
import {randomUUID} from "crypto";
import {CLAUDE_PROJECTS_DIR} from "./constants";
import {IAgentNameLine, IAppendCustomTitleLineParams, ICustomTitleLine} from "../types/customTitle";

// --- Constants ---

/** Bytes inspected at the head of the JSONL for the identity check */
const HEAD_CHECK_BYTES: number = 16 * 1024;

/** Bytes inspected at the tail of the JSONL for the pre-write integrity check */
const TAIL_CHECK_BYTES: number = 4 * 1024;

// --- Helpers ---

/** Parse the first non-empty parseable JSON line from a string. Returns null if none found. */
function parseFirstJsonLine(text: string): Record<string, unknown> | null {
    const lines: string[] = text.split('\n');
    for (const raw of lines) {
        const trimmed: string = raw.trim();
        if (!trimmed) continue;
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Skip malformed line and keep scanning
        }
    }
    return null;
}

/** Read a byte range from a file. Returns the decoded UTF-8 text. */
function readByteRange(filePath: string, start: number, length: number): string {
    if (length <= 0) {
        return '';
    }
    const buffer: Buffer = Buffer.alloc(length);
    const fileDescriptor: number = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fileDescriptor, buffer, 0, length, start);
    } finally {
        fs.closeSync(fileDescriptor);
    }
    return buffer.toString('utf-8');
}

/**
 * Scan readback text from end to start for a line with the given uuid.
 * Returns true if found AND its type/customTitle match the expected values.
 */
function verifyOurLineInTail(readbackText: string, expectedUuid: string, expectedCustomTitle: string): boolean {
    const lines: string[] = readbackText.split('\n');
    for (let index: number = lines.length - 1; index >= 0; index--) {
        const trimmed: string = lines[index].trim();
        if (!trimmed) {
            continue;
        }
        try {
            const parsed: Record<string, unknown> = JSON.parse(trimmed);
            if (parsed.uuid === expectedUuid) {
                return parsed.type === 'custom-title' && parsed.customTitle === expectedCustomTitle;
            }
        } catch {
            // Skip malformed line and keep scanning
        }
    }
    return false;
}

// --- Public API ---

/**
 * Append a {type:'custom-title'} line to a session's JSONL file, mirroring
 * what Claude CLI's /rename command does internally. Cornerstone of the
 * bidirectional title sync between the Web UI and JSONL.
 *
 * Safety guarantees (in order applied):
 *   1) Payload built via JSON.stringify, then re-parsed for sanity.
 *   2) Path containment: must resolve inside CLAUDE_PROJECTS_DIR, must be a
 *      regular file (no symlinks, dirs, devices).
 *   3) Identity check: first parseable line's sessionId must match.
 *   4) Pre-write tail check: trailing line is empty or parseable; warn-and-
 *      proceed otherwise (our \n prefix isolates us from prior damage).
 *   5) Atomic append: single fs.appendFileSync with `\n` + payload + `\n`.
 *      POSIX guarantees O_APPEND atomicity for concurrent appenders. The
 *      newline framing keeps our line cleanly separated under any prior state.
 *   6) Post-write read-back: scan tail for the generated uuid and verify
 *      type/customTitle round-tripped. Throws on mismatch.
 *
 * Throws on any failure. Caller translates to API errors.
 */
function appendCustomTitleLine({projectDirHash, sessionId, rawProjectDir, customTitle}: IAppendCustomTitleLineParams): void {
    console.log('Util: appendCustomTitleLine called'.cyan.italic, {sessionId, customTitle});

    // 1. Build & sanity-parse payload
    const generatedUuid: string = randomUUID();
    const payload: ICustomTitleLine = {
        type: 'custom-title',
        customTitle,
        sessionId,
        uuid: generatedUuid,
        timestamp: new Date().toISOString(),
        cwd: rawProjectDir,
    };
    const line: string = JSON.stringify(payload);
    try {
        JSON.parse(line);
    } catch (error: unknown) {
        throw new Error(`appendCustomTitleLine: built line failed sanity parse — ${(error as Error).message}`);
    }

    // 2. Path containment & file type
    const jsonlPath: string = path.join(CLAUDE_PROJECTS_DIR, projectDirHash, `${sessionId}.jsonl`);
    const relative: string = path.relative(CLAUDE_PROJECTS_DIR, jsonlPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`appendCustomTitleLine: resolved path escapes CLAUDE_PROJECTS_DIR (${jsonlPath})`);
    }
    const stats: fs.Stats = fs.statSync(jsonlPath);
    if (!stats.isFile()) {
        throw new Error(`appendCustomTitleLine: target is not a regular file (${jsonlPath})`);
    }
    const fileSize: number = stats.size;

    // 3. Identity check on first parseable line
    const headText: string = readByteRange(jsonlPath, 0, Math.min(HEAD_CHECK_BYTES, fileSize));
    const firstParsed: Record<string, unknown> | null = parseFirstJsonLine(headText);
    if (!firstParsed) {
        throw new Error(`appendCustomTitleLine: no parseable line in first ${HEAD_CHECK_BYTES} bytes of ${jsonlPath}`);
    }
    if (firstParsed.sessionId !== sessionId) {
        throw new Error(`appendCustomTitleLine: identity mismatch — file's first line says sessionId=${String(firstParsed.sessionId)}, expected ${sessionId}`);
    }

    // 4. Pre-write tail check (warn-and-proceed)
    const tailStart: number = Math.max(0, fileSize - TAIL_CHECK_BYTES);
    const tailLength: number = fileSize - tailStart;
    if (tailLength > 0) {
        const tailText: string = readByteRange(jsonlPath, tailStart, tailLength);
        const tailLines: string[] = tailText.split('\n');
        const lastLine: string = tailLines[tailLines.length - 1].trim();
        if (lastLine) {
            try {
                JSON.parse(lastLine);
            } catch {
                console.warn(`Util: appendCustomTitleLine — pre-existing trailing line is not parseable JSON; proceeding (\\n prefix isolates our write)`.yellow, {sessionId});
            }
        }
    }

    // 5. Atomic append with newline framing — write custom-title + agent-name together.
    // The CLI's /rename writes both lines; agent-name is what the CLI title bar reads on resume.
    const agentNamePayload: IAgentNameLine = {type: 'agent-name', agentName: customTitle, sessionId};
    const agentNameLine: string = JSON.stringify(agentNamePayload);
    fs.appendFileSync(jsonlPath, `\n${line}\n${agentNameLine}\n`);

    // 6. Post-write read-back
    const newFileSize: number = fs.statSync(jsonlPath).size;
    const readbackLength: number = Math.min(newFileSize, TAIL_CHECK_BYTES + line.length + 64);
    const readbackStart: number = newFileSize - readbackLength;
    const readbackText: string = readByteRange(jsonlPath, readbackStart, readbackLength);
    const verified: boolean = verifyOurLineInTail(readbackText, generatedUuid, customTitle);
    if (!verified) {
        throw new Error(`appendCustomTitleLine: post-write verification failed — generated uuid ${generatedUuid} not found or mismatched in trailing ${readbackLength} bytes`);
    }

    console.log('Util: appendCustomTitleLine succeeded'.cyan, {sessionId, customTitle, uuid: generatedUuid});
}

/**
 * In-memory equivalent of appendCustomTitleLine for R2-backed sessions.
 * Takes the raw JSONL content string, verifies the session identity, appends
 * custom-title + agent-name lines, and returns the updated content — ready to
 * re-upload to R2. Never touches disk.
 *
 * Throws if the content has no parseable first line or the sessionId mismatches.
 */
function appendCustomTitleLineToContent(content: string, sessionId: string, customTitle: string, rawProjectDir: string): string {
    console.log('Util: appendCustomTitleLineToContent called'.cyan.italic, {sessionId, customTitle});

    const firstParsed: Record<string, unknown> | null = parseFirstJsonLine(content);
    if (!firstParsed) {
        throw new Error(`appendCustomTitleLineToContent: no parseable line in R2 JSONL content for session ${sessionId}`);
    }
    if (firstParsed.sessionId !== sessionId) {
        throw new Error(`appendCustomTitleLineToContent: identity mismatch — content's first line says sessionId=${String(firstParsed.sessionId)}, expected ${sessionId}`);
    }

    const generatedUuid: string = randomUUID();
    const payload: ICustomTitleLine = {
        type: 'custom-title',
        customTitle,
        sessionId,
        uuid: generatedUuid,
        timestamp: new Date().toISOString(),
        cwd: rawProjectDir,
    };
    const agentNamePayload: IAgentNameLine = {type: 'agent-name', agentName: customTitle, sessionId};

    console.log('Util: appendCustomTitleLineToContent succeeded'.cyan, {sessionId, customTitle, uuid: generatedUuid});
    return content + `\n${JSON.stringify(payload)}\n${JSON.stringify(agentNamePayload)}\n`;
}

export {appendCustomTitleLine, appendCustomTitleLineToContent};
