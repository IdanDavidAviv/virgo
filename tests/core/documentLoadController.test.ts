import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentLoadController } from '@core/documentLoadController';
import * as vscode from 'vscode';
import * as path from 'path';

// Mock vscode
vi.mock('vscode', () => {
    return {
        window: {
            activeTextEditor: undefined,
            tabGroups: {
                activeTabGroup: {
                    activeTab: undefined
                }
            }
        },
        workspace: {
            getWorkspaceFolder: vi.fn(),
            openTextDocument: vi.fn()
        },
        Uri: {
            file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}`, path: p }),
            parse: (s: string) => ({ toString: () => s, path: s })
        }
    };
});

describe('DocumentLoadController', () => {
    let controller: DocumentLoadController;
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new DocumentLoadController(logger);
    });

    it('should initialize with empty state', () => {
        expect(controller.chapters).toEqual([]);
        expect(controller.metadata.fileName).toBe('No Document');
    });

    it('should clear state correctly', () => {
        // Manually "populate" state for test (via updateMetadata if it was public, but let's just test clear)
        controller.clear();
        expect(controller.chapters).toEqual([]);
        expect(controller.metadata.fileName).toBe('No File Loaded');
    });

    it('should compress long paths/UUIDs', () => {
        const longPath = 'brain/c32e0a57-975a-4b0b-9c7b-e8ea94411f2c/test.md';
        const compressed = controller.compressPath(longPath);
        expect(compressed).toContain('...');
        expect(compressed).toBe('brain/c32e...1f2c/test.md');
    });

    it('should extract metadata from a text document', () => {
        const mockDoc = {
            uri: { fsPath: 'C:\\project\\test.md', scheme: 'file', toString: () => 'file:///C:/project/test.md' },
            fileName: 'C:\\project\\test.md',
            getText: () => '# Chapter 1\nHello world.'
        } as any;

        (vscode.workspace.getWorkspaceFolder as any).mockReturnValue({
            name: 'Project',
            uri: { fsPath: 'C:\\project' }
        });

        controller.updateMetadata(mockDoc);

        expect(controller.metadata.fileName).toBe('test.md');
        expect(controller.metadata.relativeDir).toBe('Project');
    });
});
