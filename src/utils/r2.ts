import "colors";
import convert from "heic-convert";
import {IR2Config} from "../types/setup";
import {getR2Config} from "./localConfig";
import {IAttachment, IAttachmentMeta, IBuildContentBlocksResult} from "../types/ws";
import {_Object, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";

/** MIME types that require conversion to JPEG before upload (Claude API only accepts JPEG/PNG/GIF/WebP) */
const HEIC_MIME_TYPES: Set<string> = new Set(['image/heic', 'image/heif']);

/** S3-compatible client configured for Cloudflare R2 — lazily initialized */
let r2Client: S3Client | null = null;

/**
 * (Re-)initialize the S3Client from ~/.claude-lens/config.json R2 credentials.
 * Called on server startup and again whenever credentials are updated via the Setup UI.
 */
function initR2Client(): void {
    const config: IR2Config | null = getR2Config();
    if (!config) {
        console.debug('DEBUG: R2 S3Client not initialized — no R2 config'.cyan);
        r2Client = null;
        return;
    }
    r2Client = new S3Client({
        region: 'auto',
        endpoint: config.endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
    console.debug('DEBUG: R2 S3Client initialized'.cyan);
}

/** Return the current S3Client, initializing on first call if needed. Returns null when R2 is unconfigured. */
function getR2Client(): S3Client | null {
    if (!r2Client) {
        initR2Client();
    }
    return r2Client;
}

/**
 * Upload a single attachment to R2 under `<sessionId>/<timestamp>-<filename>`.
 * Returns the publicly accessible URL for the uploaded object.
 */
async function uploadToR2(attachment: IAttachment, sessionId: string): Promise<string> {
    const config: IR2Config | null = getR2Config();
    if (!config) throw new Error('R2 is not configured — cannot upload attachment');
    const client: S3Client | null = getR2Client();
    if (!client) throw new Error('R2 client not initialized — cannot upload attachment');
    const key: string = `${sessionId}/${Date.now()}-${attachment.name}`;
    const buffer: Buffer = Buffer.from(attachment.data, 'base64');

    await client.send(new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: buffer,
        ContentType: attachment.mimeType,
    }));

    const publicUrl: string = `${config.publicUrl}/${key}`;
    console.log(`R2: Uploaded ${attachment.name} (${(buffer.length / 1024).toFixed(1)} KB) → ${publicUrl}`.green);
    return publicUrl;
}

/**
 * Delete all R2 objects for a given session (prefix: `<sessionId>/`).
 * Called when a session is deleted from Claude Lens.
 */
async function deleteSessionAttachments(sessionId: string): Promise<number> {
    const config: IR2Config | null = getR2Config();
    if (!config) return 0;
    const client: S3Client | null = getR2Client();
    if (!client) return 0;
    const listed = await client.send(new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: `${sessionId}/`,
    }));

    if (!listed.Contents?.length) {
        return 0;
    }

    await client.send(new DeleteObjectsCommand({
        Bucket: config.bucketName,
        Delete: {
            Objects: listed.Contents.map((object: _Object) => ({Key: object.Key!})),
        },
    }));

    const count: number = listed.Contents.length;
    console.log(`R2: Deleted ${count} attachment(s) for session ${sessionId}`.yellow);
    return count;
}

/**
 * Delete a specific set of R2 objects by their full public URLs.
 * Extracts the object key from each URL using the configured publicUrl prefix.
 * Silently skips any URL that doesn't start with the configured publicUrl.
 * Returns the count of objects submitted for deletion.
 */
async function deleteAttachmentsByUrls(urls: string[]): Promise<number> {
    console.debug('deleteAttachmentsByUrls:'.cyan, urls);
    if (!urls.length) return 0;
    const config: IR2Config | null = getR2Config();
    if (!config) return 0;
    const client: S3Client | null = getR2Client();
    if (!client) return 0;

    const prefix: string = config.publicUrl + '/';
    const keys: { Key: string }[] = urls
        .filter((url: string) => url.startsWith(prefix))
        .map((url: string) => ({Key: url.substring(prefix.length)}));

    if (!keys.length) return 0;

    const CHUNK_SIZE: number = 1000;
    const promises: Promise<unknown>[] = [];
    for (let index: number = 0; index < keys.length; index += CHUNK_SIZE) {
        const chunk: { Key: string }[] = keys.slice(index, index + CHUNK_SIZE);
        promises.push(client.send(new DeleteObjectsCommand({
            Bucket: config.bucketName,
            Delete: {Objects: chunk},
        })));
    }
    await Promise.all(promises);

    console.log(`R2: Deleted ${keys.length} object(s) by URL`.yellow);
    return keys.length;
}

/**
 * Process attachments into Claude API content blocks + persisted metadata.
 * - Images          → upload to R2 → { type: 'image', source: { type: 'url', url } }
 * - PDFs            → upload to R2 → { type: 'document', source: { type: 'url', url } }
 * - Text/code files → upload to R2 → { type: 'text', text: 'File attached: name — url' }
 * Appends the user's text message as the final text block.
 * Returns both content blocks (for Claude CLI stdin) and attachment metadata (for MongoDB).
 */
