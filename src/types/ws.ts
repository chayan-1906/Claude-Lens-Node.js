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
}

export interface ISendMessageMessage {
    type: 'send_message';
    text: string;
}

export interface IPingMessage {
    type: 'ping';
}

export interface IRunCommandMessage {
    type: 'run_command';
    command: string;
    projectDir?: string;
}

export interface ICommandInputMessage {
    type: 'command_input';
    data: string;
}

export type ClientMessage = INewSessionMessage | IResumeSessionMessage | ISendMessageMessage | IPingMessage | IRunCommandMessage | ICommandInputMessage;


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

export interface ICommandOutputMessage {
    type: 'command_output';
    data: string;
}

export interface ICommandDoneMessage {
    type: 'command_done';
    exitCode: number | null;
}
