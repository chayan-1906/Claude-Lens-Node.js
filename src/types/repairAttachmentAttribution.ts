import {Types} from "mongoose";
import {IAttachmentMeta} from "./ws";

/** Lean projection of a Message document used by the repair script */
export interface ILeanMessage {
    _id: Types.ObjectId;
    uuid: string;
    role: string;
    content: string | Array<Record<string, unknown>>;
    attachments?: IAttachmentMeta[];
    timestamp: Date;
}

/** Lean projection of a Session document used by the repair script */
export interface ILeanSession {
    _id: Types.ObjectId;
    sessionId: string;
}

/** Per-session counts the repair script reports back */
export interface ISessionRepairResult {
    sessionId: string;
    paired: number;
    orphanWrong: number;
}

/** A pending attachments-move from a wrong (tool_result) message to its right (human) message */
export interface IPlannedMove {
    rightId: Types.ObjectId;
    rightUuid: string;
    wrongId: Types.ObjectId;
    wrongUuid: string;
    attachments: IAttachmentMeta[];
}
