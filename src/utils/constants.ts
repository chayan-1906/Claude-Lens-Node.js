import path from "path";

export const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;
export const TRAILING_SLASHES_REGEX = /\/+$/;
export const CRLF_REGEX = /\r\n/g;

/** Regex to validate Cloudflare R2 endpoint URL format */
export const R2_ENDPOINT_REGEX: RegExp = /^https:\/\/[a-f0-9]+\.r2\.cloudflarestorage\.com$/;

/** Base directory where Claude Code stores project session data */
export const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');

/** Base directory where Claude Code stores tasks data */
export const CLAUDE_TASKS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'tasks');
