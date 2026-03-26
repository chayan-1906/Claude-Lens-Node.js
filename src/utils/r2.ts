import "colors";
import convert from "heic-convert";
import {_Object, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {IAttachment, IAttachmentMeta, IBuildContentBlocksResult} from "../types/ws";

/** MIME types that require conversion to JPEG before upload (Claude API only accepts JPEG/PNG/GIF/WebP) */
const HEIC_MIME_TYPES: Set<string> = new Set(['image/heic', 'image/heif']);

/** S3-compatible client configured for Cloudflare R2 — lazily initialized */
let r2Client: S3Client | null = null;

/**
 * (Re-)initialize the S3Client from current process.env values.
 * Called on server startup after injecting R2 config, and again
 * whenever credentials are updated via the Setup UI.
 */
function initR2Client(): void {
    r2Client = new S3Client({
        region: 'auto',
        endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID ?? '',
            secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY ?? '',
        },
    });
    console.debug('DEBUG: R2 S3Client initialized'.cyan);
}

/** Return the current S3Client, initializing on first call if needed */
function getR2Client(): S3Client {
    if (!r2Client) {
        initR2Client();
    }
    return r2Client!;
}

/**
 * Upload a single attachment to R2 under `<sessionId>/<timestamp>-<filename>`.
 * Returns the publicly accessible URL for the uploaded object.
 */
async function uploadToR2(attachment: IAttachment, sessionId: string): Promise<string> {
    const key: string = `${sessionId}/${Date.now()}-${attachment.name}`;
    const buffer: Buffer = Buffer.from(attachment.data, 'base64');

    await getR2Client().send(new PutObjectCommand({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: attachment.mimeType,
    }));

    const publicUrl: string = `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${key}`;
    console.log(`R2: Uploaded ${attachment.name} (${(buffer.length / 1024).toFixed(1)} KB) → ${publicUrl}`.green);
    return publicUrl;
}

/**
 * Delete all R2 objects for a given session (prefix: `<sessionId>/`).
 * Called when a session is deleted from Claude Lens.
 */
async function deleteSessionAttachments(sessionId: string): Promise<number> {
    const listed = await getR2Client().send(new ListObjectsV2Command({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
        Prefix: `${sessionId}/`,
    }));

    if (!listed.Contents?.length) {
        return 0;
    }

    await getR2Client().send(new DeleteObjectsCommand({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
        Delete: {
            Objects: listed.Contents.map((object: _Object) => ({Key: object.Key!})),
        },
    }));

    const count: number = listed.Contents.length;
    console.log(`R2: Deleted ${count} attachment(s) for session ${sessionId}`.yellow);
    return count;
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
    const blocks: Record<string, unknown>[] = [];
    const attachmentMeta: IAttachmentMeta[] = [];

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
            blocks.push({type: 'image', source: {type: 'url', url}});
        } else if (effectiveAttachment.mimeType === 'application/pdf') {
            blocks.push({type: 'document', source: {type: 'url', url}});
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

export {initR2Client, uploadToR2, deleteSessionAttachments, buildContentBlocks};
