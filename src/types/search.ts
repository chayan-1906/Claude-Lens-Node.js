export const VALID_SCOPES = ['session', 'project', 'global'] as const;
export type TSearchScope = typeof VALID_SCOPES[number];

export interface ISearchQuery {
    q: string;
    scope: TSearchScope;
    sessionId?: string;
    projectDir?: string;
    limit?: number;
    skip?: number;
}

export interface ISearchMessageResult {
    _type: 'message';
    messageId: string;
    snippet: string;
    role: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
    timestamp: string;
}

export interface ISearchSessionResult {
    _type: 'session';
    sessionId: string;
    snippet: string;
    title: string;
    description?: string;
    projectDir: string;
    updatedAt: string;
}

export interface ISearchTaskResult {
    _type: 'task';
    taskInternalId: string;
    snippet: string;
    subject: string;
    status: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
}

export interface ISearchMemoryResult {
    _type: 'memory';
    memoryId: string;
    snippet: string;
    filePath: string;
    projectDir: string;
}

export interface ISearchResults {
    messages: ISearchMessageResult[];
    sessions: ISearchSessionResult[];
    tasks: ISearchTaskResult[];
    memories: ISearchMemoryResult[];
}
