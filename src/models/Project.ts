import {Document, model, Model, Schema} from "mongoose";

export interface IProject extends Document {
    rawProjectDir: string;
    projectDir: string;
    customName?: string;
    description?: string;
    lastSessionAt: Date;
    orphanedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

interface IProjectModel extends Model<IProject> {
}

const ProjectSchema = new Schema<IProject>({
    rawProjectDir: {
        type: String,
        required: true,
        trim: true,
        unique: true,
    },
    projectDir: {
        type: String,
        required: true,
        trim: true,
        unique: true,
    },
    customName: {
        type: String,
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    lastSessionAt: {
        type: Date,
        required: true,
        default: Date.now,
    },
    orphanedAt: {
        type: Date,
    },
}, {
    timestamps: true,
    toJSON: {
        transform(doc, ret) {
            const {_id, __v, ...rest} = ret;
            return rest;
        },
    },
});

ProjectSchema.index({orphanedAt: 1}, {expireAfterSeconds: 604800, sparse: true});

const ProjectModel: IProjectModel = model<IProject, IProjectModel>('Project', ProjectSchema);

export default ProjectModel;