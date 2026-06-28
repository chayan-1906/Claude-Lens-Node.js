import fs from "fs";
import {getLocalConfig} from "./localConfig";
import type {ILocalConfig, IPathMapping} from "../types/setup";
import {NON_ALPHANUMERIC_REGEX, TRAILING_SLASHES_REGEX} from "./constants";

// --- Functions ---

/** Convert an absolute path to its Claude projects directory hash */
function toProjectDirHash(absolutePath: string): string {
    return absolutePath.replace(NON_ALPHANUMERIC_REGEX, '-');
}

/**
 * Returns the canonical path for any known alias, or the input path unchanged.
 * Strips trailing slashes before matching for consistency.
 */
function resolveCanonicalPath(rawPath: string): string {
    const config: ILocalConfig | null = getLocalConfig();
    if (!config?.pathMappings?.length) return rawPath;

    const normalized: string = rawPath.replace(TRAILING_SLASHES_REGEX, '');

    for (const mapping of config.pathMappings) {
        const normalizedPaths: string[] = mapping.paths.map((p: string) => p.replace(TRAILING_SLASHES_REGEX, ''));
        if (normalizedPaths.includes(normalized)) {
            return mapping.canonicalPath.replace(TRAILING_SLASHES_REGEX, '');
        }
    }

    return rawPath;
}

/**
 * Resolve a project directory hash to its canonical hash.
 * Used by memory sync where we have the hash (directory name) but not the raw path.
 */
function resolveProjectDirHash(dirHash: string): string {
    const config: ILocalConfig | null = getLocalConfig();
    if (!config?.pathMappings?.length) return dirHash;

    for (const mapping of config.pathMappings) {
        for (const p of mapping.paths) {
            if (toProjectDirHash(p.replace(TRAILING_SLASHES_REGEX, '')) === dirHash) {
                return toProjectDirHash(mapping.canonicalPath.replace(TRAILING_SLASHES_REGEX, ''));
            }
        }
    }

    return dirHash;
}

/**
 * Reverse of resolveCanonicalPath: given a canonical path, find which path
 * from the mapping actually exists on this machine's filesystem.
 * Used during cross-machine session resume — the canonical rawProjectDir may
 * not exist locally (e.g. /Users/... on Mac Mini is /Volumes/... on MacBook Air).
 * Returns the first existing alternative, or the input path unchanged.
 */
function resolveLocalPath(canonicalPath: string): string {
    const config: ILocalConfig | null = getLocalConfig();
    if (!config?.pathMappings?.length) return canonicalPath;

    const normalized: string = canonicalPath.replace(TRAILING_SLASHES_REGEX, '');

    for (const mapping of config.pathMappings) {
        const normalizedPaths: string[] = mapping.paths.map((p: string) => p.replace(TRAILING_SLASHES_REGEX, ''));
        if (normalizedPaths.includes(normalized)) {
            // Canonical exists locally — no remapping needed
            if (fs.existsSync(canonicalPath)) return canonicalPath;
            // Try each alternative path
            for (const altPath of mapping.paths) {
                const normalizedAlt: string = altPath.replace(TRAILING_SLASHES_REGEX, '');
                if (normalizedAlt !== normalized && fs.existsSync(normalizedAlt)) {
                    return normalizedAlt;
                }
            }
        }
    }

    return canonicalPath;
}

export {toProjectDirHash, resolveCanonicalPath, resolveProjectDirHash, resolveLocalPath};
