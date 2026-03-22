import {Document, Model, model, Schema} from "mongoose";

export enum ESessionSource {
    TERMINAL = 'terminal',
    WEBUI = 'webui',
}

/**
 * Session document interface
 * One document per ~/.claude/projects/{project}/{sessionId}.jsonl file
 */
export interface ISession extends Document {
    sessionInternalId: string;      // derived from _id via toJSON (not stored)
    sessionId: string;              // JSONL filename UUID — unique key for upsert
    title: string;                  // first user message, truncated
    aiModel?: string;               // primary model used (from first assistant message)
    projectDir: string;             // hashed cwd (e.g. -Users-padmanabhadas-my-project) — used to locate ~/.claude/projects/ subdir
    rawProjectDir: string;          // original cwd as-is (e.g. /Users/padmanabhadas/my-project) — used for JSONL reconstruction
    gitBranch?: string;             // gitBranch from JSONL envelope
    slug?: string;                  // human-readable session name e.g. "golden-toasting-penguin"
    description?: string;           // optional user-provided description for the session
    titleRenamed: boolean;           // true when user explicitly renamed — prevents JSONL sync from overwriting
    source: ESessionSource;
    contextTokensUsed?: number;     // total input tokens from the latest result event
    contextWindowSize?: number;     // max context window for the model (e.g. 200000)
    parentSessionId?: string;       // sessionId of the parent session this was forked/edited from
    createdAt: Date;
    updatedAt: Date;
}

/** Session model interface */
interface ISessionModel extends Model<ISession> {
}

/** Mongoose schema for Claude Code sessions */
const SessionSchema = new Schema<ISession>({
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
    rawProjectDir: {
        type: String,
        required: true,
    },
    gitBranch: {
        type: String,
    },
    slug: {
        type: String,
    },
    description: {
        type: String,
        trim: true,
    },
    titleRenamed: {
        type: Boolean,
        default: false,
    },
    source: {
        type: String,
        enum: Object.values(ESessionSource),
        default: ESessionSource.TERMINAL,
    },
    contextTokensUsed: {
        type: Number,
    },
    contextWindowSize: {
        type: Number,
    },
    parentSessionId: {
        type: String,
        index: true,
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return {
                ...rest,
                sessionInternalId: String(_id),
            };
        },
    },
});

/** Mongoose model for Claude Code sessions */
const SessionModel: ISessionModel = model<ISession, ISessionModel>('Session', SessionSchema);

export default SessionModel;
