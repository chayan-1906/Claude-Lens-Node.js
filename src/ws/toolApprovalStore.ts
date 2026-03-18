import {WebSocket} from "ws";
import {IPendingApproval, IToolApprovalDecision, IToolApprovalDetails} from "../types/ws";

/** ------------- Session → WebSocket registry ------------- */

const sessionWebSockets: Map<string, WebSocket> = new Map();

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


/** ------------- Pending approval requests ------------- */

const APPROVAL_TIMEOUT_MS: number = 300_000; // 5 minutes — well within the hook's 600s default
const pendingApprovals: Map<string, IPendingApproval> = new Map();

/**
 * Create a pending approval and send the request to the frontend via WebSocket.
 * Returns a Promise that resolves when the frontend responds (approve/deny).
 * Rejects if the WebSocket is unavailable or the request times out.
 */
function createApproval(details: IToolApprovalDetails): Promise<IToolApprovalDecision> {
    const ws: WebSocket | undefined = getSessionWebSocket(details.sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`No active WebSocket for session ${details.sessionId}`));
    }

    return new Promise<IToolApprovalDecision>((resolve, reject) => {
        const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
            pendingApprovals.delete(details.requestId);
            reject(new Error(`Approval request timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`));
        }, APPROVAL_TIMEOUT_MS);

        pendingApprovals.set(details.requestId, {resolve, reject, timeout});

        // Send approval request to the frontend
        ws.send(JSON.stringify({
            type: 'tool_approval_request',
            requestId: details.requestId,
            sessionId: details.sessionId,
            toolName: details.toolName,
            toolInput: details.toolInput,
            toolUseId: details.toolUseId,
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
        clearTimeout(pending.timeout);
        pending.reject(new Error('Session disconnected'));
        pendingApprovals.delete(requestId);
    }
    unregisterSession(sessionId);
}

export {registerSession, unregisterSession, getSessionWebSocket, createApproval, resolveApproval, cleanupSession};
