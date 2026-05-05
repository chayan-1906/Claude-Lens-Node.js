import {IAttachmentMeta} from "../types/ws";

/**
 * In-memory FIFO queue of attachment metadata batches awaiting attribution to
 * their human user message in MongoDB. Keyed by sessionId.
 *
 * Why this exists:
 * Claude CLI does NOT echo the human-typed user message on stream-json stdout —
 * it only writes it to the JSONL file. So attachment attribution cannot happen
 * during live stream processing; it must happen at JSONL sync time, when the
 * authoritative human user message is inserted into MongoDB.
 *
 * Flow:
 * 1. WebSocketHandler.push(sessionId, batch) when a send_message/new_session/
 *    resume_session arrives with attachments and R2 upload succeeds.
 * 2. SyncService.shift(sessionId) when it inserts a user-role message that
 *    matches the human-attachment predicate (image/document block, or a
 *    "File attached: name — url" text block, and no tool_result block).
 *
 * Each entry is one user turn's worth of attachments — a batch may contain
 * multiple files. The queue is FIFO across multiple attachment-bearing turns
 * that may sync together.
 *
 * State is per-process and lost on restart — that is acceptable. Anything
 * stranded by a restart can be repaired by repairAttachmentAttribution.ts.
 */
const queues: Map<string, IAttachmentMeta[][]> = new Map();

/** Append a batch of attachment metadata to the back of the session's queue. */
function push(sessionId: string, batch: IAttachmentMeta[]): void {
    if (!batch.length) {
        return;
    }
    const existing: IAttachmentMeta[][] | undefined = queues.get(sessionId);
    if (existing) {
        existing.push(batch);
    } else {
        queues.set(sessionId, [batch]);
    }
}

/** Remove and return the front batch for the session, or null if empty. */
function shift(sessionId: string): IAttachmentMeta[] | null {
    const existing: IAttachmentMeta[][] | undefined = queues.get(sessionId);
    if (!existing || existing.length === 0) {
        return null;
    }
    const batch: IAttachmentMeta[] = existing.shift() as IAttachmentMeta[];
    if (existing.length === 0) {
        queues.delete(sessionId);
    }
    return batch;
}

/** Number of batches queued for the session (0 when empty). */
function size(sessionId: string): number {
    return queues.get(sessionId)?.length ?? 0;
}

/** Drop all batches for the session — used when a session is abandoned. */
function clear(sessionId: string): void {
    queues.delete(sessionId);
}

export {push, shift, size, clear};
