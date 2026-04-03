import { SettingsDrawer } from '../components/SettingsDrawer';

/**
 * LayoutManager: Coordinates between competing UI overlays/drawers.
 * Ensures only one major interaction area is active at a time to prevent UI clutter.
 */
export class LayoutManager {
    private static instance: LayoutManager | null = null;
    private settingsDrawer?: SettingsDrawer;

    private constructor() {}

    public static getInstance(): LayoutManager {
        if (typeof window !== 'undefined') {
            if (!(window as any).__LAYOUT_MANAGER__) {
                (window as any).__LAYOUT_MANAGER__ = new LayoutManager();
            }
            return (window as any).__LAYOUT_MANAGER__;
        }
        if (!LayoutManager.instance) {
            LayoutManager.instance = new LayoutManager();
        }
        return LayoutManager.instance;
    }

    public static resetInstance(): void {
        if (typeof window !== 'undefined') {
            (window as any).__LAYOUT_MANAGER__ = undefined;
        }
        LayoutManager.instance = null;
    }

    /**
     * Registers components with the manager during the bootstrap phase.
     */
    public registerOverlay(name: string, component: any): void {
        if (name === 'settings') {
            this.settingsDrawer = component;
        }
    }

    public registerSettings(settings: SettingsDrawer): void {
        this.settingsDrawer = settings;
    }

    /**
     * Closes all active overlays (Settings, etc.)
     */
    public closeOverlays(): void {
        console.log('[LAYOUT] Closing all overlays...');
        this.settingsDrawer?.close();
    }

    /**
     * Forces the settings drawer to open while closing other potential overlays.
     */
    public showSettings(): void {
        this.closeOverlays();
        this.settingsDrawer?.open();
    }
}
