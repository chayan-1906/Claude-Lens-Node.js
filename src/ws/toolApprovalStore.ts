import {WebSocket} from "ws";
import {readProjectAllowList} from "../permissions/allowList";
import {IPendingApproval, IPendingApprovalMeta, IToolApprovalDecision, IToolApprovalDetails} from "../types/ws";

/** ------------- Session → WebSocket registry ------------- */

const sessionWebSockets: Map<string, WebSocket> = new Map();

/** ------------- Session → activeProjectDir registry ------------- */

/**
 * sessionId → activeProjectDir. Populated by the WS handler whenever activeProjectDir
 * becomes known (eager from spawn message, or from the system event's cwd). Used by
 * createApproval to tell the frontend whether a subsequent 'Allow All' would persist
 * to settings.local.json (true) or be session-only (false).
 */
const sessionProjectDirs: Map<string, string> = new Map();

function setSessionProjectDir(sessionId: string, projectDir: string | null): void {
    if (projectDir) {
        sessionProjectDirs.set(sessionId, projectDir);
    } else {
        sessionProjectDirs.delete(sessionId);
    }
}

function getSessionProjectDir(sessionId: string): string | undefined {
    return sessionProjectDirs.get(sessionId);
}

/** ------------- IDE openDiff hooks ------------- */

type IdeOpenDiffHookFn = (toolName: string, toolInput: Record<string, unknown>, requestId: string) => void;
const ideOpenDiffHooks: Map<string, IdeOpenDiffHookFn> = new Map();

/**
 * Register a per-session callback invoked just before tool_approval_request is sent.
 * The callback should call IdeService.openDiff() so IntelliJ shows the diff in sync
 * with the web UI's DiffView prompt.
 */
function registerIdeOpenDiffHook(sessionId: string, fn: IdeOpenDiffHookFn): void {
    ideOpenDiffHooks.set(sessionId, fn);
}

function unregisterIdeOpenDiffHook(sessionId: string): void {
    ideOpenDiffHooks.delete(sessionId);
}

function registerSession(sessionId: string, ws: WebSocket): void {
    sessionWebSockets.set(sessionId, ws);
    console.log(`ToolApprovalStore: Registered session → WS (sessionId: ${sessionId})`.cyan);
}

function unregisterSession(sessionId: string): void {
    sessionWebSockets.delete(sessionId);
    console.log(`ToolApprovalStore: Unregistered session (sessionId: ${sessionId})`.cyan);
}

function getSessionWebSocket(sessionId: string): WebSocket | undefined {
    return sessionWebSockets.get(sessionId);
}


/** ------------- Per-session "Allow All" in-memory cache ------------- */

/**
 * sessionId → Set of toolNames the user has clicked "Allow All" on during this spawn.
 * Short-circuits approvals in the current claude -p process, which cannot re-read
 * settings.local.json mid-run. Persistence to disk is handled separately by
 * addToolToProjectAllowList — this cache only covers the live session.
 * Cleared in cleanupSession so a fresh spawn starts from the (now-updated) settings file.
 */
const sessionAllowAll: Map<string, Set<string>> = new Map();

/**
 * Read settings.local.json for the project and pre-populate sessionAllowAll with
 * every tool already in permissions.allow. Called once per session when activeProjectDir
 * becomes known (system event). This ensures tools persisted from a previous session
 * are auto-approved immediately — the PreToolUse hook always fires regardless of the
 * allow list, so without this the frontend would still show a prompt.
 */
async function initSessionAllowAll(sessionId: string, projectDir: string): Promise<void> {
    try {
        const allowList: string[] = await readProjectAllowList(projectDir);
        for (const toolName of allowList) {
            addSessionAllowAll(sessionId, toolName);
        }
        if (allowList.length > 0) {
            console.log(`ToolApprovalStore: Pre-populated session allow-all from settings (sessionId: ${sessionId}, tools: ${allowList.join(', ')})`.cyan);
        }
    } catch (error: unknown) {
        console.warn(`ToolApprovalStore: Failed to pre-populate session allow-all — ${error}`.yellow);
    }
}

function addSessionAllowAll(sessionId: string, toolName: string): void {
    let set: Set<string> | undefined = sessionAllowAll.get(sessionId);
    if (!set) {
        set = new Set<string>();
        sessionAllowAll.set(sessionId, set);
    }
    set.add(toolName);
    console.log(`ToolApprovalStore: Cached allow-all (sessionId: ${sessionId}, tool: ${toolName})`.cyan);
}

function isSessionAllowedAll(sessionId: string, toolName: string): boolean {
    return sessionAllowAll.get(sessionId)?.has(toolName) ?? false;
}


