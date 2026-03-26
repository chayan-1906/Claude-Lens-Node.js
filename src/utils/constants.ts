export const NON_ALPHANUMERIC_REGEX = /[^a-zA-Z0-9]/g;
export const TRAILING_SLASHES_REGEX = /\/+$/;

/** Regex to validate Cloudflare R2 endpoint URL format */
export const R2_ENDPOINT_REGEX: RegExp = /^https:\/\/[a-f0-9]+\.r2\.cloudflarestorage\.com$/;
