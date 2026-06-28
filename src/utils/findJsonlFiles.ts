import "colors";
import fs from "fs";
import path from "path";

/**
 * Find all .jsonl files at the top level of given directories
 * Skips subdirectories (subagent files, tool-results)
 */
function findJsonlFiles(directories: string[]): string[] {
    const files: string[] = [];

    for (const directory of directories) {
        try {
            const entries: string[] = fs.readdirSync(directory);
            let count: number = 0;
            for (const entry of entries) {
                if (entry.endsWith('.jsonl')) {
                    files.push(path.join(directory, entry));
                    count++;
                }
            }
            console.debug('DEBUG: Scanned directory for .jsonl files'.cyan, {directory, found: count});
        } catch (error: unknown) {
            console.warn(`Warning: Could not read directory ${directory}: ${error}`.yellow);
        }
    }

    console.debug('DEBUG: Total .jsonl files found'.cyan, {total: files.length, directories: directories.length});
    return files;
}

export {findJsonlFiles};
