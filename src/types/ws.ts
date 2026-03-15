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

/** Client → Server: interrupt/stop Claude's current execution (equivalent to Esc in terminal) */
export interface IStopExecutionMessage {
    type: 'stop_execution';
}

export type ClientMessage = INewSessionMessage | IResumeSessionMessage | ISendMessageMessage | IPingMessage | IEditSessionMessage | IStopExecutionMessage;


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


/** stream-json events are forwarded as-is (system, assistant, result) */
export type ServerMessage = IProcessExitMessage | IPongMessage | IErrorMessage | IProjectNotAvailableMessage | Record<string, unknown>;
