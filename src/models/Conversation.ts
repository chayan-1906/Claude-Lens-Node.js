import {Document, Model, model, Schema} from "mongoose";

export enum EConversationSource {
    TERMINAL = 'terminal',
    WEBUI = 'webui',
}

/**
 * Conversation document interface
 * One document per ~/.claude/projects/{project}/{sessionId}.jsonl file
 */
export interface IConversation extends Document {
    conversationId: string;   // derived from _id via toJSON (not stored)
    sessionId: string;        // JSONL filename UUID — unique key for upsert
    title: string;            // first user message, truncated
    aiModel?: string;         // primary model used (from first assistant message)
    projectDir: string;       // cwd from JSONL envelope
    gitBranch?: string;       // gitBranch from JSONL envelope
    slug?: string;            // human-readable session name e.g. "golden-toasting-penguin"
    source: EConversationSource;
    createdAt: Date;
    updatedAt: Date;
}

/** Conversation model interface */
interface IConversationModel extends Model<IConversation> {
}

/** Mongoose schema for Claude Code conversations */
const ConversationSchema = new Schema<IConversation>({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    title: {
        type: String,
        required: true,
        trim: true,
    },
    aiModel: {
        type: String,
    },
    projectDir: {
        type: String,
        required: true,
    },
    gitBranch: {
        type: String,
    },
    slug: {
        type: String,
    },
    source: {
        type: String,
        enum: Object.values(EConversationSource),
        default: EConversationSource.TERMINAL,
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return {
                ...rest,
                conversationId: String(_id),
            };
        },
    },
});

/** Mongoose model for Claude Code conversations */
const ConversationModel: IConversationModel = model<IConversation, IConversationModel>('Conversation', ConversationSchema);

export default ConversationModel;
