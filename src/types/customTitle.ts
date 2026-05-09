/** Params for appending a custom-title line to a session's JSONL */
export interface IAppendCustomTitleLineParams {
    projectDirHash: string;
    sessionId: string;
    rawProjectDir: string;
    customTitle: string;
}

/** On-disk shape of the custom-title JSONL line, mirroring Claude CLI's /rename output */
export interface ICustomTitleLine {
    type: 'custom-title';
    customTitle: string;
    sessionId: string;
    uuid: string;
    timestamp: string;
    cwd: string;
}

/** On-disk shape of the agent-name JSONL line, written by Claude CLI alongside custom-title on /rename */
export interface IAgentNameLine {
    type: 'agent-name';
    agentName: string;
    sessionId: string;
}
