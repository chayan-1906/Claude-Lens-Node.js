import "dotenv/config";
import "colors";
import fs from "fs";
import path from "path";
import readline from "readline";
import {Types} from "mongoose";
import {connectDB, closeConnection} from "../config/connectDB";
import ConversationModel, {EConversationSource} from "../models/Conversation";
import MessageModel, {EMessageRole} from "../models/Message";

// --- Constants ---

const CLAUDE_PROJECTS_DIR: string = path.join(
    process.env.HOME || '~',
    '.claude',
    'projects',
);
const TITLE_MAX_LENGTH: number = 60;

// --- Types ---

interface ParsedMessage {
    uuid: string;
    role: EMessageRole;
    content: string | Record<string, unknown>[];
    aiModel?: string;
    timestamp: Date;
    tokenUsage?: {
        input: number;
        output: number;
    };
}

interface ParsedFile {
    sessionId: string;
    projectDir: string;
    gitBranch?: string;
    slug?: string;
    aiModel?: string;
    title: string;
    messages: ParsedMessage[];
}

// --- Functions ---

/**
 * Prompt user for project path(s) via readline
 * Returns array of validated directory paths
 */
async function promptForPaths(): Promise<string[]> {
    const rl: readline.Interface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const answer: string = await new Promise((resolve) => {
        rl.question(
            'Enter project path(s) comma-separated, or press Enter to sync all:\n> '.cyan,
            (input: string) => {
                rl.close();
                resolve(input.trim());
            }
        );
    });

    if (!answer) {
        // Sync all project directories
        if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
            console.error(`Error: ${CLAUDE_PROJECTS_DIR} does not exist`.red.bold);
            process.exit(1);
        }

        const dirs: string[] = fs.readdirSync(CLAUDE_PROJECTS_DIR, {withFileTypes: true})
            .filter((entry: fs.Dirent) => entry.isDirectory())
            .map((entry: fs.Dirent) => path.join(CLAUDE_PROJECTS_DIR, entry.name));

        console.log(`Found ${dirs.length} project directories`.green);
        return dirs;
    }

    // Validate user-provided paths
    // Accepts real project paths (e.g. /Users/padmanabhadas/Chayan_Personal/NodeJs)
    // and converts them to ~/.claude/projects/ directory names
    const paths: string[] = answer.split(',').map((p: string) => p.trim());
    const validPaths: string[] = [];

    for (const p of paths) {
        // First: try converting real project path to Claude projects directory
        // /Users/padmanabhadas/Chayan_Personal/NodeJs → -Users-padmanabhadas-Chayan-Personal-NodeJs
        const claudeDirName: string = p.replace(/[^a-zA-Z0-9]/g, '-');
        const claudePath: string = path.join(CLAUDE_PROJECTS_DIR, claudeDirName);
        if (fs.existsSync(claudePath) && fs.statSync(claudePath).isDirectory()) {
            validPaths.push(claudePath);
            console.log(`  Resolved: ${p} → ${claudePath}`.gray);
            continue;
        }

        // Second: try the path as-is (direct ~/.claude/projects/... path)
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
            validPaths.push(p);
            continue;
        }

        console.warn(`Warning: Skipping invalid path: ${p}`.yellow);
    }

    if (validPaths.length === 0) {
        console.error('Error: No valid paths provided'.red.bold);
        process.exit(1);
    }

    return validPaths;
}

/**
 * Find all .jsonl files at the top level of given directories
 * Skips subdirectories (subagent files, tool-results)
 */
function findJsonlFiles(dirs: string[]): string[] {
    const files: string[] = [];

    for (const dir of dirs) {
        try {
            const entries: string[] = fs.readdirSync(dir);
            for (const entry of entries) {
                if (entry.endsWith('.jsonl')) {
                    files.push(path.join(dir, entry));
                }
            }
        } catch (err: unknown) {
            console.warn(`Warning: Could not read directory ${dir}: ${err}`.yellow);
        }
    }

    return files;
}

/**
 * Parse a single JSONL file into structured conversation data
 * Returns null if file has no user/assistant messages
 */
