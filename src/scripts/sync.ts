import "colors";
import fs from "fs";
import "dotenv/config";
import path from "path";
import {Types} from "mongoose";
import readline from "readline";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import MessageModel from "../models/Message";
import {findJsonlFiles} from "../utils/findJsonlFiles";
import {parseJsonlFile} from "../utils/parseJsonlFile";
import {closeConnection, connectDB} from "../config/connectDB";
import {IParsedFile, IParsedMessage, RawTask} from "../types/sync";
import ConversationModel, {EConversationSource} from "../models/Conversation";

// --- Constants ---

const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');
const CLAUDE_TASKS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'tasks');

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
 * Sync all MEMORY.md files from ~/.claude/projects/{project}/memory/ to MongoDB
 * Always replaces content — memory files change frequently
 * Returns new inserts (synced) and pre-existing updates (updated) counts
 */
async function syncMemory(): Promise<{ synced: number; updated: number }> {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        return {synced: 0, updated: 0};
    }

    const projectDirs: fs.Dirent[] = fs.readdirSync(CLAUDE_PROJECTS_DIR, {withFileTypes: true})
        .filter((entry: fs.Dirent) => entry.isDirectory());

    let synced: number = 0;
    let updated: number = 0;

    for (const projectDir of projectDirs) {
        const memoryFilePath: string = path.join(CLAUDE_PROJECTS_DIR, projectDir.name, 'memory', 'MEMORY.md');
        if (!fs.existsSync(memoryFilePath)) {
            continue;
        }

        try {
            const content: string = fs.readFileSync(memoryFilePath, 'utf-8');

            const existing = await MemoryModel.findOneAndUpdate(
                {filePath: memoryFilePath},
                {
                    projectDir: projectDir.name,
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
            console.error(`  Error: ${projectDir.name}/memory/MEMORY.md — ${error}`.red);
        }
    }

    return {synced, updated};
}

/**
 * Sync all tasks from ~/.claude/tasks/ to MongoDB
 * Upserts each task — status/description may have changed since last sync
 * Returns new inserts (synced) and pre-existing updates (updated) counts
 */
async function syncTasks(): Promise<{ synced: number; updated: number }> {
    if (!fs.existsSync(CLAUDE_TASKS_DIR)) {
        return {synced: 0, updated: 0};
    }

    const sessionDirectories: fs.Dirent[] = fs.readdirSync(CLAUDE_TASKS_DIR, {withFileTypes: true})
        .filter((entry: fs.Dirent) => entry.isDirectory());

    let synced: number = 0;
    let updated: number = 0;

    for (const sessionDirectory of sessionDirectories) {
        const sessionId: string = sessionDirectory.name;
        const sessionPath: string = path.join(CLAUDE_TASKS_DIR, sessionId);
        const taskFiles: string[] = fs.readdirSync(sessionPath)
            .filter((name: string) => name.endsWith('.json'));

        for (const taskFile of taskFiles) {
            try {
                const raw: string = fs.readFileSync(path.join(sessionPath, taskFile), 'utf-8');
                const task: RawTask = JSON.parse(raw) as RawTask;

                const existing = await TaskModel.findOneAndUpdate(
                    {sessionId, id: task.id},
                    {
                        sessionId,
                        id: task.id,
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
                console.error(`  Error: ${taskFile} (session: ${sessionId}) — ${error}`.red);
            }
        }
    }

    return {synced, updated};
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
        console.log('\nNo .jsonl files found. Skipping conversations.'.yellow);
    } else {
        console.log(`\nFound ${files.length} conversation file(s)\n`.green);
    }

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

    // --- Sync Tasks ---
    console.log('\n--- Sync Tasks ---'.blue);
    const taskResult: { synced: number; updated: number } = await syncTasks();
    console.log(`  New: ${taskResult.synced}  Updated: ${taskResult.updated}`.green);

    // --- Sync Memory ---
    console.log('\n--- Sync Memory ---'.blue);
    const memoryResult: { synced: number; updated: number } = await syncMemory();
    console.log(`  New: ${memoryResult.synced}  Updated: ${memoryResult.updated}`.green);

    // 5. Summary
    console.log('\n=== Sync Complete ==='.blue.bold);
    console.log(`  Files synced: ${totalSynced}`.green);
    console.log(`  New messages: ${totalNew}`.green);
    if (totalSkipped > 0) console.log(`  Skipped: ${totalSkipped}`.yellow);
    if (totalErrors > 0) console.log(`  Errors: ${totalErrors}`.red);
    console.log(`  Tasks — new: ${taskResult.synced}, updated: ${taskResult.updated}`.green);
    console.log(`  Memory — new: ${memoryResult.synced}, updated: ${memoryResult.updated}`.green);

    // 6. Disconnect
    await closeConnection();
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error('Fatal error:'.red.bold, error);
    process.exit(1);
});
