import {Document, model, Model, Schema} from "mongoose";

/**
 * Memory document interface
 * One document per .md file in ~/.claude/projects/{project}/memory/
 */
export interface IMemory extends Document {
    memoryId: string;   // derived from _id via toJSON
    projectDir: string; // directory name e.g. "-Users-padmanabhadas-Chayan-Personal-NodeJs"
    filePath: string;   // full path to the .md file — unique key for upsert
    content: string;    // full markdown content
    createdAt: Date;
    updatedAt: Date;
}

/** Memory model interface */
interface IMemoryModel extends Model<IMemory> {
}

/** Mongoose schema for Claude Code memory */
const MemorySchema = new Schema<IMemory>({
    projectDir: {
        type: String,
        required: true,
    },
    filePath: {
        type: String,
        required: true,
        trim: true,
        index: true,
    },
    content: {
        type: String,
        required: true,
        trim: true,
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return {
                ...rest,
                memoryId: String(_id),
            };
        },
    },
});

MemorySchema.index({projectDir: 1, filePath: 1}, {unique: true});
MemorySchema.index({content: 'text', filePath: 'text'});

/** Mongoose model for Claude Code memory */
const MemoryModel: IMemoryModel = model<IMemory, IMemoryModel>('Memory', MemorySchema);

export default MemoryModel;
