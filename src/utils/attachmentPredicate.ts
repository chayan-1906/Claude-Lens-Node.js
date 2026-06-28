import {EMessageRole} from "../models/Message";
import {IBlock, IMessageLike} from "../types/attachmentPredicate";

/**
 * Matches the exact text-block shape that buildContentBlocks (utils/r2.ts)
 * writes for non-image, non-PDF attachments — currently:
 *     "File attached: <name> — <https://...>"
 * If buildContentBlocks ever changes this format, update the regex too.
 */
const FILE_ATTACHED_PATTERN: RegExp = /^File attached: .+ — https?:\/\/.+$/;

/**
 * True when the message is the authoritative human user message that an
 * attachment batch should be attributed to:
 *   - role === 'user'
 *   - content is an array (multimodal)
 *   - content has at least one of:
 *       • image block
 *       • document block
 *       • text block matching the "File attached: name — url" pattern
 *   - content has NO tool_result block (those are synthetic user turns and
 *     must never be attributed)
 *
 * Used both at sync time (live attribution) and by the repair script
 * (post-hoc attribution of historical mis-attributions).
 */
function isHumanAttachmentMessage(message: IMessageLike): boolean {
    if (message.role !== EMessageRole.USER && message.role !== 'user') return false;
    if (!Array.isArray(message.content)) return false;

    let hasAttachmentBlock: boolean = false;
    for (const block of message.content as IBlock[]) {
        if (block.type === 'tool_result') return false;
        if (block.type === 'image' || block.type === 'document') {
            hasAttachmentBlock = true;
        } else if (block.type === 'text' && typeof block.text === 'string' && FILE_ATTACHED_PATTERN.test(block.text.trim())) {
            hasAttachmentBlock = true;
        }
    }
    return hasAttachmentBlock;
}

export {isHumanAttachmentMessage, FILE_ATTACHED_PATTERN};
