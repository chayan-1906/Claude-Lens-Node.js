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
}

export interface IPingMessage {
    type: 'ping';
}

export type ClientMessage = INewSessionMessage | IResumeSessionMessage | IPingMessage;


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


/** stream-json events are forwarded as-is (system, assistant, result) */
export type ServerMessage = IProcessExitMessage | IPongMessage | IErrorMessage | Record<string, unknown>;
