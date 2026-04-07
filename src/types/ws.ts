/** ------------- Client → Server messages ------------- */

/** A file attachment sent with a message (base64-encoded) */
export interface IAttachment {
    name: string;
    mimeType: string;
    data: string;   // base64-encoded file bytes
    size: number;
}

/** Persisted attachment metadata (stored in MongoDB alongside messages — no base64 data) */
export interface IAttachmentMeta {
    name: string;
    mimeType: string;
    size: number;
    r2Url: string;
}

/** Return type of buildContentBlocks — content blocks for Claude CLI + metadata for MongoDB */
export interface IBuildContentBlocksResult {
    blocks: Record<string, unknown>[];
    attachmentMeta: IAttachmentMeta[];
}

export interface INewSessionMessage {
    type: 'new_session';
    text: string;
    projectDir?: string;
    model?: string;
    effort?: string;
    thinking?: boolean;
    attachments?: IAttachment[];
    allowedDirs?: string[];
}

export interface IResumeSessionMessage {
    type: 'resume_session';
    sessionId: string;
    text: string;
    newProjectDir?: string;
    projectDir?: string;
    model?: string;
    effort?: string;
    thinking?: boolean;
    attachments?: IAttachment[];
    allowedDirs?: string[];
}

export interface ISendMessageMessage {
    type: 'send_message';
    text: string;
    attachments?: IAttachment[];
}

export interface IPingMessage {
    type: 'ping';
}

/** Client → Server: request current IDE connection status (sent on frontend mount) */
export interface IRequestIdeStatusMessage {
    type: 'request_ide_status';
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

/** Client → Server: switch the model mid-conversation (kill + re-spawn with --resume --model) */
export interface ISwitchModelMessage {
    type: 'switch_model';
    model: string;
    effort?: string;
    thinking?: boolean;
}

/** Client → Server: user's decision on a pending tool approval */
export interface IToolApprovalResponseMessage {
    type: 'tool_approval_response';
    requestId: string;
    decision: 'allow' | 'deny';
    reason?: string;
}

/** Client → Server: trigger manual JSONL backup to R2 (sessionId for historical sessions, omit for active) */
export interface IBackupSessionMessage {
    type: 'backup_session';
    sessionId?: string;
}

export type ClientMessage = INewSessionMessage | IResumeSessionMessage | ISendMessageMessage | IPingMessage | IRequestIdeStatusMessage | IEditSessionMessage | IStopExecutionMessage | ISwitchModelMessage | IToolApprovalResponseMessage | IBackupSessionMessage;


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

/** Server → Client: confirms the Claude process was killed after stop_execution */
export interface ISessionStoppedMessage {
    type: 'session_stopped';
}

/** Server → Client: IDE (IntelliJ) connected via MCP */
export interface IIdeConnectedMessage {
    type: 'ide_connected';
    ideName: string;
    port: number;
}

/** Server → Client: IDE disconnected */
export interface IIdeDisconnectedMessage {
    type: 'ide_disconnected';
    reason?: string;
}

/** Server → Client: IDE cursor/file selection changed */
export interface IIdeSelectionChangedMessage {
    type: 'ide_selection_changed';
    filePath: string;
    fileName: string;
    lineNumber: number;
}

/** Server → Client: IDE connection or tool call error */
export interface IIdeErrorMessage {
    type: 'ide_error';
    message: string;
}

/** Server → Client: JSONL backup to R2 completed (response to backup_session) */
export interface IBackupCompleteMessage {
    type: 'backup_complete';
    success: boolean;
    message?: string;
}

/** stream-json events are forwarded as-is (system, assistant, result) */
export type ServerMessage = IProcessExitMessage | IPongMessage | IErrorMessage | IProjectNotAvailableMessage | IToolApprovalRequestMessage | ISessionStoppedMessage | IBackupCompleteMessage | IIdeConnectedMessage | IIdeDisconnectedMessage | IIdeSelectionChangedMessage | IIdeErrorMessage | Record<string, unknown>;