/** ------------- Pending approval requests ------------- */

const APPROVAL_TIMEOUT_MS: number = 14_400_000; // 4 hours — allows long breaks (lunch, meetings) while Claude waits for approval
const pendingApprovals: Map<string, IPendingApproval> = new Map();

/**
 * Lookup the pending approval metadata (sessionId + toolName) for a given requestId.
 * Used by the WebSocket handler when processing an allowAll response, since the
 * frontend sends back only the requestId — we need the toolName server-side to know
 * what to persist.
 */
function getPendingApprovalMeta(requestId: string): IPendingApprovalMeta | null {
    const pending: IPendingApproval | undefined = pendingApprovals.get(requestId);
    if (!pending) return null;
    return {sessionId: pending.sessionId, toolName: pending.toolName};
}

/**
 * Create a pending approval and send the request to the frontend via WebSocket.
 * Returns a Promise that resolves when the frontend responds (approve/deny).
 * Rejects if the WebSocket is unavailable or the request times out.
 *
 * Short-circuit: if the session has previously Allow-All'd this toolName, resolve
 * with 'allow' immediately — no WS round-trip, no frontend prompt.
 */
function createApproval(details: IToolApprovalDetails): Promise<IToolApprovalDecision> {
    if (isSessionAllowedAll(details.sessionId, details.toolName)) {
        console.log(`ToolApprovalStore: Auto-allowed via session cache (sessionId: ${details.sessionId}, tool: ${details.toolName})`.green);
        return Promise.resolve({permissionDecision: 'allow'});
    }

    const ws: WebSocket | undefined = getSessionWebSocket(details.sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`No active WebSocket for session ${details.sessionId}`));
    }

    return new Promise<IToolApprovalDecision>((resolve, reject) => {
        const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
            pendingApprovals.delete(details.requestId);
            reject(new Error(`Approval request timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`));
        }, APPROVAL_TIMEOUT_MS);

        pendingApprovals.set(details.requestId, {sessionId: details.sessionId, toolName: details.toolName, resolve, reject, timeout});

        // Fire IDE openDiff hook — best-effort, must never block or throw
        const ideHook: IdeOpenDiffHookFn | undefined = ideOpenDiffHooks.get(details.sessionId);
        if (ideHook) {
            try {
                ideHook(details.toolName, details.toolInput, details.requestId);
            } catch (error: unknown) {
                console.warn(`ToolApprovalStore: IDE openDiff hook failed — ${error}`);
            }
        }

        // Send approval request to the frontend
        const projectActive: boolean = !!getSessionProjectDir(details.sessionId);
        ws.send(JSON.stringify({
            type: 'tool_approval_request',
            requestId: details.requestId,
            sessionId: details.sessionId,
            toolName: details.toolName,
            toolInput: details.toolInput,
            toolUseId: details.toolUseId,
            projectActive,
        }));

        console.log(`ToolApprovalStore: Sent tool_approval_request to frontend (requestId: ${details.requestId}, tool: ${details.toolName})`.cyan);
    });
}

/**
 * Resolve a pending approval with the user's decision.
 * Called by WebSocketHandler when it receives tool_approval_response from the frontend.
 */
function resolveApproval(requestId: string, decision: IToolApprovalDecision): boolean {
    const pending: IPendingApproval | undefined = pendingApprovals.get(requestId);
    if (!pending) {
        console.warn(`ToolApprovalStore: No pending approval for requestId: ${requestId}`.yellow);
        return false;
    }

    clearTimeout(pending.timeout);
    pendingApprovals.delete(requestId);
    pending.resolve(decision);
    console.log(`ToolApprovalStore: Resolved approval (requestId: ${requestId}, decision: ${decision.permissionDecision})`.cyan);
    return true;
}

/**
 * Clean up all pending approvals for a session (e.g., on WS disconnect).
 * Rejects all pending promises so the hook's HTTP request terminates.
 */
function cleanupSession(sessionId: string): void {
    for (const [requestId, pending] of pendingApprovals.entries()) {
        if (pending.sessionId !== sessionId) continue;
        clearTimeout(pending.timeout);
        pending.reject(new Error('Session disconnected'));
        pendingApprovals.delete(requestId);
    }
    sessionAllowAll.delete(sessionId);
    sessionProjectDirs.delete(sessionId);
    unregisterSession(sessionId);
    unregisterIdeOpenDiffHook(sessionId);
}

export {registerSession, unregisterSession, getSessionWebSocket, createApproval, resolveApproval, cleanupSession, registerIdeOpenDiffHook, addSessionAllowAll, initSessionAllowAll, getPendingApprovalMeta, setSessionProjectDir};
