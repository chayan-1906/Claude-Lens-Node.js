import path from "path";

export const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;
export const TRAILING_SLASHES_REGEX = /\/+$/;
export const CRLF_REGEX = /\r\n/g;

/** Regex to validate Cloudflare R2 endpoint URL format */
export const R2_ENDPOINT_REGEX: RegExp = /^https:\/\/[a-f0-9]+\.r2\.cloudflarestorage\.com$/;

/** PDF filename slug — collapse runs of non-alphanumerics into a single dash */
export const PDF_SLUG_NON_ALNUM_REGEX: RegExp = /[^a-zA-Z0-9]+/g;

/** PDF filename slug — strip leading / trailing dashes */
export const PDF_SLUG_TRIM_DASHES_REGEX: RegExp = /^-+|-+$/g;

/** HTML escape — used by the PDF template to encode user-controlled text */
export const HTML_ESCAPE_AMP_REGEX: RegExp = /&/g;
export const HTML_ESCAPE_LT_REGEX: RegExp = /</g;
export const HTML_ESCAPE_GT_REGEX: RegExp = />/g;
export const HTML_ESCAPE_DQUOTE_REGEX: RegExp = /"/g;
export const HTML_ESCAPE_SQUOTE_REGEX: RegExp = /'/g;

/** Base directory where Claude Code stores project session data */
export const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');

/** Base directory where Claude Code stores tasks data */
export const CLAUDE_TASKS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'tasks');
