import "colors";
import {_Object, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {IAttachment} from "../types/ws";
import {CLOUDFLARE_ACCESS_KEY_ID, CLOUDFLARE_R2_BUCKET_NAME, CLOUDFLARE_R2_ENDPOINT, CLOUDFLARE_R2_PUBLIC_URL, CLOUDFLARE_SECRET_ACCESS_KEY} from "../config/config";

/** S3-compatible client configured for Cloudflare R2 */
const r2Client: S3Client = new S3Client({
    region: 'auto',
    endpoint: CLOUDFLARE_R2_ENDPOINT,
    credentials: {
        accessKeyId: CLOUDFLARE_ACCESS_KEY_ID ?? '',
        secretAccessKey: CLOUDFLARE_SECRET_ACCESS_KEY ?? '',
    },
});

/**
 * Upload a single attachment to R2 under `<sessionId>/<timestamp>-<filename>`.
 * Returns the publicly accessible URL for the uploaded object.
 */
async function uploadToR2(attachment: IAttachment, sessionId: string): Promise<string> {
    const key: string = `${sessionId}/${Date.now()}-${attachment.name}`;
    const buffer: Buffer = Buffer.from(attachment.data, 'base64');

    await r2Client.send(new PutObjectCommand({
        Bucket: CLOUDFLARE_R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: attachment.mimeType,
    }));

    const publicUrl: string = `${CLOUDFLARE_R2_PUBLIC_URL}/${key}`;
    console.log(`R2: Uploaded ${attachment.name} (${(buffer.length / 1024).toFixed(1)} KB) → ${publicUrl}`.green);
    return publicUrl;
}

/**
 * Delete all R2 objects for a given session (prefix: `<sessionId>/`).
 * Called when a session is deleted from Claude Lens.
 */
async function deleteSessionAttachments(sessionId: string): Promise<number> {
    const listed = await r2Client.send(new ListObjectsV2Command({
        Bucket: CLOUDFLARE_R2_BUCKET_NAME,
        Prefix: `${sessionId}/`,
    }));

    if (!listed.Contents?.length) {
        return 0;
    }

    await r2Client.send(new DeleteObjectsCommand({
        Bucket: CLOUDFLARE_R2_BUCKET_NAME,
        Delete: {
            Objects: listed.Contents.map((object: _Object) => ({Key: object.Key!})),
        },
    }));

    const count: number = listed.Contents.length;
    console.log(`R2: Deleted ${count} attachment(s) for session ${sessionId}`.yellow);
    return count;
}

/**
 * Process attachments into Claude API content blocks.
 * - Images          → upload to R2 → { type: 'image', source: { type: 'url', url } }
 * - PDFs            → upload to R2 → { type: 'document', source: { type: 'url', url } }
 * - Text/code files → read content inline → { type: 'text', text: 'File: ...' }
 * Appends the user's text message as the final text block.
 */
async function buildContentBlocks(attachments: IAttachment[], sessionId: string, text: string): Promise<Record<string, unknown>[]> {
    const blocks: Record<string, unknown>[] = [];

    for (const attachment of attachments) {
        if (attachment.mimeType.startsWith('image/')) {
            const url: string = await uploadToR2(attachment, sessionId);
            blocks.push({type: 'image', source: {type: 'url', url}});
        } else if (attachment.mimeType === 'application/pdf') {
            const url: string = await uploadToR2(attachment, sessionId);
            blocks.push({type: 'document', source: {type: 'url', url}});
        } else {
            // Text/code files: upload to R2, send URL reference — Claude uses WebFetch to read content
            const url: string = await uploadToR2(attachment, sessionId);
            blocks.push({type: 'text', text: `File attached: ${attachment.name} — ${url}`});
        }
    }

    // Append user text last — Claude performs best with images/documents before text
    if (text && text.trim()) {
        blocks.push({type: 'text', text});
    }

    return blocks;
}

export {uploadToR2, deleteSessionAttachments, buildContentBlocks};
