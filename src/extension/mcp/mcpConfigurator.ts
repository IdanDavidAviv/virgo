import * as fs from 'fs';
import * as path from 'path';

export interface AgentEnvironment {
    id: string;
    name: string;
    path: string;
    exists: boolean;
    hasVirgo: boolean;
}

export class McpConfigurator {
    /**
     * Scans standard AI agent configuration locations to determine if the Virgo MCP
     * server has been injected.
     */
    public static checkConfigurationStatus(): { status: 'configured' | 'unconfigured', activeAgents: string[] } {
        const agents = this.getAvailableAgents();
        const activeAgents = agents.filter(a => a.hasVirgo).map(a => a.name);
        return {
            status: activeAgents.length > 0 ? 'configured' : 'unconfigured',
            activeAgents
        };
    }

    /**
     * One-shot liveness probe. Calls `npx virgo-mcp --ping` and checks for VIRGO_MCP_OK in stdout.
     * If the binary responds within 3s → callback(true) → badge turns green.
     * Called once at extension boot (if configured) and after manual MCP install.
     */
    public static probeLiveness(callback: (alive: boolean) => void): void {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { exec } = require('child_process');
        exec('npx virgo-mcp --ping', { timeout: 3000 }, (err: any, stdout: string) => {
            callback(!err && (stdout || '').includes('VIRGO_MCP_OK'));
        });
    }

    /**
     * Returns a list of known AI agents, their config paths, and their installation status.
     */
    public static getAvailableAgents(): AgentEnvironment[] {
        const isWindows = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const isLinux = process.platform === 'linux';
        
        const appData = process.env.APPDATA || '';
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        
        const environments = [
            {
                id: 'claude',
                name: 'Claude Desktop',
                path: isWindows ? path.join(appData, 'Claude', 'claude_desktop_config.json') 
                    : isMac ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') 
                    : isLinux ? path.join(xdgConfig, 'Claude', 'claude_desktop_config.json')
                    : ''
            },
            {
                id: 'cursor_cline',
                name: 'Cursor (Cline/Roo)',
                path: isWindows ? path.join(appData, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : isMac ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : isLinux ? path.join(xdgConfig, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : ''
            },
            {
                id: 'vscode_cline',
                name: 'VS Code (Cline/Roo)',
                path: isWindows ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : isMac ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : isLinux ? path.join(xdgConfig, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
                    : ''
            },
            {
                id: 'antigravity',
                name: 'Antigravity',
                path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json')
            }
        ];

        return environments
            .filter(env => env.path !== '')
            .map(env => {
                const exists = fs.existsSync(env.path);
                let hasVirgo = false;
                if (exists) {
                    try {
                        const content = fs.readFileSync(env.path, 'utf8');
                        if (content.trim()) {
                            const config = JSON.parse(content);
                            if (config.mcpServers && config.mcpServers.virgo) {
                                hasVirgo = true;
                            }
                        }
                    } catch (e) {
                        // Ignore parse error
                    }
                }
                return { ...env, exists, hasVirgo };
            });
    }

    /**
     * Safely parses and injects the Virgo MCP server configuration into a target config JSON file.
     * Preserves existing configuration data.
     */
    public static async injectConfiguration(configPath: string, extensionPath: string, virgoRoot: string = 'virgo'): Promise<boolean> {
        // Build the Virgo server config block
        const virgoBlock = {
            command: 'npx',
            args: ['-y', 'virgo-mcp@latest'],
            env: {
                VIRGO_ROOT: virgoRoot
            }
        };

        try {
            // Ensure directory exists
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            let config: any = { mcpServers: {} };
            
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                if (content.trim() !== '') {
                    config = JSON.parse(content);
                }
            }

            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            config.mcpServers.virgo = virgoBlock;

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('[MCP Configurator] Failed to inject configuration:', err);
            return false;
        }
    }
}
