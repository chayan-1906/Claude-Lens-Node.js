import {EMessageRole} from "../models/Message";

/** Minimal shape of a content block — only the fields the predicate inspects */
export interface IBlock {
    type?: string;
    text?: string;
}

/** Minimal shape of a message — accepts both JSONL-parsed and lean-Mongo records */
export interface IMessageLike {
    role: EMessageRole | string;
    content: string | Array<Record<string, unknown>>;
}
