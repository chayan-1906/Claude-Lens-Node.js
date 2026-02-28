import {EMessageRole} from "../models/Message";

export interface IParsedMessage {
    uuid: string;
    role: EMessageRole;
    content: string | Record<string, unknown>[];
    aiModel?: string;
    timestamp: Date;
    tokenUsage?: {
        input: number;
        output: number;
    };
}

export interface IParsedFile {
    sessionId: string;
    projectDir: string;
    gitBranch?: string;
    slug?: string;
    aiModel?: string;
    title: string;
    messages: IParsedMessage[];
}

export interface RawTask {
    id: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
}
