import "colors";
import crypto from "crypto";
import {Request, Response} from "express";
import {IToolApprovalDecision, IToolApprovalDetails} from "../types/ws";
import {createApproval, wasSessionEverRegistered} from "../ws/toolApprovalStore";

/**
 * POST /api/v1/tool-approval
 * Called by the PreToolUse hook shell script (blocking curl).
 * Receives tool details from the hook's stdin, creates a pending approval,
 * waits for the frontend user to approve/deny, then returns the permissionDecision JSON.
 */
const toolApprovalController = async (req: Request, res: Response) => {
    console.info('Controller: toolApprovalController started'.bgBlue.white.bold);

    // Extract session_id before the try block so it remains accessible in the catch.
    const {session_id, tool_name, tool_input, tool_use_id} = req.body as {
        session_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_use_id: string;
    };

    try {
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

        // If this session_id was NEVER registered as a Claude Lens session, the hook fired
        // from the main Claude Code instance (terminal/IDE), not from a Lens-spawned process.
        // Return "allow" so the hook is a no-op and Claude Code proceeds normally.
        // This prevents the "sensitive file" error that occurs when "ask" triggers Claude Code's
        // native sensitive-file prompt in a context where no terminal is available.
        if (!wasSessionEverRegistered(session_id)) {
            console.log('Controller: toolApprovalController — unknown session (not a Lens session), allowing through'.cyan, {session_id, reason: message});
            res.status(200).json({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                },
            });
            return;
        }

        // Known Lens session with a transient error (WS gone, timeout, disconnect).
        // Fall back to "ask" so the native Claude Code terminal prompt appears.
        console.log('Controller: toolApprovalController — Lens session error, falling back to native prompt'.cyan, {session_id, reason: message});
        res.status(200).json({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
            },
        });
    }
};

export {toolApprovalController};
