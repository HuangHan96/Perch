import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

export class KnowledgeWindowManager {
  private window: BrowserWindow | null = null;
  private hiddenForSuppression: boolean = false;
  private suppressionReasons: Set<string> = new Set();

  isOpen() {
    return !!this.window && !this.window.isDestroyed();
  }

  open() {
    if (this.window) {
      this.showAndFocusWindow();
      return;
    }

    this.window = new BrowserWindow({
      width: 1080,
      height: 760,
      title: 'Perch',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/preload.js'),
        webSecurity: false
      }
    });

    this.window.loadFile(path.join(__dirname, '../renderer/kb-window.html'));
    this.showAndFocusWindow();

    this.window.on('closed', () => {
      this.hiddenForSuppression = false;
      this.suppressionReasons.clear();
      this.window = null;
    });
  }

  suppressBackgroundWindow(reason: string) {
    this.suppressionReasons.add(reason);

    if (!this.window || !this.window.isVisible() || this.window.isFocused()) {
      this.hiddenForSuppression = false;
      return;
    }

    this.window.hide();
    this.hiddenForSuppression = true;
  }

  restoreBackgroundWindow(reason: string) {
    this.suppressionReasons.delete(reason);

    if (!this.window || this.suppressionReasons.size > 0 || !this.hiddenForSuppression) {
      if (!this.window || this.suppressionReasons.size === 0) {
        this.hiddenForSuppression = false;
      }
      return;
    }

    this.hiddenForSuppression = false;
    if (this.window.isMinimized()) {
      return;
    }
    this.window.showInactive();
  }

  toggle() {
    if (!this.isOpen()) {
      this.open();
      return;
    }

    if (this.window?.isFocused()) {
      this.close();
      return;
    }

    this.showAndFocusWindow();
  }

  private showAndFocusWindow() {
    if (!this.window) return;

    this.hiddenForSuppression = false;
    this.suppressionReasons.clear();

    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
  }

  close() {
    if (this.window) {
      this.window.close();
      this.window = null;
      this.hiddenForSuppression = false;
      this.suppressionReasons.clear();
    }
  }
}
