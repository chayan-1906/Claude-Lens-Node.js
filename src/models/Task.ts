import {Document, model, Model, Schema} from "mongoose";

export enum ETaskStatus {
    PENDING = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    DELETED = 'deleted',
}

/**
 * Task document interface
 * One document per ~/.claude/tasks/{sessionId}/[taskNumber].json file
 */
export interface ITask extends Document {
    taskId: string;     // derived from _id via toJSON
    sessionId: string;  // directory name under ~/.claude/tasks/
    id: string;         // task number within session ("1", "2", ...)
    subject: string;
    description: string;
    activeForm?: string;
    status: ETaskStatus;
    blocks: string[];
    blockedBy: string[];
    createdAt: Date;
    updatedAt: Date;
}

/** Task model interface */
interface ITaskModel extends Model<ITask> {
}

/** Mongoose schema for Claude Code tasks */
const TaskSchema = new Schema<ITask>({
    sessionId: {
        type: String,
        required: true,
        index: true,
    },
    id: {
        type: String,
        required: true,
        trim: true,
    },
    subject: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        required: true,
        trim: true,
    },
    activeForm: {
        type: String,
        trim: true,
    },
    status: {
        type: String,
        enum: Object.values(ETaskStatus),
        default: ETaskStatus.PENDING,
    },
    blocks: {
        type: [String],
        default: [],
    },
    blockedBy: {
        type: [String],
        default: [],
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return {
                ...rest,
                taskId: String(_id),
            };
        },
    },
});

TaskSchema.index({sessionId: 1, id: 1}, {unique: true});

/** Mongoose model for Claude Code tasks */
const TaskModel: ITaskModel = model<ITask, ITaskModel>('Task', TaskSchema);

export default TaskModel;
