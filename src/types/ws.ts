/** ------------- Client → Server messages ------------- */

export interface INewSessionMessage {
    type: 'new_session';
    text: string;
    projectDir?: string;
}

export interface IResumeSessionMessage {
    type: 'resume_session';
    sessionId: string;
    text: string;
    newProjectDir?: string;
    projectDir?: string;
}

export interface ISendMessageMessage {
    type: 'send_message';
    text: string;
}

export interface IPingMessage {
    type: 'ping';
}

export interface IEditSessionMessage {
    type: 'edit_session';
    sessionId: string;
    editAtUuid?: string;  // present = reconstruct up to this UUID (edit); absent = reconstruct all (regenerate)
    text: string;
    projectDir?: string;
}

export interface IToolApprovalDetails {
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
}

export interface IToolApprovalDecision {
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
}

export interface IPendingApproval {
    sessionId: string;
    resolve: (decision: IToolApprovalDecision) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

/** Client → Server: interrupt/stop Claude's current execution (equivalent to Esc in terminal) */
export interface IStopExecutionMessage {
    type: 'stop_execution';
}

/** Client → Server: user's decision on a pending tool approval */
export interface IToolApprovalResponseMessage {
    type: 'tool_approval_response';
    requestId: string;
    decision: 'allow' | 'deny';
    reason?: string;
}

export type ClientMessage = INewSessionMessage | IResumeSessionMessage | ISendMessageMessage | IPingMessage | IEditSessionMessage | IStopExecutionMessage | IToolApprovalResponseMessage;


/** ------------- Server → Client messages ------------- */

export interface IProcessExitMessage {
    type: 'process_exit';
    code: number | null;
}

export interface IPongMessage {
    type: 'pong';
}

export interface IErrorMessage {
    type: 'error';
    message: string;
}

export interface IProjectNotAvailableMessage {
    type: 'project_not_available';
    sessionId: string;
    projectDir: string;
    warning: string;
    session: Record<string, unknown>;
    messages: Record<string, unknown>[];
}


/** Server → Client: tool approval request (DiffView + approve/deny) */
export interface IToolApprovalRequestMessage {
    type: 'tool_approval_request';
    requestId: string;
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
}

/** stream-json events are forwarded as-is (system, assistant, result) */
export type ServerMessage = IProcessExitMessage | IPongMessage | IErrorMessage | IProjectNotAvailableMessage | IToolApprovalRequestMessage | Record<string, unknown>;
