import * as vscode from 'vscode';

export interface TelemetryEvent {
    event: string;
    properties?: Record<string, any>;
    timestamp: number;
}

export class Telemetry {
    private static _events: TelemetryEvent[] = [];
    private static _logger: (msg: string) => void = console.log;

    public static init(logger: (msg: string) => void) {
        this._logger = logger;
    }

    public static track(event: string, properties?: Record<string, any>) {
        const payload: TelemetryEvent = {
            event,
            properties,
            timestamp: Date.now()
        };
        this._events.push(payload);
        this._logger(`[TELEMETRY] ${event} ${JSON.stringify(properties || {})}`);
        
        // In a real production app, we'd send this to an endpoint
        // For now, we just log to the output channel via the logger
    }

    public static getHistory() {
        return this._events;
    }

    public static clearHistory() {
        this._events = [];
    }
}
