# Analysis: VS Code Extension VSIX Installer Collisions

This document explains why version 1.0.3 "collided" with 1.0.2 on Windows and how the update process works under the hood.

---

## 1. The Core Update Mechanism
VS Code identifies your extension solely by its **Extension ID** (`publisher.name`). In your case, this is `IdanDavidAviv.readme-preview-read-aloud`.

When you install a new VSIX:
- VS Code matches the Extension ID.
- It extracts the new version into a new directory: `%USERPROFILE%\.vscode\extensions\IdanDavidAviv.readme-preview-read-aloud-1.0.3`.
- It attempts to mark the old directory (`...-1.0.2`) for deletion or immediately removes it.

---

## 2. Why the "Collision" Happens
Since your extension runs a **local WebSocket Bridge Server** and has an **Audio Engine**, it creates persistent side effects that typical extensions don't have.

### A. Windows File System Locks (The Primary Culprit)
Your `BridgeServer` serves files directly from the extension's folder (`dist/media`).
- **The Lock:** If a Webview (Mission Control) is open, or if the Bridge Server is still sending a large file, Windows **locks the directory**.
- **The Failure:** When VS Code tries to delete the 1.0.2 folder during the 1.0.3 install, Windows blocks the operation. This leads to a partial/corrupt installation or two version folders existing simultaneously, which confuses the VS Code extension loader.

### B. Lingering Network Processes
Extensions are told to `deactivate()` when updating, but Node.js processes don't always exit "cleanly" in milliseconds.
- If the 1.0.2 server stays bound to port 3001 even for a few seconds too long, the 1.0.3 server will start, detect the port is taken, and shift to 3002.
- This creates a **"Zombie State"** where the UI might be talking to the old version's server while the new version's logic is running in the background.

### C. Persistent Webview Context
If `retainContextWhenHidden` is set to `true` (which it is in your `extension.ts`), the webview's process survives longer than expected, maintaining the file lock on `speechEngine.html`.

---

## 3. How to Avoid Breaking the Extension

To make the installer collision-proof, we should implement these engineering safeguards:

### 1. Atomic Deactivation
We must ensure `deactivate()` is **absolute**. It shouldn't just "ask" the server to stop; it should forcefully close all active WebSocket connections and kill any audio playback engines immediately.

### 2. High-Integrity Versioning
Ensure the `publisher` and `name` in `package.json` are **immutable**. Changing even a single letter in the name will cause VS Code to treat version 1.0.3 as a "different extension" than 1.0.2, leading to duplicate sidebar icons and resource wars.

### 3. Port Shifting Logic
Your current logic already handles "Port in use" by shifting (e.g., 3001 -> 3002). This is a good safety net, but we should ensure the **Dashboard UI** is always informed of the *actual* port being used by the *newest* active version.

---

## 4. Best Practices for Local Testing
When testing VSIX updates manually:
1.  **Stop Playback:** Ensure the audio engine is stopped.
2.  **Close Dashboard:** Close the Mission Control webview.
3.  **Clean Install:** It is always safer to **Uninstall** -> **Reload Window** -> **Install VSIX**, rather than installing "on top" during an active session.

---

> [!TIP]
> **Recommended Fix:** I can implement a more aggressive `deactivate()` handler that kills all child processes and clears resource handles to ensure the folder is unlocked as soon as VS Code requests an update.
