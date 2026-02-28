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

export {findJsonlFiles};
