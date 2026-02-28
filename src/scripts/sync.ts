import "colors";
import fs from "fs";
import "dotenv/config";
import path from "path";
import {Types} from "mongoose";
import readline from "readline";
import MessageModel from "../models/Message";
import {parseJsonlFile} from "../utils/parseJsonlFile";
import {IParsedFile, IParsedMessage} from "../types/sync";
import {closeConnection, connectDB} from "../config/connectDB";
import ConversationModel, {EConversationSource} from "../models/Conversation";

// --- Constants ---

const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');

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
        rl.question('Enter project path(s) comma-separated, or press Enter to sync all:\n> '.cyan, (input: string) => {
            rl.close();
            resolve(input.trim());
        });
    });

    if (!answer) {
        // Sync all project directories
        if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
            console.error(`Error: ${CLAUDE_PROJECTS_DIR} does not exist`.red.bold);
            process.exit(1);
        }

        const directories: string[] = fs.readdirSync(CLAUDE_PROJECTS_DIR, {withFileTypes: true})
            .filter((entry: fs.Dirent) => entry.isDirectory())
            .map((entry: fs.Dirent) => path.join(CLAUDE_PROJECTS_DIR, entry.name));

        console.log(`Found ${directories.length} project directories`.green);
        return directories;
    }

    // Validate user-provided paths
    // Accepts real project paths (e.g. /Users/padmanabhadas/Chayan_Personal/NodeJs)
    // and converts them to ~/.claude/projects/ directory names
    const paths: string[] = answer.split(',').map((path: string) => path.trim());
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
function findJsonlFiles(directories: string[]): string[] {
    const files: string[] = [];

    for (const directory of directories) {
        try {
            const entries: string[] = fs.readdirSync(directory);
            for (const entry of entries) {
                if (entry.endsWith('.jsonl')) {
                    files.push(path.join(directory, entry));
                }
            }
        } catch (error: unknown) {
            console.warn(`Warning: Could not read directory ${directory}: ${error}`.yellow);
        }
    }

    return files;
}

/**
 * Sync a single parsedFile file to MongoDB
 * Upserts conversation, incrementally inserts only new messages
 * Returns count of new messages inserted
 */
async function syncFile(parsedFile: IParsedFile): Promise<number> {
    // 1. Upsert conversation
    const conversation = await ConversationModel.findOneAndUpdate(
        {sessionId: parsedFile.sessionId},
        {
            title: parsedFile.title,
            aiModel: parsedFile.aiModel,
            projectDir: parsedFile.projectDir,
            gitBranch: parsedFile.gitBranch,
            slug: parsedFile.slug,
            source: EConversationSource.TERMINAL,
        },
        {upsert: true, returnDocument: 'after'},
    );

    const conversationId: Types.ObjectId = conversation._id as Types.ObjectId;

    // 2. Get existing message UUIDs for this conversation
    const existingDocs = await MessageModel.find(
        {conversationId},
        {uuid: 1},
    ).lean();
    const existingUuids: Set<string> = new Set(
        existingDocs.map((document) => document.uuid as string)
    );

    // 3. Filter to only new messages
    const newMessages = parsedFile.messages
        .filter((parsedMessage: IParsedMessage) => !existingUuids.has(parsedMessage.uuid))
        .map((parsedMessage: IParsedMessage) => ({
            uuid: parsedMessage.uuid,
            conversationId,
            role: parsedMessage.role,
            content: parsedMessage.content,
            aiModel: parsedMessage.aiModel,
            timestamp: parsedMessage.timestamp,
            tokenUsage: parsedMessage.tokenUsage,
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
    const directories: string[] = await promptForPaths();

    // 2. Find JSONL files
    const files: string[] = findJsonlFiles(directories);
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
            const parsedFile: IParsedFile | null = parseJsonlFile(file);
            if (!parsedFile) {
                console.log(`  Skip: ${filename} (no user/assistant messages)`.gray);
                totalSkipped++;
                continue;
            }

            const newCount: number = await syncFile(parsedFile);
            const existingCount: number = parsedFile.messages.length - newCount;

            if (newCount > 0) {
                console.log(`  Synced: ${filename} — ${newCount} new message(s) (${existingCount} already existed)`.green);
            } else {
                console.log(`  Up-to-date: ${filename} (${existingCount} messages)`.gray);
            }

            totalSynced++;
            totalNew += newCount;
        } catch (error: unknown) {
            console.error(`  Error: ${filename} — ${error}`.red);
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

main().catch((error: unknown) => {
    console.error('Fatal error:'.red.bold, error);
    process.exit(1);
});