async function buildContentBlocks(attachments: IAttachment[], sessionId: string, text: string): Promise<IBuildContentBlocksResult> {
    const config: IR2Config | null = getR2Config();
    const blocks: Record<string, unknown>[] = [];
    const attachmentMeta: IAttachmentMeta[] = [];

    if (!config) {
        if (!text || !text.trim()) {
            // Attachments-only with no R2 — nothing to send to Claude
            throw new Error('R2 is not configured — attachments cannot be uploaded');
        }
        // R2 unconfigured but text is present — skip attachments, return text-only blocks
        blocks.push({type: 'text', text});
        return {blocks, attachmentMeta};
    }

    for (const attachment of attachments) {
        // Convert HEIC/HEIF → JPEG before upload — Claude API only accepts JPEG/PNG/GIF/WebP
        let effectiveAttachment: IAttachment = attachment;
        if (HEIC_MIME_TYPES.has(attachment.mimeType.toLowerCase())) {
            console.log(`R2: Converting ${attachment.name} (${attachment.mimeType}) → JPEG`.cyan);
            const inputBuffer: Buffer = Buffer.from(attachment.data, 'base64');
            const jpegBuffer: Buffer = Buffer.from(await convert({buffer: inputBuffer, format: 'JPEG', quality: 0.9}));
            const convertedName: string = attachment.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
            effectiveAttachment = {
                name: convertedName,
                mimeType: 'image/jpeg',
                data: jpegBuffer.toString('base64'),
                size: jpegBuffer.length,
            };
            console.log(`R2: Converted ${attachment.name} (${(inputBuffer.length / 1024).toFixed(1)} KB) → ${convertedName} (${(jpegBuffer.length / 1024).toFixed(1)} KB)`.cyan);
        }

        const url: string = await uploadToR2(effectiveAttachment, sessionId);
        attachmentMeta.push({name: effectiveAttachment.name, mimeType: effectiveAttachment.mimeType, size: effectiveAttachment.size, r2Url: url});

        if (effectiveAttachment.mimeType.startsWith('image/')) {
            blocks.push({type: 'image', source: {type: 'base64', media_type: effectiveAttachment.mimeType, data: effectiveAttachment.data}});
        } else if (effectiveAttachment.mimeType === 'application/pdf') {
            blocks.push({type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: effectiveAttachment.data}});
        } else {
            // Text/code files: send URL reference — Claude uses WebFetch to read content
            blocks.push({type: 'text', text: `File attached: ${effectiveAttachment.name} — ${url}`});
        }
    }

    // Append user text last — Claude performs best with images/documents before text
    if (text && text.trim()) {
        blocks.push({type: 'text', text});
    }

    return {blocks, attachmentMeta};
}

/** Check if R2 credentials are configured in ~/.claude-lens/config.json */
function isR2Configured(): boolean {
    return getR2Config() !== null;
}

/**
 * Upload a session JSONL backup to R2 at `<sessionId>/<sessionId>.jsonl`.
 * Best-effort: returns the public URL on success, or null if R2 is unconfigured / upload fails.
 * Stored under the same session prefix as attachments.
 */
async function uploadJsonlBackup(sessionId: string, jsonlContent: string | Buffer): Promise<string | null> {
    const config: IR2Config | null = getR2Config();
    if (!config) return null;
    const client: S3Client | null = getR2Client();
    if (!client) return null;
    try {
        const key: string = `${sessionId}/${sessionId}.jsonl`;
        await client.send(new PutObjectCommand({
            Bucket: config.bucketName,
            Key: key,
            Body: jsonlContent,
            ContentType: 'application/x-ndjson',
        }));
        const url: string = `${config.publicUrl}/${key}`;
        console.log(`R2: JSONL backup uploaded — ${sessionId} (${(Buffer.byteLength(jsonlContent) / 1024).toFixed(1)} KB)`.green);
        return url;
    } catch (err: unknown) {
        console.warn(`R2: JSONL backup upload failed — ${err}`.yellow);
        return null;
    }
}

/**
 * Download a session JSONL backup from R2.
 * Returns the JSONL content string if found, or null if not found / R2 unconfigured / error.
 */
async function downloadJsonlBackup(sessionId: string): Promise<string | null> {
    const config: IR2Config | null = getR2Config();
    if (!config) return null;
    const client: S3Client | null = getR2Client();
    if (!client) return null;
    try {
        const key: string = `${sessionId}/${sessionId}.jsonl`;
        const resp = await client.send(new GetObjectCommand({
            Bucket: config.bucketName,
            Key: key,
        }));
        return await resp.Body?.transformToString() ?? null;
    } catch {
        return null;
    }
}

export {initR2Client, uploadToR2, deleteSessionAttachments, deleteAttachmentsByUrls, buildContentBlocks, isR2Configured, uploadJsonlBackup, downloadJsonlBackup};
