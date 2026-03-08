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
    sessionInternalId: string;   // derived from _id via toJSON (not stored)
    sessionId: string;        // JSONL filename UUID — unique key for upsert
    title: string;            // first user message, truncated
    aiModel?: string;         // primary model used (from first assistant message)
    projectDir: string;       // cwd from JSONL envelope
    gitBranch?: string;       // gitBranch from JSONL envelope
    slug?: string;            // human-readable session name e.g. "golden-toasting-penguin"
    source: ESessionSource;
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
    gitBranch: {
        type: String,
    },
    slug: {
        type: String,
    },
    source: {
        type: String,
        enum: Object.values(ESessionSource),
        default: ESessionSource.TERMINAL,
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
