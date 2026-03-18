import "colors";
import crypto from "crypto";
import {Request, Response} from "express";
import {createApproval} from "../ws/toolApprovalStore";
import {IToolApprovalDecision, IToolApprovalDetails} from "../types/ws";

/**
 * POST /api/v1/tool-approval
 * Called by the PreToolUse hook shell script (blocking curl).
 * Receives tool details from the hook's stdin, creates a pending approval,
 * waits for the frontend user to approve/deny, then returns the permissionDecision JSON.
 */
const toolApprovalController = async (req: Request, res: Response) => {
    console.info('Controller: toolApprovalController started'.bgBlue.white.bold);

    try {
        const {session_id, tool_name, tool_input, tool_use_id} = req.body as {
            session_id: string;
            tool_name: string;
            tool_input: Record<string, unknown>;
            tool_use_id: string;
        };

        if (!session_id || !tool_name || !tool_input) {
            console.warn('Controller: Missing required fields in tool-approval request'.yellow.bold);
            res.status(400).json({
                error: 'Missing required fields: session_id, tool_name, tool_input',
            });
            return;
        }

        const requestId: string = crypto.randomUUID();
        console.log('Controller: Tool approval requested'.blue, {requestId, session_id, tool_name, tool_use_id});

        const details: IToolApprovalDetails = {
            requestId,
            sessionId: session_id,
            toolName: tool_name,
            toolInput: tool_input,
            toolUseId: tool_use_id,
        };

        const decision: IToolApprovalDecision = await createApproval(details);

        console.log('SUCCESS: Tool approval resolved'.bgGreen.bold, {requestId, decision: decision.permissionDecision});

        // Return the permissionDecision JSON that the hook script outputs to stdout
        res.status(200).json({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision.permissionDecision,
                ...(decision.permissionDecisionReason ? {permissionDecisionReason: decision.permissionDecisionReason} : {}),
            },
        });
    } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        console.log('Controller: toolApprovalController — no Claude Lens session, falling back to native prompt'.cyan, {reason: message});

        // On error, fall back to "ask" so the native Claude Code terminal prompt appears.
        // This handles: no WebSocket for the session (native terminal, not Claude Lens),
        // approval timeout, session disconnected, etc.
        res.status(200).json({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
            },
        });
    }
};

export {toolApprovalController};
