import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ScreenCapture, ChangedRegion } from './screenCapture';
import { OverlayManager } from './overlayManager';
import { OCRManager } from './ocrManager';
import { MatchManager } from './matchManager';

let screenCapture: ScreenCapture;
let overlayManager: OverlayManager;
let ocrManager: OCRManager;
let matchManager: MatchManager;
let knowledgeBase: Record<string, any> = {};
let updateDebounceTimer: NodeJS.Timeout | null = null;
const UPDATE_DEBOUNCE_MS = 100;

function loadKnowledgeBase() {
  try {
    const kbPath = path.join(__dirname, '../../knowledge-base.json');
    const data = fs.readFileSync(kbPath, 'utf-8');
    knowledgeBase = JSON.parse(data);
    console.log(`✓ Knowledge base loaded: ${Object.keys(knowledgeBase).length} keywords`);
  } catch (error) {
    console.warn('⚠ Could not load knowledge-base.json');
  }
}

async function createApp() {
  await app.whenReady();

  overlayManager = new OverlayManager();
  overlayManager.createWindow();

  ocrManager = new OCRManager();
  matchManager = new MatchManager();
  loadKnowledgeBase();

  // IPC handler for knowledge base queries
  ipcMain.handle('get-knowledge-data', (_event, keyword: string) => {
    // Case-insensitive lookup
    const key = Object.keys(knowledgeBase).find(k => k.toLowerCase() === keyword.toLowerCase());
    return key ? knowledgeBase[key] : null;
  });

  screenCapture = new ScreenCapture(
    async (
      imageBuffer: Buffer,
      displayBounds: { width: number; height: number; menuBarHeight: number },
      windowBounds: { x: number; y: number; width: number; height: number } | null,
      changedRegions?: ChangedRegion[],
      ocrRegion?: ChangedRegion | null
    ) => {
      try {
        const matches = await ocrManager.findKeywordMatches(imageBuffer, displayBounds, windowBounds, ocrRegion);

        // Guard: discard if deactivated while OCR was running
        if (!screenCapture.isActive) return;

        console.log(`→ Main: Got ${matches.length} matches from OCR`);

        if (changedRegions && changedRegions.length > 0) {
          matchManager.removeMatchesInRegions(changedRegions);
        }

        // Add matches (keyword is already in each match from OCR)
        for (const match of matches) {
          matchManager.addMatches([match], match.keyword || 'Unknown');
        }

        if (updateDebounceTimer) {
          clearTimeout(updateDebounceTimer);
        }

        updateDebounceTimer = setTimeout(() => {
          if (!screenCapture.isActive) return;

          const allMatches = matchManager.getAllMatches();
          const stats = matchManager.getStats();
          console.log(`→ Overlay update: ${allMatches.length} unique matches`, stats);

          if (allMatches.length > 0) {
            overlayManager.drawUnderlines(allMatches);
          } else {
            overlayManager.clearUnderlines();
          }
        }, UPDATE_DEBOUNCE_MS);
      } catch (error) {
        console.error('OCR error:', error);
      }
    },
    // Clear callback
    () => {
      if (updateDebounceTimer) {
        clearTimeout(updateDebounceTimer);
        updateDebounceTimer = null;
      }
      matchManager.clear();
      overlayManager.clearUnderlines();
      console.log('✓ Cleared all matches');
    }
  );

  screenCapture.start();

  console.log('Keywords Highlighter started. Press and hold Option key to analyze screen...');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (screenCapture) {
    screenCapture.stop();
  }
  if (updateDebounceTimer) {
    clearTimeout(updateDebounceTimer);
  }
});

createApp().catch(console.error);
