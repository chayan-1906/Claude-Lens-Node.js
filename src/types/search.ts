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

export interface ISearchMessageResponse {
    _type: 'message';
    messageId: string;
    uuid: string;
    snippet: string;
    role: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
    timestamp: string;
}

export interface ISearchSessionResponse {
    _type: 'session';
    sessionId: string;
    snippet: string;
    title: string;
    description?: string;
    projectDir: string;
    updatedAt: string;
}

export interface ISearchTaskResponse {
    _type: 'task';
    taskInternalId: string;
    snippet: string;
    subject: string;
    status: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
}

export interface ISearchMemoryResponse {
    _type: 'memory';
    memoryId: string;
    snippet: string;
    filePath: string;
    projectDir: string;
}

export interface ISearchResponse {
    messages: ISearchMessageResponse[];
    sessions: ISearchSessionResponse[];
    tasks: ISearchTaskResponse[];
    memories: ISearchMemoryResponse[];
}
