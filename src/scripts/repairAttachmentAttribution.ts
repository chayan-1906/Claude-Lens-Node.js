import "colors";
import mongoose from "mongoose";
import SessionModel from "../models/Session";
import {IAttachmentMeta} from "../types/ws";
import {connectDB, closeConnection} from "../config/connectDB";
import {isHumanAttachmentMessage} from "../utils/attachmentPredicate";
import MessageModel, {EMessageRole, IMessage} from "../models/Message";
import {ILeanMessage, ILeanSession, IPlannedMove, ISessionRepairResult} from "../types/repairAttachmentAttribution";

/**
 * One-off repair for sessions affected by the historical mis-attribution bug
 * in directWriteMessage: attachments uploaded with a user message were being
 * stamped onto the first synthetic tool_result user-role event, instead of
 * the human-typed user message that actually owned them.
 *
 * What this script does, per session, in chronological order:
 *   1. Walks user-role messages.
 *   2. Tracks the most recent "right candidate" — a user message matching the
 *      human-attachment predicate (image / document / "File attached: ..."
 *      text block, no tool_result block) that has no `attachments` set yet.
 *   3. When it sees a "wrong message" — a user message whose content has a
 *      tool_result block AND whose `attachments` field is non-empty — it
 *      pairs the wrong message with the pending right candidate, moving
 *      `attachments` from the wrong document to the right one.
 *   4. Wrong messages with no preceding right candidate are reported but
 *      left unchanged.
 *
 * Idempotent: a paired right candidate gets `attachments` set, the wrong
 * gets `attachments` unset. Re-running the script then finds nothing to do.
 *
 * Usage:
 *   npx ts-node src/scripts/repairAttachmentAttribution.ts            # dry-run
 *   npx ts-node src/scripts/repairAttachmentAttribution.ts --apply    # commit
 */

/** A user-role message is "wrong" if it has attachments AND content with a tool_result block. */
function isWrongMessage(message: ILeanMessage): boolean {
    if (!Array.isArray(message.content)) return false;
    if (!message.attachments || message.attachments.length === 0) return false;
    return (message.content as Array<Record<string, unknown>>).some(
        (block: Record<string, unknown>) => block.type === 'tool_result',
    );
}

async function planSessionRepair(session: ILeanSession): Promise<IPlannedMove[]> {
    const messages: ILeanMessage[] = await MessageModel
        .find({sessionInternalId: session._id, role: EMessageRole.USER}, {_id: 1, uuid: 1, role: 1, content: 1, attachments: 1, timestamp: 1})
        .sort({timestamp: 1})
        .lean<ILeanMessage[]>();

    const moves: IPlannedMove[] = [];
    let pendingRight: ILeanMessage | null = null;

    for (const message of messages) {
        const wrong: boolean = isWrongMessage(message);
        const right: boolean = !wrong
            && isHumanAttachmentMessage({role: message.role, content: message.content})
            && (!message.attachments || message.attachments.length === 0);

        if (right) {
            pendingRight = message;
            continue;
        }
        if (wrong) {
            if (pendingRight) {
                moves.push({
                    rightId: pendingRight._id,
                    rightUuid: pendingRight.uuid,
                    wrongId: message._id,
                    wrongUuid: message.uuid,
                    attachments: message.attachments as IAttachmentMeta[],
                });
                pendingRight = null;
            }
        }
    }

    return moves;
}

async function applyMoves(moves: IPlannedMove[]): Promise<void> {
    if (moves.length === 0) return;

    // Type explicitly as AnyBulkWriteOperation<IMessage>[] so the $set/$unset
    // payloads are checked against the Message schema rather than collapsing to
    // Record<string, unknown> (which mongoose's bulkWrite signature rejects).
    const ops: mongoose.AnyBulkWriteOperation<IMessage>[] = moves.flatMap((move: IPlannedMove) => [
        {
            updateOne: {
                filter: {_id: move.rightId, $or: [{attachments: {$exists: false}}, {attachments: {$size: 0}}]},
                update: {$set: {attachments: move.attachments}},
            },
        },
        {
            updateOne: {
                filter: {_id: move.wrongId},
                update: {$unset: {attachments: 1}},
            },
        },
    ]);

    const CHUNK: number = 1000;
    for (let i: number = 0; i < ops.length; i += CHUNK) {
        await MessageModel.bulkWrite(ops.slice(i, i + CHUNK), {ordered: false});
    }
}

async function countOrphans(session: ILeanSession, paired: IPlannedMove[]): Promise<number> {
    const messages: ILeanMessage[] = await MessageModel
        .find({sessionInternalId: session._id, role: EMessageRole.USER}, {_id: 1, uuid: 1, role: 1, content: 1, attachments: 1, timestamp: 1})
        .sort({timestamp: 1})
        .lean<ILeanMessage[]>();

    const pairedWrongIds: Set<string> = new Set(paired.map((move: IPlannedMove) => String(move.wrongId)));
    let orphans: number = 0;
    for (const message of messages) {
        if (isWrongMessage(message) && !pairedWrongIds.has(String(message._id))) {
            orphans++;
        }
    }
    return orphans;
}

async function repairAll(applyChanges: boolean): Promise<void> {
    const sessions: ILeanSession[] = await SessionModel.find({}, {_id: 1, sessionId: 1}).lean<ILeanSession[]>();
    console.log(`Scanning ${sessions.length} session(s)...`.cyan);
    console.log();

    let touchedSessions: number = 0;
    let totalPaired: number = 0;
    let totalOrphans: number = 0;

    for (const session of sessions) {
        const moves: IPlannedMove[] = await planSessionRepair(session);
        const orphans: number = await countOrphans(session, moves);
        if (moves.length === 0 && orphans === 0) continue;

        touchedSessions++;
        totalPaired += moves.length;
        totalOrphans += orphans;

        const result: ISessionRepairResult = {sessionId: session.sessionId, paired: moves.length, orphanWrong: orphans};
        const verb: string = applyChanges ? 'pairing' : 'would pair';
        console.log(`  Session ${result.sessionId} — ${verb} ${result.paired}, orphan-wrong ${result.orphanWrong}`.green);
        for (const move of moves) {
            console.log(`    move ${move.attachments.length} attachment(s): ${move.wrongUuid} → ${move.rightUuid}`.gray);
        }

        if (applyChanges) {
            await applyMoves(moves);
        }
    }

    console.log();
    console.log('--- Summary ---'.cyan.bold);
    console.log(`Sessions affected:               ${touchedSessions}`);
    console.log(`Wrong→right pairs ${applyChanges ? 'fixed' : 'planned'}:        ${totalPaired}`);
    console.log(`Orphan wrong messages (skipped): ${totalOrphans}`);
    if (!applyChanges && totalPaired > 0) {
        console.log();
        console.log('Re-run with --apply to commit changes.'.yellow.bold);
    }
}

async function main(): Promise<void> {
    const applyChanges: boolean = process.argv.includes('--apply');

    if (applyChanges) {
        console.log('APPLY mode — changes will be written to MongoDB.'.red.bold);
    } else {
        console.log('DRY-RUN mode — no changes will be made. Pass --apply to commit.'.yellow.bold);
    }
    console.log();

    const connection = await connectDB();
    if (!connection) {
        console.error('No MongoDB URI configured — cannot run repair.'.red.bold);
        process.exit(1);
    }

    try {
        await repairAll(applyChanges);
    } finally {
        await closeConnection();
    }

    process.exit(0);
}

main().catch((error: unknown) => {
    console.error('Repair script failed:'.red.bold, error);
    process.exit(1);
});
