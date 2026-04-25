import * as fs from 'fs';

export interface LogReportConfig {
    nativeLogUri?: { fsPath: string };
    debugLogPath?: string;
}

/**
 * Utility to generate standardized diagnostic log reports for the Virgo extension.
 */
export class LogReporter {
    /**
     * Builds log content for the requested type.
     */
    public static build(type: 'native' | 'debug', config: LogReportConfig): string {
        const pidHeader = `PID: ${process.pid}\n`;
        
        if (type === 'native') {
            let content = `${pidHeader}--- [VIRGO LOGS START] ---\n`;
            if (config.nativeLogUri && fs.existsSync(config.nativeLogUri.fsPath)) {
                content += fs.readFileSync(config.nativeLogUri.fsPath, 'utf8');
            } else {
                content += "Native log URI not initialized or inaccessible.";
            }
            return content;
        } else {
            let content = `${pidHeader}PATH: ${config.debugLogPath || 'unknown'}\n--- [EXTENSION DEBUG LOGS START] ---\n`;
            if (config.debugLogPath && fs.existsSync(config.debugLogPath)) {
                content += fs.readFileSync(config.debugLogPath, 'utf8');
            } else {
                content += "Debug log file not found at project root.";
            }
            return content;
        }
    }
}
