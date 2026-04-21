import { BrowserWindow, screen, ipcMain } from 'electron';
import * as path from 'path';

export interface UnderlinePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  keyword?: string;
}

export interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;
  private selectionMenuVisible: boolean = false;
  private selectionRegionInteracting: boolean = false;
  private captureModeActive: boolean = false;

  private toOverlayPoint(point: { x: number; y: number }) {
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
      x: point.x,
      y: point.y - primaryDisplay.workArea.y
    };
  }

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
      this.updateMouseInterception(hasHoverRegion);
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

    this.overlayWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const prefix = level === 3 ? '✗' : '→';
      console.log(`${prefix} [OverlayConsole] ${message} (${sourceId}:${line})`);
    });

    // Open DevTools for debugging
    // this.overlayWindow.webContents.openDevTools({ mode: 'detach' });

    // Load overlay HTML
    const htmlPath = path.join(__dirname, '../renderer/overlay.html');
    console.log(`→ Loading overlay HTML from: ${htmlPath}`);
    this.overlayWindow.loadFile(htmlPath);

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

  showSelectionMenu(text: string, actionLabel: string = '摘抄文本') {
    if (!this.overlayWindow) return;

    const cursor = screen.getCursorScreenPoint();
    const overlayPoint = this.toOverlayPoint(cursor);
    console.log(`→ Showing selection menu at (${cursor.x}, ${cursor.y}), textLength=${text.length}`);
    this.selectionMenuVisible = true;
    this.overlayWindow.setFocusable(true);
    this.overlayWindow.focus();
    this.updateMouseInterception(true);
    this.overlayWindow.webContents.send('show-selection-menu', {
      x: overlayPoint.x,
      y: overlayPoint.y,
      text,
      actionLabel
    });
  }

  hideSelectionMenu() {
    if (!this.overlayWindow) return;

    console.log('→ Hiding selection menu');
    this.selectionMenuVisible = false;
    this.overlayWindow.blur();
    this.overlayWindow.setFocusable(false);
    this.updateMouseInterception(false);
    this.overlayWindow.webContents.send('hide-selection-menu');
  }

  isSelectionMenuShown() {
    return this.selectionMenuVisible;
  }

  showSelectionRegion(region: SelectionRegion) {
    if (!this.overlayWindow) return;
    const overlayOrigin = this.toOverlayPoint({ x: region.x, y: region.y });
    this.overlayWindow.webContents.send('show-selection-region', {
      ...region,
      x: overlayOrigin.x,
      y: overlayOrigin.y
    });
  }

  hideSelectionRegion() {
    if (!this.overlayWindow) return;
    this.overlayWindow.webContents.send('hide-selection-region');
  }

  showProcessingToast(payload: { title?: string; message: string; tone?: 'processing' | 'success' | 'error' }) {
    if (!this.overlayWindow) return;
    this.overlayWindow.webContents.send('show-processing-toast', payload);
  }

  hideProcessingToast() {
    if (!this.overlayWindow) return;
    this.overlayWindow.webContents.send('hide-processing-toast');
  }

  setSelectionRegionInteracting(isActive: boolean) {
    this.selectionRegionInteracting = isActive;
    this.updateMouseInterception(false);
  }

  setCaptureModeActive(isActive: boolean) {
    this.captureModeActive = isActive;
    this.updateMouseInterception(false);
  }

  private updateMouseInterception(hasHoverRegion: boolean) {
    if (!this.overlayWindow) return;

    if (this.captureModeActive || this.selectionRegionInteracting || this.selectionMenuVisible || hasHoverRegion) {
      this.overlayWindow.setIgnoreMouseEvents(false);
      return;
    }

    this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  destroy() {
    if (this.overlayWindow) {
      this.overlayWindow.destroy();
      this.overlayWindow = null;
    }
  }
}