function parseJsonlFile(filePath: string): ParsedFile | null {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = raw.split('\n');

    const messages: ParsedMessage[] = [];
    let sessionId: string = '';
    let projectDir: string = '';
    let gitBranch: string | undefined;
    let slug: string | undefined;
    let aiModel: string | undefined;
    let title: string = '';

    for (let i: number = 0; i < lines.length; i++) {
        const line: string = lines[i].trim();
        if (!line) continue;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line);
        } catch {
            console.warn(`  Warning: Malformed JSON at line ${i + 1} in ${path.basename(filePath)}`.yellow);
            continue;
        }

        const lineType: string = parsed.type as string;

        // Extract metadata from every line (slug can appear on later lines)
        if (!sessionId && parsed.sessionId) {
            sessionId = parsed.sessionId as string;
        }
        if (!projectDir && parsed.cwd) {
            projectDir = parsed.cwd as string;
        }
        if (parsed.gitBranch) {
            gitBranch = parsed.gitBranch as string;
        }
        if (parsed.slug) {
            slug = parsed.slug as string;
        }

        // Only store user and assistant messages
        if (lineType !== 'user' && lineType !== 'assistant') continue;

        const message: Record<string, unknown> = parsed.message as Record<string, unknown>;
        if (!message) continue;

        const role: string = message.role as string;
        if (role !== 'user' && role !== 'assistant') continue;

        const messageRole: EMessageRole = role === 'user' ? EMessageRole.USER : EMessageRole.ASSISTANT;

        // Extract title from first user message
        if (!title && role === 'user' && typeof message.content === 'string') {
            title = message.content.length > TITLE_MAX_LENGTH
                ? message.content.substring(0, TITLE_MAX_LENGTH) + '...'
                : message.content;
        }

        // Extract aiModel from first assistant message
        if (!aiModel && role === 'assistant' && message.model) {
            aiModel = message.model as string;
        }

        // Build parsed message
        const parsedMessage: ParsedMessage = {
            uuid: parsed.uuid as string,
            role: messageRole,
            content: message.content as string | Record<string, unknown>[],
            timestamp: new Date(parsed.timestamp as string),
        };

        if (role === 'assistant') {
            if (message.model) {
                parsedMessage.aiModel = message.model as string;
            }
            const usage: Record<string, unknown> | undefined = message.usage as Record<string, unknown> | undefined;
            if (usage) {
                parsedMessage.tokenUsage = {
                    input: (usage.input_tokens as number) || 0,
                    output: (usage.output_tokens as number) || 0,
                };
            }
        }

        messages.push(parsedMessage);
    }

    if (messages.length === 0) return null;

    return {
        sessionId,
        projectDir,
        gitBranch,
        slug,
        aiModel,
        title: title || 'Untitled conversation',
        messages,
    };
}

/**
 * Sync a single parsed file to MongoDB
 * Upserts conversation, incrementally inserts only new messages
 * Returns count of new messages inserted
 */
async function syncFile(parsed: ParsedFile): Promise<number> {
    // 1. Upsert conversation
    const conversation = await ConversationModel.findOneAndUpdate(
        {sessionId: parsed.sessionId},
        {
            title: parsed.title,
            aiModel: parsed.aiModel,
            projectDir: parsed.projectDir,
            gitBranch: parsed.gitBranch,
            slug: parsed.slug,
            source: EConversationSource.TERMINAL,
        },
        {upsert: true, returnDocument: 'after'},
    );

    const conversationId: Types.ObjectId = conversation._id as Types.ObjectId;

    // 2. Get existing message UUIDs for this conversation
    const existingDocs = await MessageModel.find(
        {conversationId},
        {uuid: 1}
    ).lean();
    const existingUuids: Set<string> = new Set(
        existingDocs.map((doc) => doc.uuid as string)
    );

    // 3. Filter to only new messages
    const newMessages = parsed.messages
        .filter((msg: ParsedMessage) => !existingUuids.has(msg.uuid))
        .map((msg: ParsedMessage) => ({
            uuid: msg.uuid,
            conversationId,
            role: msg.role,
            content: msg.content,
            aiModel: msg.aiModel,
            timestamp: msg.timestamp,
            tokenUsage: msg.tokenUsage,
        }));

    // 4. Bulk insert new messages
    if (newMessages.length > 0) {
        await MessageModel.insertMany(newMessages, {ordered: false});
    }

    return newMessages.length;
}

/**
 * Main orchestrator
 */
async function main(): Promise<void> {
    console.log('\n=== Claude Lens Sync ===\n'.blue.bold);

    // 1. Prompt for paths
    const dirs: string[] = await promptForPaths();

    // 2. Find JSONL files
    const files: string[] = findJsonlFiles(dirs);
    if (files.length === 0) {
        console.log('No .jsonl files found. Nothing to sync.'.yellow);
        process.exit(0);
    }
    console.log(`\nFound ${files.length} conversation file(s)\n`.green);

    // 3. Connect to MongoDB
    await connectDB();
    console.log('');

    // 4. Sync each file
    let totalSynced: number = 0;
    let totalNew: number = 0;
    let totalSkipped: number = 0;
    let totalErrors: number = 0;

    for (const file of files) {
        const filename: string = path.basename(file);
        try {
            const parsed: ParsedFile | null = parseJsonlFile(file);
            if (!parsed) {
                console.log(`  Skip: ${filename} (no user/assistant messages)`.gray);
                totalSkipped++;
                continue;
            }

            const newCount: number = await syncFile(parsed);
            const existingCount: number = parsed.messages.length - newCount;

            if (newCount > 0) {
                console.log(`  Synced: ${filename} — ${newCount} new message(s) (${existingCount} already existed)`.green);
            } else {
                console.log(`  Up-to-date: ${filename} (${existingCount} messages)`.gray);
            }

            totalSynced++;
            totalNew += newCount;
        } catch (err: unknown) {
            console.error(`  Error: ${filename} — ${err}`.red);
            totalErrors++;
        }
    }

    // 5. Summary
    console.log('\n=== Sync Complete ==='.blue.bold);
    console.log(`  Files synced: ${totalSynced}`.green);
    console.log(`  New messages: ${totalNew}`.green);
    if (totalSkipped > 0) console.log(`  Skipped: ${totalSkipped}`.yellow);
    if (totalErrors > 0) console.log(`  Errors: ${totalErrors}`.red);

    // 6. Disconnect
    await closeConnection();
    process.exit(0);
}

main().catch((err: unknown) => {
    console.error('Fatal error:'.red.bold, err);
    process.exit(1);
});
