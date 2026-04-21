import { app, BrowserWindow, desktopCapturer, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ScreenCapture, ChangedRegion, SelectionClipboardContent } from './screenCapture';
import { OverlayManager, SelectionRegion } from './overlayManager';
import { OCRManager } from './ocrManager';
import { MatchManager } from './matchManager';
import { KnowledgeStore, SourceContext, AskAgentMessage } from './knowledgeStore';
import { KnowledgeWindowManager } from './knowledgeWindowManager';
import { mainI18n } from './i18n';

let screenCapture: ScreenCapture;
let overlayManager: OverlayManager;
let ocrManager: OCRManager;
let matchManager: MatchManager;
let knowledgeStore: KnowledgeStore;
let kbWindowManager: KnowledgeWindowManager;
let tray: Tray | null = null;
let updateDebounceTimer: NodeJS.Timeout | null = null;
let pendingSelectionSourceContext: SourceContext | null = null;
let pendingSelectionClipboardContent: SelectionClipboardContent | null = null;
const UPDATE_DEBOUNCE_MS = 100;

// Cache for keyword embeddings to avoid repeated Ollama calls
const embeddingCache = new Map<string, any>();

type FrontWindowContext = {
  appName?: string;
  bundleId?: string;
  windowTitle?: string;
};

async function createApp() {
  await app.whenReady();

  // Initialize i18n with language from settings
  try {
    const settingsPath = path.join(require('os').homedir(), '.perch', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      mainI18n.loadLanguage(settings.language || 'en');
    } else {
      mainI18n.loadLanguage('en');
    }
  } catch (error) {
    console.error('Failed to load language settings:', error);
    mainI18n.loadLanguage('en');
  }

  overlayManager = new OverlayManager();
  overlayManager.createWindow();

  ocrManager = new OCRManager();
  matchManager = new MatchManager();
  knowledgeStore = new KnowledgeStore();
  knowledgeStore.cleanupOrphanedKeywords();
  kbWindowManager = new KnowledgeWindowManager();

  // Create tray icon
  const trayIcon = nativeImage.createFromNamedImage('NSStatusAvailable', [-1, 0, 1]);
  tray = new Tray(trayIcon);
  tray.setToolTip('Perch');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Knowledge Base', click: () => kbWindowManager.open() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } }
  ]);
  tray.setContextMenu(contextMenu);

  // Sync keywords from knowledge base to OCR
  function syncKeywords() {
    const keywords = knowledgeStore.getAllKeywords();
    ocrManager.setKeywordsInMemory(keywords);
    console.log(`✓ Synced keywords: ${keywords.length} total: ${keywords.join(', ')}`);
  }

  syncKeywords();

  // --- IPC Handlers ---

  // Knowledge search for tooltip
  ipcMain.handle('get-knowledge-data', async (_event, keyword: string) => {
    try {
      const info = knowledgeStore.getKeywordInfo(keyword);
      if (info) {
        return {
          summary: info.description || keyword,
          entries: info.entries.map(e => ({
            type: e.type, title: e.title, id: e.id, time: e.created_at
          }))
        };
      }
      // Fallback to semantic search
      const results = await knowledgeStore.search(keyword, 5);
      if (results.length === 0) return null;
      return {
        summary: results[0].content?.slice(0, 100) || keyword,
        entries: results.map(r => ({
          type: r.type, title: r.title, id: r.id, time: r.created_at, score: r.score
        }))
      };
    } catch (e) {
      console.error('Knowledge search error:', e);
      return null;
    }
  });

  // Open document in new window
  ipcMain.handle('open-document', (_event, keyword: string, entry: any) => {
    const realEntry = knowledgeStore.getEntry(entry.id);
    const content = realEntry?.content || 'No content available';
    const imagePath = realEntry?.image_path;
    const sourcePath = realEntry?.source_path;
    const sourceUrl = realEntry?.source_url;
    const sourceAppName = realEntry?.source_app_name;
    const sourceAppType = realEntry?.source_app_type;
    const sourceWindowTitle = realEntry?.source_window_title;

    const docWindow = new BrowserWindow({
      width: 900, height: 700,
      title: `${entry.title} - ${keyword}`,
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
    });

    if (realEntry?.type === 'pdf' && sourcePath) {
      docWindow.loadURL(`file://${sourcePath}`);
      return;
    }

    if (realEntry?.type === 'web' && sourcePath) {
      docWindow.loadFile(sourcePath);
      return;
    }

    if (realEntry?.type === 'text' && sourcePath && sourcePath.toLowerCase().endsWith('.md')) {
      const markdown = fs.readFileSync(sourcePath, 'utf8');
      const html = renderMarkdownDocument({
        title: entry.title,
        keyword,
        markdown,
        sourcePath,
        sourceUrl,
        time: entry.time,
        entryType: entry.type,
        entryId: entry.id,
        sourceAppName,
        sourceAppType,
        sourceWindowTitle
      });
      docWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return;
    }

    const imageHtml = imagePath ? `<img src="file://${imagePath}" style="max-width:100%;border-radius:8px;margin:16px 0;">` : '';
    const sourceHtml = sourceUrl
      ? `<div class="source"><a href="${sourceUrl}">${sourceUrl}</a></div>`
      : sourcePath
        ? `<div class="source">${sourcePath}</div>`
        : '';
    const sourceContextParts = [
      sourceAppType ? `Type: ${sourceAppType}` : '',
      sourceAppName ? `App: ${sourceAppName}` : '',
      sourceWindowTitle ? `Window: ${sourceWindowTitle}` : ''
    ].filter(Boolean);
    const sourceContextHtml = sourceContextParts.length > 0
      ? `<div class="source">${sourceContextParts.join(' · ')}</div>`
      : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${entry.title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin:0; padding:32px; background:#f8f9fa; color:#222; line-height:1.6; }
  .header { border-bottom:1px solid #ddd; padding-bottom:20px; margin-bottom:24px; }
  .keyword { display:inline-block; background:#007AFF; color:white; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:600; margin-bottom:12px; }
  h1 { margin:0 0 8px 0; font-size:28px; }
  .meta { color:#666; font-size:14px; }
  .source { color:#444; font-size:13px; margin-top:8px; word-break:break-all; }
  .source a { color:#0a66d8; text-decoration:none; }
  .content { max-width:760px; font-size:16px; white-space:pre-wrap; }
</style></head><body>
  <div class="header">
    <div class="keyword">${keyword}</div>
    <h1>${entry.title}</h1>
    <div class="meta">${entry.type} · ${entry.id} · ${entry.time}</div>
    ${sourceHtml}
    ${sourceContextHtml}
  </div>
  ${imageHtml}
  <div class="content">${content}</div>
</body></html>`;

    docWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  // KB CRUD handlers
  ipcMain.handle('kb-add-text', async (_event, title: string, content: string) => {
    const result = await knowledgeStore.addText(title, content);
    syncKeywords();
    return result;
  });

  ipcMain.handle('save-selected-text', async (_event, content: string) => {
    const trimmed = (content || '').trim();
    const clipboardSelection = pendingSelectionClipboardContent;
    if (!trimmed && !hasClipboardSelectionContent(clipboardSelection)) return null;

    console.log(`→ Saving selected text to knowledge base (${trimmed.length} chars)`);
    const sourceContext = pendingSelectionSourceContext;
    restoreSourceAppFocus(sourceContext);
    let result;
    const selectionText = trimmed || clipboardSelection?.text.trim() || '';
    overlayManager.showProcessingToast({
      message: getSelectionProcessingMessage(clipboardSelection, selectionText),
      tone: 'processing'
    });

    try {
      if (clipboardSelection?.filePaths?.length) {
        result = await addClipboardFileSelection(clipboardSelection.filePaths[0], sourceContext);
        console.log(`✓ Clipboard file saved as entry: ${result.title}`);
      } else if (clipboardSelection && isClipboardImageSelection(clipboardSelection)) {
        result = await addClipboardImageSelection(clipboardSelection, sourceContext);
        console.log(`✓ Clipboard image saved as entry: ${result.title}`);
      } else if (selectionText && isLikelyUrl(selectionText)) {
        result = await knowledgeStore.addWebPage(selectionText, sourceContext);
        console.log(`✓ Selected URL saved as webpage: ${result.title}`);
      } else if (clipboardSelection && hasRichSelectionContent(clipboardSelection)) {
        const title = buildSelectionTitle(clipboardSelection, sourceContext);
        result = await knowledgeStore.addRichTextSelection(title, clipboardSelection, sourceContext);
        console.log(`✓ Rich selection saved with title: ${title}`);
      } else {
        const singleLine = selectionText.replace(/\s+/g, ' ');
        const title = singleLine.length > 36 ? `${singleLine.slice(0, 36)}...` : singleLine;
        result = await knowledgeStore.addText(title, selectionText, sourceContext);
        console.log(`✓ Selected text saved with title: ${title}`);
      }

      overlayManager.showProcessingToast({
        title: mainI18n.t('saved'),
        message: `已加入知识库：${result.title}`,
        tone: 'success'
      });
    } catch (error) {
      overlayManager.showProcessingToast({
        title: mainI18n.t('failed'),
        message: `${mainI18n.t('captureProcessingFailed')}：${String((error as Error).message || error)}`,
        tone: 'error'
      });
      throw error;
    }

    pendingSelectionClipboardContent = null;
    pendingSelectionSourceContext = null;
    syncKeywords();
    return result;
  });

  ipcMain.handle('kb-add-image', async (_event, title: string, imagePath: string) => {
    const result = await addImageEntry(title, imagePath);
    syncKeywords();
    return result;
  });

  ipcMain.handle('kb-add-pdf', async (_event, title: string, pdfPath: string) => {
    const result = await addPdfEntry(title, pdfPath);
    syncKeywords();
    return result;
  });

  ipcMain.handle('kb-delete', async (_event, id: string) => {
    await knowledgeStore.delete(id);
    syncKeywords();
  });

  ipcMain.handle('kb-list', () => {
    return knowledgeStore.list();
  });

  ipcMain.handle('kb-search', async (_event, query: string) => {
    return await knowledgeStore.search(query);
  });

  ipcMain.handle('kb-list-keywords', () => {
    return knowledgeStore.listKeywords();
  });

  ipcMain.handle('kb-get-keyword', (_event, keyword: string) => {
    return knowledgeStore.getKeywordInfo(keyword);
  });

  ipcMain.handle('kb-graph-data', () => {
    return knowledgeStore.getGraphData();
  });

  ipcMain.handle('kb-agent-chat', async (_event, messages: AskAgentMessage[]) => {
    return await knowledgeStore.askAgent(messages);
  });

  ipcMain.handle('kb-get-settings', () => {
    return knowledgeStore.getSettings();
  });

  ipcMain.handle('kb-list-models', async (_event, apiBaseUrl?: string) => {
    return await knowledgeStore.listAvailableModels(apiBaseUrl);
  });

  ipcMain.handle('kb-update-settings', (_event, settings: { apiBaseUrl?: string; chatModel?: string }) => {
    return knowledgeStore.updateSettings(settings);
  });

  ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images and PDFs', extensions: ['png', 'jpg', 'jpeg', 'pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // --- Screen Capture ---

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

        if (!screenCapture.isActive) return;

        console.log(`→ Main: Got ${matches.length} matches from OCR`);

        if (changedRegions && changedRegions.length > 0) {
          matchManager.removeMatchesInRegions(changedRegions);
        }

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
    (isActive: boolean) => {
      overlayManager.setCaptureModeActive(isActive);
    },
    () => {
      if (updateDebounceTimer) {
        clearTimeout(updateDebounceTimer);
        updateDebounceTimer = null;
      }
      matchManager.clear();
      overlayManager.clearUnderlines();
      overlayManager.hideSelectionRegion();
      console.log('✓ Cleared all matches');
    },
    (selection: SelectionClipboardContent) => {
      pendingSelectionClipboardContent = selection;
      pendingSelectionSourceContext = getSelectionSourceContext();
      overlayManager.showSelectionMenu(selection.text, getSelectionActionLabel(selection));
    },
    () => {
      pendingSelectionClipboardContent = null;
      pendingSelectionSourceContext = null;
      overlayManager.hideSelectionMenu();
    },
    () => {
      // Capture source context BEFORE opening KB window
      const sourceContext = getSelectionSourceContext();
      if (sourceContext) {
        pendingSelectionSourceContext = sourceContext;
      }
      kbWindowManager.toggle();
    },
    (isActive: boolean) => {
      overlayManager.setSelectionRegionInteracting(isActive);
      if (isActive) {
        kbWindowManager.suppressBackgroundWindow('selection-region');
        overlayManager.hideSelectionMenu();
      } else {
        kbWindowManager.restoreBackgroundWindow('selection-region');
      }
    },
    (region: ChangedRegion | null) => {
      if (region) {
        overlayManager.showSelectionRegion(region as SelectionRegion);
      } else {
        overlayManager.hideSelectionRegion();
      }
    },
    async (imageBuffer: Buffer) => {
      const sourceContext = pendingSelectionSourceContext || getSelectionSourceContext();
      pendingSelectionClipboardContent = null;
      pendingSelectionSourceContext = null;
      await addSelectionScreenshotBuffer(imageBuffer, sourceContext);
      syncKeywords();
    },
    () => overlayManager.isSelectionMenuShown(),
    () => {
      // Capture source context immediately when option key is pressed
      // This ensures we get the real foreground app, not the KB window
      const sourceContext = getSelectionSourceContext();
      if (sourceContext) {
        pendingSelectionSourceContext = sourceContext;
      }
    }
  );

  screenCapture.start();

  console.log('Perch started. Hold Option to analyze screen, or double-tap Option to open the knowledge base.');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (screenCapture) screenCapture.stop();
  if (updateDebounceTimer) clearTimeout(updateDebounceTimer);
  if (knowledgeStore) knowledgeStore.close();
});

createApp().catch(console.error);

function isLikelyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getSelectionSourceContext(): SourceContext | null {
  try {
    const nativeOCR = require('../../build/Release/ocr.node');
    const context = nativeOCR?.getFrontWindowContext?.() as FrontWindowContext | null | undefined;
    if (!context) return null;

    const appName = normalizeOptionalString(context.appName);
    const bundleId = normalizeOptionalString(context.bundleId);
    const windowTitle = normalizeOptionalString(context.windowTitle);

    return {
      source_app_name: appName,
      source_app_bundle_id: bundleId,
      source_app_type: classifyAppType(appName, bundleId),
      source_window_title: windowTitle
    };
  } catch (error) {
    console.warn('⚠ Failed to get selection source context:', error);
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function classifyAppType(appName: string | null, bundleId: string | null): string | null {
  const haystack = `${appName || ''} ${bundleId || ''}`.toLowerCase();
  if (!haystack) return null;

  if (/(chrome|safari|firefox|edge|arc|browser|opera|brave|vivaldi)/.test(haystack)) return 'browser';
  if (/(terminal|iterm|warp|alacritty|kitty|wezterm)/.test(haystack)) return 'terminal';
  if (/(code|xcode|cursor|zed|sublime|vim|emacs|jetbrains|idea|pycharm|webstorm|goland|android studio)/.test(haystack)) return 'editor';
  if (/(slack|discord|wechat|telegram|whatsapp|teams|zoom|feishu|lark)/.test(haystack)) return 'communication';
  if (/(word|pages|excel|numbers|powerpoint|keynote|notion|obsidian|bear|ulysses)/.test(haystack)) return 'document';
  if (/(finder|preview|mail)/.test(haystack)) return 'utility';
  return 'app';
}

function hasRichSelectionContent(selection: SelectionClipboardContent | null): boolean {
  return Boolean(selection?.html || selection?.imageDataUrl);
}

function hasClipboardSelectionContent(selection: SelectionClipboardContent | null): boolean {
  return Boolean(selection?.text || selection?.html || selection?.imageDataUrl || selection?.filePaths?.length);
}

function isClipboardImageSelection(selection: SelectionClipboardContent | null): boolean {
  return Boolean(selection?.imageDataUrl && !selection?.html && !selection?.filePaths?.length && !selection?.text.trim());
}

function getSelectionActionLabel(selection: SelectionClipboardContent): string {
  if (selection.filePaths.length > 0) return mainI18n.t('captureFile');
  if (isClipboardImageSelection(selection)) return mainI18n.t('captureImage');
  if (isLikelyUrl((selection.text || '').trim())) return mainI18n.t('captureWeb');
  return mainI18n.t('captureText');
}

function getSelectionProcessingMessage(selection: SelectionClipboardContent | null, selectionText: string): string {
  return mainI18n.t('savingContent');
}

async function addImageEntry(title: string, imagePath: string, sourceContext?: SourceContext | null) {
  let ocrText = '';
  try {
    const nativeOCR = require('../../build/Release/ocr.node');
    const imageData = fs.readFileSync(imagePath);
    ocrText = await new Promise<string>((resolve) => {
      nativeOCR.performOCR(imageData, [''], (err: any, results: any[]) => {
        if (err || !results) { resolve(''); return; }
        resolve(results.map((r: any) => r.text).join(' '));
      });
    });
  } catch (e) {
    console.warn('⚠ OCR failed for image:', e);
  }

  return await knowledgeStore.addImage(title, imagePath, ocrText, sourceContext);
}

async function addPdfEntry(title: string, pdfPath: string, sourceContext?: SourceContext | null) {
  let content = '';
  try {
    content = await new Promise<string>((resolve, reject) => {
      execFile('pdftotext', [pdfPath, '-'], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    console.log(`✓ Extracted ${content.length} chars from PDF`);
  } catch (e) {
    console.warn('⚠ pdftotext failed:', e);
    content = `[PDF] ${path.basename(pdfPath)}`;
  }

  return await knowledgeStore.addPdf(title, pdfPath, content, sourceContext);
}

async function addClipboardImageSelection(selection: SelectionClipboardContent, sourceContext: SourceContext | null) {
  const tempImagePath = writeClipboardImageToTempFile(selection.imageDataUrl!);
  const title = buildImageSelectionTitle(sourceContext);

  try {
    return await addImageEntry(title, tempImagePath, sourceContext);
  } finally {
    try { fs.unlinkSync(tempImagePath); } catch {}
  }
}

async function addClipboardFileSelection(filePath: string, sourceContext: SourceContext | null) {
  const fileName = path.basename(filePath);
  const title = fileName.replace(/\.[^/.]+$/, '') || fileName;
  const lowerPath = filePath.toLowerCase();

  if (/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i.test(lowerPath)) {
    return await addImageEntry(title, filePath, sourceContext);
  }

  if (lowerPath.endsWith('.pdf')) {
    return await addPdfEntry(title, filePath, sourceContext);
  }

  const content = `[File]\nName: ${fileName}\nPath: ${filePath}`;
  return await knowledgeStore.addText(title, content, sourceContext);
}

async function addSelectionScreenshotBuffer(imageBuffer: Buffer, sourceContext: SourceContext | null) {
  const filePath = path.join(require('os').tmpdir(), `kb-region-${Date.now()}.png`);
  fs.writeFileSync(filePath, imageBuffer);

  try {
    const title = buildRegionSelectionTitle(sourceContext);
    overlayManager.showProcessingToast({
      message: mainI18n.t('savingContent'),
      tone: 'processing'
    });
    const result = await addImageEntry(title, filePath, sourceContext);
    overlayManager.showProcessingToast({
      title: mainI18n.t('saved'),
      message: `已加入知识库：${result.title}`,
      tone: 'success'
    });
    return result;
  } catch (error) {
    overlayManager.showProcessingToast({
      title: mainI18n.t('failed'),
      message: `${mainI18n.t('screenshotProcessingFailed')}：${String((error as Error).message || error)}`,
      tone: 'error'
    });
    throw error;
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function writeClipboardImageToTempFile(imageDataUrl: string): string {
  const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid clipboard image data URL');
  }

  const [, mimeType, base64Data] = match;
  const extensionMap: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/svg+xml': '.svg'
  };
  const fileExt = extensionMap[mimeType.toLowerCase()] || '.png';
  const filePath = path.join(require('os').tmpdir(), `kb-clipboard-${Date.now()}${fileExt}`);
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return filePath;
}

function buildImageSelectionTitle(sourceContext: SourceContext | null): string {
  const windowTitle = sourceContext?.source_window_title?.trim();
  if (windowTitle) return `Image from ${windowTitle}`;

  const appName = sourceContext?.source_app_name?.trim();
  if (appName) return `Image from ${appName}`;

  return 'Clipboard image';
}

function buildRegionSelectionTitle(sourceContext: SourceContext | null): string {
  const windowTitle = sourceContext?.source_window_title?.trim();
  if (windowTitle) return `Capture from ${windowTitle}`;

  const appName = sourceContext?.source_app_name?.trim();
  if (appName) return `Capture from ${appName}`;

  return 'Screen capture';
}

function restoreSourceAppFocus(sourceContext: SourceContext | null) {
  const bundleId = sourceContext?.source_app_bundle_id?.trim();
  if (!bundleId) return;

  try {
    const nativeOCR = require('../../build/Release/ocr.node');
    nativeOCR?.activateAppByBundleId?.(bundleId);
  } catch (error) {
    console.warn(`⚠ Failed to restore app focus for ${bundleId}:`, error);
  }
}

function buildSelectionTitle(selection: SelectionClipboardContent, sourceContext: SourceContext | null): string {
  const singleLine = selection.text.replace(/\s+/g, ' ').trim();
  if (singleLine) {
    return singleLine.length > 36 ? `${singleLine.slice(0, 36)}...` : singleLine;
  }

  const windowTitle = sourceContext?.source_window_title?.trim();
  if (windowTitle) {
    return `Selection from ${windowTitle}`;
  }

  const appName = sourceContext?.source_app_name?.trim();
  if (appName) {
    return `Selection from ${appName}`;
  }

  return 'Rich selection';
}

function renderMarkdownDocument(options: {
  title: string;
  keyword: string;
  markdown: string;
  sourcePath: string;
  sourceUrl: string | null | undefined;
  time: string;
  entryType: string;
  entryId: string;
  sourceAppName: string | null | undefined;
  sourceAppType: string | null | undefined;
  sourceWindowTitle: string | null | undefined;
}): string {
  const {
    title,
    keyword,
    markdown,
    sourcePath,
    sourceUrl,
    time,
    entryType,
    entryId,
    sourceAppName,
    sourceAppType,
    sourceWindowTitle
  } = options;

  const baseHref = `file://${path.dirname(sourcePath)}/`;
  const sourceHtml = sourceUrl
    ? `<div class="source"><a href="${escapeHtmlAttribute(sourceUrl)}">${escapeHtml(sourceUrl)}</a></div>`
    : `<div class="source">${escapeHtml(sourcePath)}</div>`;
  const sourceContextParts = [
    sourceAppType ? `Type: ${sourceAppType}` : '',
    sourceAppName ? `App: ${sourceAppName}` : '',
    sourceWindowTitle ? `Window: ${sourceWindowTitle}` : ''
  ].filter(Boolean);
  const sourceContextHtml = sourceContextParts.length > 0
    ? `<div class="source">${escapeHtml(sourceContextParts.join(' · '))}</div>`
    : '';
  const renderedHtml = markdownToHtml(markdown);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<base href="${escapeHtmlAttribute(baseHref)}">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin:0; padding:32px; background:#f8f9fa; color:#222; line-height:1.65; }
  .header { border-bottom:1px solid #ddd; padding-bottom:20px; margin-bottom:24px; }
  .keyword { display:inline-block; background:#007AFF; color:white; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:600; margin-bottom:12px; }
  h1 { margin:0 0 8px 0; font-size:28px; }
  .meta { color:#666; font-size:14px; }
  .source { color:#444; font-size:13px; margin-top:8px; word-break:break-all; }
  .source a { color:#0a66d8; text-decoration:none; }
  .content { max-width:820px; font-size:16px; }
  .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 { line-height:1.25; margin:1.4em 0 0.6em; }
  .content p { margin:0 0 1em; }
  .content ul, .content ol { margin:0 0 1em 1.4em; }
  .content li { margin:0.25em 0; }
  .content blockquote { margin:0 0 1em; padding-left:14px; border-left:3px solid #d0d7de; color:#555; }
  .content pre { background:#111827; color:#f9fafb; padding:14px 16px; border-radius:10px; overflow:auto; margin:0 0 1em; }
  .content code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .content :not(pre) > code { background:rgba(15, 23, 42, 0.08); padding:0.15em 0.35em; border-radius:6px; }
  .content img { max-width:100%; border-radius:10px; display:block; margin:16px 0; }
  .content a { color:#0a66d8; }
</style></head><body>
  <div class="header">
    <div class="keyword">${escapeHtml(keyword)}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(entryType)} · ${escapeHtml(entryId)} · ${escapeHtml(time)}</div>
    ${sourceHtml}
    ${sourceContextHtml}
  </div>
  <div class="content">${renderedHtml}</div>
</body></html>`;
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const htmlParts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      htmlParts.push(`<blockquote>${markdownToHtml(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^[-*+]\s+/, ''))}</li>`);
        index += 1;
      }
      htmlParts.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      htmlParts.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].startsWith('```') && !/^(#{1,6})\s+/.test(lines[index]) && !/^>\s?/.test(lines[index]) && !/^[-*+]\s+/.test(lines[index]) && !/^\d+\.\s+/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    htmlParts.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
  }

  return htmlParts.join('\n');
}

function renderInlineMarkdown(markdown: string): string {
  const replacements: string[] = [];
  const stash = (html: string) => {
    const token = `\u0000${replacements.length}\u0000`;
    replacements.push(html);
    return token;
  };

  let html = markdown;
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => stash(`<img alt="${escapeHtmlAttribute(alt)}" src="${escapeHtmlAttribute(src)}">`));
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => stash(`<a href="${escapeHtmlAttribute(href)}">${escapeHtml(text)}</a>`));
  html = html.replace(/`([^`]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_match, index) => replacements[Number(index)] || '');
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
