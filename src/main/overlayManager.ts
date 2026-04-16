import { BrowserWindow, screen, ipcMain } from 'electron';
import * as path from 'path';

export interface UnderlinePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  keyword?: string;
}

export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;

  createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

    console.log(`→ Creating overlay window: ${width}x${height}`);

    this.overlayWindow = new BrowserWindow({
      width,
      height,
      x: 0,
      y: 0,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      hasShadow: false,
      title: 'keywords-highlighter-overlay', // Identifiable title for filtering
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/preload.js')
      }
    });

    // Make window click-through by default
    this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    // Exclude from screen capture (macOS: window won't appear in screenshots)
    this.overlayWindow.setContentProtection(true);

    // Listen for mouse region updates from renderer
    ipcMain.on('set-mouse-region', (event, hasHoverRegion: boolean) => {
      if (this.overlayWindow) {
        // If hovering over underline, allow mouse events; otherwise ignore
        this.overlayWindow.setIgnoreMouseEvents(!hasHoverRegion, { forward: true });
      }
    });

    // Keep window on all workspaces
    this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Debug: log when page loads
    this.overlayWindow.webContents.on('did-finish-load', () => {
      console.log('✓ Overlay window loaded successfully');
    });

    this.overlayWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('✗ Overlay window failed to load:', errorCode, errorDescription);
    });

    // Open DevTools for debugging
    this.overlayWindow.webContents.openDevTools({ mode: 'detach' });

    // Load overlay HTML
    const htmlPath = path.join(__dirname, '../renderer/overlay.html');
    console.log(`→ Loading overlay HTML from: ${htmlPath}`);
    this.overlayWindow.loadFile(htmlPath);

    // Prevent window from closing
    this.overlayWindow.on('close', (e) => {
      e.preventDefault();
    });

    console.log('✓ Overlay window created');
  }

  drawUnderlines(positions: UnderlinePosition[]) {
    if (this.overlayWindow) {
      console.log(`→ Sending draw-underlines to overlay: ${positions.length} positions`);
      positions.forEach((pos, i) => {
        console.log(`  [${i}] x=${pos.x.toFixed(0)}, y=${pos.y.toFixed(0)}, w=${pos.width.toFixed(0)}, h=${pos.height.toFixed(0)}`);
      });
      this.overlayWindow.webContents.send('draw-underlines', positions);
    } else {
      console.error('✗ Overlay window not available');
    }
  }

  clearUnderlines() {
    if (this.overlayWindow) {
      console.log('→ Sending clear-underlines to overlay');
      this.overlayWindow.webContents.send('clear-underlines');
    }
  }

  destroy() {
    if (this.overlayWindow) {
      this.overlayWindow.destroy();
      this.overlayWindow = null;
    }
  }
}
