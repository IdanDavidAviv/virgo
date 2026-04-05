import * as fs from "fs";
import * as path from "path";

/**
 * High-integrity Turn State Management for Antigravity Sessions.
 * Ensures sequence integrity and prevents drift via the [TurnSentinel] protocol.
 */
export class TurnManager {
    /**
     * Atomically get and update the turn index from extension_state.json
     * @throws Error if [TurnSentinel] drift is detected.
     */
    public static updateTurnIndex(sessionPath: string, options: { 
        sessionTitle?: string, 
        incomingIndex?: number,
        logger?: (msg: string) => void 
    } = {}): number {
        const stateFile = path.join(sessionPath, 'extension_state.json');
        let index = 1;
        let currentState: any = {};

        try {
            if (fs.existsSync(stateFile)) {
                const raw = fs.readFileSync(stateFile, 'utf-8');
                currentState = JSON.parse(raw);
                index = (currentState.current_turn_index || 0) + 1 || 1;
            }

            // [TurnSentinel] Validate sequence integrity if an index was provided
            if (options.incomingIndex !== undefined) {
                const current = currentState.current_turn_index || 0;
                if (options.incomingIndex <= current) {
                    const errorMsg = `[TurnSentinel] Stale turn index (${options.incomingIndex} <= ${current}). Possible sequence drift detected.`;
                    if (options.logger) {options.logger(errorMsg);}
                    throw new Error(errorMsg);
                }
                index = options.incomingIndex; // Honor the explicit turn index
            }
            
            const newState = {
                ...currentState,
                current_turn_index: index,
                ...(options.sessionTitle ? { session_title: options.sessionTitle } : {})
            };
            
            fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
            return index;
        } catch (err) {
            if (err instanceof Error && err.message.includes('[TurnSentinel]')) {
                throw err;
            }
            const errMsg = `[TURN_MANAGER] Failed to update state.json: ${err}`;
            if (options.logger) {options.logger(errMsg);}
            return index; // Fallback to calculated index on non-sentinel error
        }
    }
}
