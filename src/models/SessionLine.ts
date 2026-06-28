import {Document, model, Schema} from "mongoose";

export type SessionLineType = | 'result' | 'system' | 'custom-title' | 'progress' | 'file-history-snapshot' | 'queue-operation' | 'last-prompt';

export interface ISessionLine extends Document {
    sessionId: string;
    lineIndex: number;
    type: SessionLineType;
    line: string;
    createdAt: Date;
    updatedAt: Date;
}

const SessionLineSchema = new Schema<ISessionLine>({
    sessionId: {
        type: String,
        required: true,
        index: true,
    },
    lineIndex: {
        type: Number,
        required: true,
    },
    type: {
        type: String,
        required: true,
        enum: ['result', 'system', 'custom-title', 'progress', 'file-history-snapshot', 'queue-operation', 'last-prompt'],
    },
    line: {
        type: String,
        required: true,
    },
}, {
    timestamps: true,
});

SessionLineSchema.index({sessionId: 1, lineIndex: 1}, {unique: true});

const SessionLineModel = model<ISessionLine>('SessionLine', SessionLineSchema);

export default SessionLineModel;
