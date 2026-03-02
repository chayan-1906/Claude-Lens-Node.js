import {Document, Model, model, Schema, Types} from "mongoose";

// --- Content block types (assistant message content array) ---
type ThinkingBlock = {
    type: 'thinking';
    thinking: string;
};

type TextBlock = {
    type: 'text';
    text: string;
};

type ToolUseBlock = {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
};

type ToolResultBlock = {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error: boolean;
};

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock;

export enum EMessageRole {
    USER = 'user',
    ASSISTANT = 'assistant',
}

/**
 * Message document interface
 * user content  → string
 * assistant content → ContentBlock[] (thinking, text, tool_use, tool_result blocks)
 */
export interface IMessage extends Document {
    messageId: string;                      // derived from _id via toJSON (not stored)
    uuid: string;                           // JSONL envelope uuid — deduplication key for re-sync
    sessionInternalId: Types.ObjectId;         // ref: Session
    role: EMessageRole;
    content: string | ContentBlock[];
    aiModel?: string;                       // present only on assistant messages
    timestamp: Date;                        // original timestamp from JSONL envelope
    tokenUsage?: {
        input: number;
        output: number;
    };
    createdAt: Date;
    updatedAt: Date;
}

/** Message model interface */
interface IMessageModel extends Model<IMessage> {
}

/** Mongoose schema for individual Claude Code messages */
const MessageSchema = new Schema<IMessage>({
    uuid: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    sessionInternalId: {
        type: Schema.Types.ObjectId,
        ref: 'Session',
        required: true,
        index: true,
    },
    role: {
        type: String,
        required: true,
        enum: Object.values(EMessageRole),
    },
    content: {
        type: Schema.Types.Mixed,
        required: true,
    },
    aiModel: {
        type: String,
    },
    timestamp: {
        type: Date,
        required: true,
    },
    tokenUsage: {
        input: {type: Number},
        output: {type: Number},
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return {
                ...rest,
                messageId: String(_id),
            };
        },
    },
});

/** Mongoose model for Claude Code messages */
const MessageModel: IMessageModel = model<IMessage, IMessageModel>('Message', MessageSchema);

export default MessageModel;
