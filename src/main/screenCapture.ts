import { clipboard, nativeImage, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { loadNativeModule } from './nativeLoader';
import type { UnderlinePosition } from './overlayManager';

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A captured screen frame: tightly packed 8-bit-per-channel pixels, one pixel per screen point.
 * `pixelFormat` says which order the colour channels are in, so the OCR module can build the
 * right image for the buffer it is given.
 */
export interface CapturedFrame {
  bitmap: Buffer;
  width: number;
  height: number;
  pixelFormat: 'bgra' | 'rgba';
}

/** Where ScreenCapture gets its frames from (see screenFrameSource.ts). */
export interface ScreenFrameProvider {
  grabFrame(): Promise<CapturedFrame | null>;
  isLowLatency?(): boolean;
}

type DisplayBounds = { width: number; height: number; menuBarHeight: number };

interface PrewarmedAnalysis {
  frame: CapturedFrame;
  pressId: number;
  fastMatches?: UnderlinePosition[];
}

export interface SelectionClipboardContent {
  text: string;
  html: string | null;
  rtf: string | null;
  imageDataUrl: string | null;
  filePaths: string[];
  availableFormats: string[];
}

export class ScreenCapture {
  private static readonly OPTION_HOLD_DELAY_MS = 180;
  private static readonly OPTION_TAP_MAX_DURATION_MS = 220;
  private static readonly OPTION_DOUBLE_PRESS_WINDOW_MS = 350;
  private static readonly SELECTION_DRAG_THRESHOLD_PX = 6;
  private captureInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private optionKeyTimer: NodeJS.Timeout | null = null;
  private lastFrame: CapturedFrame | null = null;
  private prewarmedAnalysis: PrewarmedAnalysis | null = null;
  private prewarmPromise: Promise<void> | null = null;
  private optionPressId: number = 0;
  private nativeModule: any = null;
  private frameProvider: ScreenFrameProvider | null = null;
  private speculativeAnalysisProvider: ((frame: CapturedFrame, displayBounds: DisplayBounds) => Promise<UnderlinePosition[]>) | null = null;
  private uiohook: any = null;
  private isOptionKeyPressed: boolean = false;
  private optionPressStartedAt: number | null = null;
  private lastOptionTapAt: number | null = null;
  private previousPressWasHold: boolean = false;
  private optionHoldTriggeredForCurrentPress: boolean = false;
  private selectionCheckInFlight: boolean = false;
  private selectionCheckedThisPress: boolean = false;
  isActive: boolean = false; // Public so index.ts can check
  private callback: (
    frame: CapturedFrame,
    displayBounds: DisplayBounds,
    changedRegions: ChangedRegion[],
    ocrRegion: ChangedRegion | null,
    isInitialCapture: boolean,
    prewarmedFastMatches?: UnderlinePosition[]
  ) => Promise<void>;
  private onCaptureModeActiveChangeCallback: ((isActive: boolean) => void) | null = null;
  private onClearCallback: (() => void) | null = null;
  private onSelectionTextCallback: ((selection: SelectionClipboardContent) => void) | null = null;
  private onSelectionClearCallback: (() => void) | null = null;
  private onDoubleOptionPressCallback: (() => void) | null = null;
  private onSelectionRegionInteractionCallback: ((isActive: boolean) => void) | null = null;
  private onSelectionRegionCallback: ((region: ChangedRegion | null) => void) | null = null;
  private onSelectionRegionCaptureCallback: ((imageBuffer: Buffer, region: ChangedRegion) => Promise<void>) | null = null;
  private shouldBlockMouseSelectionCallback: (() => boolean) | null = null;
  private onOptionKeyPressCallback: (() => void) | null = null;
  private isProcessing: boolean = false;
  private pendingMouseSelectionStart: { x: number; y: number } | null = null;
  private isMouseSelectionActive: boolean = false;

  constructor(
    callback: (
      frame: CapturedFrame,
      displayBounds: DisplayBounds,
      changedRegions: ChangedRegion[],
      ocrRegion: ChangedRegion | null,
      isInitialCapture: boolean,
      prewarmedFastMatches?: UnderlinePosition[]
    ) => Promise<void>,
    onCaptureModeActiveChange?: (isActive: boolean) => void,
    onClear?: () => void,
    onSelectionText?: (selection: SelectionClipboardContent) => void,
    onSelectionClear?: () => void,
    onDoubleOptionPress?: () => void,
    onSelectionRegionInteraction?: (isActive: boolean) => void,
    onSelectionRegion?: (region: ChangedRegion | null) => void,
    onSelectionRegionCapture?: (imageBuffer: Buffer, region: ChangedRegion) => Promise<void>,
    shouldBlockMouseSelection?: () => boolean,
    onOptionKeyPress?: () => void
  ) {
    this.callback = callback;
    this.onCaptureModeActiveChangeCallback = onCaptureModeActiveChange || null;
    this.onClearCallback = onClear || null;
    this.onSelectionTextCallback = onSelectionText || null;
    this.onSelectionClearCallback = onSelectionClear || null;
    this.onDoubleOptionPressCallback = onDoubleOptionPress || null;
    this.onSelectionRegionInteractionCallback = onSelectionRegionInteraction || null;
    this.onSelectionRegionCallback = onSelectionRegion || null;
    this.onSelectionRegionCaptureCallback = onSelectionRegionCapture || null;
    this.shouldBlockMouseSelectionCallback = shouldBlockMouseSelection || null;
    this.onOptionKeyPressCallback = onOptionKeyPress || null;

    try {
      this.nativeModule = loadNativeModule('ocr');
    } catch (error) {
      console.warn('⚠ Native module not available for window bounds:', error);
    }
  }

  async start() {
    console.log('✓ Screen capture ready. Hold Option to analyze, double-tap Option to open Perch.');
    this.setupGlobalEventListeners();
  }

  setFrameProvider(provider: ScreenFrameProvider) {
    this.frameProvider = provider;
  }

  setSpeculativeAnalysisProvider(
    provider: (frame: CapturedFrame, displayBounds: DisplayBounds) => Promise<UnderlinePosition[]>
  ) {
    this.speculativeAnalysisProvider = provider;
  }

  stop() {
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.optionKeyTimer) {
      clearTimeout(this.optionKeyTimer);
      this.optionKeyTimer = null;
    }
    this.stopGlobalEventListeners();
  }

  private setupGlobalEventListeners() {
    try {
      const { uIOhook, UiohookKey } = require('uiohook-napi');
      this.uiohook = uIOhook;

      this.uiohook.on('keydown', (e: any) => {
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          if (!this.isOptionKeyPressed) {
            this.isOptionKeyPressed = true;
            this.optionPressStartedAt = Date.now();
            this.optionPressId += 1;
            this.optionHoldTriggeredForCurrentPress = false;
            this.selectionCheckedThisPress = false;
            console.log(`✓ Option key pressed, starting analysis in ${ScreenCapture.OPTION_HOLD_DELAY_MS}ms if held...`);

            // Capture source context immediately when option key is pressed
            if (this.onOptionKeyPressCallback) {
              this.onOptionKeyPressCallback();
            }

            this.startPrewarmCapture();

            this.optionKeyTimer = setTimeout(() => {
              if (this.isOptionKeyPressed) {
                this.optionHoldTriggeredForCurrentPress = true;
                this.startCapture();
                this.detectSelectedText();
              }
            }, ScreenCapture.OPTION_HOLD_DELAY_MS);
          }
        }
      });

      this.uiohook.on('keyup', (e: any) => {
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          const releasedAt = Date.now();
          const pressDuration =
            this.optionPressStartedAt === null ? Number.POSITIVE_INFINITY : releasedAt - this.optionPressStartedAt;
          const wasTap =
            this.optionPressStartedAt !== null &&
            pressDuration <= ScreenCapture.OPTION_TAP_MAX_DURATION_MS &&
            !this.optionHoldTriggeredForCurrentPress &&
            !this.isActive;

          this.isOptionKeyPressed = false;
          this.optionPressStartedAt = null;
          this.previousPressWasHold = this.optionHoldTriggeredForCurrentPress;
          this.optionHoldTriggeredForCurrentPress = false;
          this.selectionCheckedThisPress = false;
          this.prewarmedAnalysis = null;
          this.clearMouseSelectionState();

          if (this.optionKeyTimer) {
            clearTimeout(this.optionKeyTimer);
            this.optionKeyTimer = null;
          }

          if (this.onSelectionClearCallback) {
            this.onSelectionClearCallback();
          }

          if (this.isActive) {
            console.log('✓ Option key released, clearing...');
            this.stopCapture();
          }

          if (wasTap) {
            console.log(`✓ Option tap detected (${pressDuration}ms)`);
            this.handleOptionTap(releasedAt);
          }
        }
      });

      this.uiohook.on('mousedown', (e: any) => {
        if (!this.isOptionKeyPressed || !this.isActive || !this.isPrimaryMouseButton(e)) return;
        if (this.shouldBlockMouseSelectionCallback?.()) return;
        this.pendingMouseSelectionStart = this.normalizeMousePoint(e);
        this.isMouseSelectionActive = false;
        if (this.onSelectionRegionInteractionCallback) {
          this.onSelectionRegionInteractionCallback(true);
        }
      });

      this.uiohook.on('mousemove', (e: any) => {
        if (!this.pendingMouseSelectionStart || !this.isOptionKeyPressed || !this.isActive) return;

        const region = this.buildSelectionRegion(this.pendingMouseSelectionStart, this.normalizeMousePoint(e));
        if (!this.isMouseSelectionActive) {
          if (region.width < ScreenCapture.SELECTION_DRAG_THRESHOLD_PX && region.height < ScreenCapture.SELECTION_DRAG_THRESHOLD_PX) {
            return;
          }
          this.isMouseSelectionActive = true;
          if (this.onSelectionClearCallback) {
            this.onSelectionClearCallback();
          }
        }

        if (this.onSelectionRegionCallback) {
          this.onSelectionRegionCallback(region);
        }
      });

      this.uiohook.on('mouseup', async (e: any) => {
        if (!this.isPrimaryMouseButton(e) || !this.pendingMouseSelectionStart) {
          return;
        }

        const startPoint = this.pendingMouseSelectionStart;
        const region = this.buildSelectionRegion(startPoint, this.normalizeMousePoint(e));
        const shouldCapture = this.isMouseSelectionActive &&
          region.width >= ScreenCapture.SELECTION_DRAG_THRESHOLD_PX &&
          region.height >= ScreenCapture.SELECTION_DRAG_THRESHOLD_PX;

        this.clearMouseSelectionState();

        if (!shouldCapture || !this.isOptionKeyPressed || !this.isActive || !this.onSelectionRegionCaptureCallback) {
          return;
        }

        try {
          const imageBuffer = await this.captureSelectionRegion(region);
          if (imageBuffer) {
            await this.onSelectionRegionCaptureCallback(imageBuffer, region);
          }
        } catch (error) {
          console.warn('⚠ Failed to capture selected region:', error);
        }
      });

      this.uiohook.start();
      console.log('✓ Global event listeners started');
    } catch (error) {
      console.warn('⚠ Could not start global event listeners:', error);
    }
  }

  /**
   * Captures the screen, and when possible runs the fast preview while the hold gesture is
   * still being decided. A result is only ever consumed by the press that started it.
   */
  private startPrewarmCapture() {
    if (this.prewarmPromise || this.isProcessing) {
      return;
    }

    // A live stream makes this work non-blocking for tap gestures. If the stream is not ready,
    // retain the old conservative rule so a tap never starts a ~300ms getSources capture.
    const streamIsReady = this.frameProvider?.isLowLatency?.() === true;
    if (!this.previousPressWasHold && !streamIsReady) {
      return;
    }

    // A press that may turn out to be the second tap of a double-tap should not pay for a capture.
    const timeSinceLastTap =
      this.lastOptionTapAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.lastOptionTapAt;
    if (timeSinceLastTap <= ScreenCapture.OPTION_DOUBLE_PRESS_WINDOW_MS) {
      return;
    }

    const pressId = this.optionPressId;
    console.log('→ Prewarming screen capture for the current Option press...');

    this.prewarmPromise = this.grabFrame()
      .then(async (frame) => {
        if (!frame) return;

        let fastMatches: UnderlinePosition[] | undefined;
        if (this.speculativeAnalysisProvider) {
          try {
            fastMatches = await this.speculativeAnalysisProvider(frame, this.getDisplayBounds());
          } catch (error) {
            console.warn('⚠ Speculative OCR failed; the initial capture will retry:', error);
          }
        }

        if (this.isOptionKeyPressed && this.optionPressId === pressId) {
          this.prewarmedAnalysis = { frame, pressId, fastMatches };
          console.log(`✓ Prewarmed frame ready${fastMatches ? ` with ${fastMatches.length} fast matches` : ''}`);
        }
      })
      .catch((error) => {
        console.warn('⚠ Prewarm capture failed:', error);
      })
      .finally(() => {
        this.prewarmPromise = null;
      });
  }

  /** Takes the speculative frame and preview result for the current press. */
  private async takePrewarmedAnalysis(): Promise<PrewarmedAnalysis | null> {
    if (this.prewarmPromise) {
      await this.prewarmPromise;
    }

    const prewarmed = this.prewarmedAnalysis;
    this.prewarmedAnalysis = null;

    if (!prewarmed || prewarmed.pressId !== this.optionPressId) {
      return null;
    }

    return prewarmed;
  }

  private getDisplayBounds(): DisplayBounds {
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
      width: primaryDisplay.bounds.width,
      height: primaryDisplay.bounds.height,
      menuBarHeight: primaryDisplay.workArea.y
    };
  }

  private handleOptionTap(releasedAt: number) {
    const timeSinceLastTap =
      this.lastOptionTapAt === null ? Number.POSITIVE_INFINITY : releasedAt - this.lastOptionTapAt;

    if (timeSinceLastTap <= ScreenCapture.OPTION_DOUBLE_PRESS_WINDOW_MS) {
      this.lastOptionTapAt = null;
      console.log('✓ Detected double Option press, handling knowledge base window shortcut');
      if (this.onDoubleOptionPressCallback) {
        this.onDoubleOptionPressCallback();
      }
      return;
    }

    this.lastOptionTapAt = releasedAt;
  }

  private async detectSelectedText() {
    console.log('→ detectSelectedText invoked', JSON.stringify({
      selectionCheckInFlight: this.selectionCheckInFlight,
      selectionCheckedThisPress: this.selectionCheckedThisPress,
      hasCopyShortcut: !!this.nativeModule?.simulateCopyShortcut
    }));

    if (this.selectionCheckInFlight || !this.nativeModule?.simulateCopyShortcut) {
      if (!this.nativeModule?.simulateCopyShortcut) {
        console.warn('⚠ Selected text detection unavailable: nativeModule.simulateCopyShortcut missing');
      }
      return;
    }

    this.selectionCheckInFlight = true;
    this.selectionCheckedThisPress = true;
    console.log('→ Checking selected text via simulated copy shortcut');

    try {
      const selection = await this.detectSelectedTextViaClipboard();
      if (this.hasMeaningfulSelection(selection) && this.onSelectionTextCallback) {
        console.log('✓ Selection captured via simulated copy, showing menu', JSON.stringify({
          textLength: selection.text.length,
          hasHtml: !!selection.html,
          hasImage: !!selection.imageDataUrl,
          fileCount: selection.filePaths.length
        }));
        this.onSelectionTextCallback(selection);
      } else {
        console.log('→ No selected text available for menu display');
      }
    } catch (error) {
      console.warn('⚠ Failed to capture selected text via simulated copy:', error);
    } finally {
      this.selectionCheckInFlight = false;
    }
  }

  private hasMeaningfulSelection(selection: SelectionClipboardContent): boolean {
    return Boolean(selection.text || selection.html || selection.imageDataUrl || selection.filePaths.length > 0);
  }

  private async detectSelectedTextViaClipboard(): Promise<SelectionClipboardContent> {
    if (!this.nativeModule?.simulateCopyShortcut) {
      console.warn('⚠ Clipboard fallback unavailable: nativeModule.simulateCopyShortcut missing');
      return {
        text: '',
        html: null,
        rtf: null,
        imageDataUrl: null,
        filePaths: [],
        availableFormats: []
      };
    }

    const backup = this.backupClipboard();

    try {
      const copied = this.nativeModule.simulateCopyShortcut();
      console.log(`→ simulateCopyShortcut result: ${copied}`);
      if (!copied) {
        return {
          text: '',
          html: null,
          rtf: null,
          imageDataUrl: null,
          filePaths: [],
          availableFormats: []
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
      const formats = clipboard.availableFormats();
      const copiedText = clipboard.readText().trim();
      const copiedHtml = this.normalizeClipboardHtml(clipboard.readHTML());
      const copiedRtf = clipboard.readRTF().trim() || null;
      const image = clipboard.readImage();
      const imageDataUrl = image.isEmpty() ? null : image.toDataURL();
      const filePaths = this.extractClipboardFilePaths(copiedText, formats);

      console.log('→ Clipboard fallback captured formats', JSON.stringify({
        textLength: copiedText.length,
        hasHtml: !!copiedHtml,
        hasRtf: !!copiedRtf,
        hasImage: !!imageDataUrl,
        filePaths,
        formats
      }));
      return {
        text: copiedText,
        html: copiedHtml,
        rtf: copiedRtf,
        imageDataUrl,
        filePaths,
        availableFormats: formats
      };
    } catch (error) {
      console.warn('⚠ Clipboard fallback failed:', error);
      return {
        text: '',
        html: null,
        rtf: null,
        imageDataUrl: null,
        filePaths: [],
        availableFormats: []
      };
    } finally {
      this.restoreClipboard(backup);
    }
  }

  private normalizeClipboardHtml(html: string): string | null {
    const normalized = html
      .replace(/^\s*<meta[^>]+>\s*/i, '')
      .trim();
    return normalized.length > 0 ? normalized : null;
  }

  private extractClipboardFilePaths(copiedText: string, formats: string[]): string[] {
    const candidates = new Set<string>();
    const rawTexts = new Set<string>();
    const candidateFormats = new Set([
      ...formats,
      'text/uri-list',
      'public.file-url',
      'NSFilenamesPboardType'
    ]);

    if (copiedText) {
      rawTexts.add(copiedText);
    }

    for (const format of candidateFormats) {
      try {
        const textValue = ((clipboard as any).readText(format) as string).trim();
        if (textValue) {
          rawTexts.add(textValue);
        }
      } catch {}

      try {
        const buffer = clipboard.readBuffer(format);
        if (!buffer || buffer.length === 0) continue;
        rawTexts.add(buffer.toString('utf8'));
        rawTexts.add(buffer.toString('latin1'));
      } catch (error) {
        console.warn(`⚠ Failed to read clipboard buffer for format ${format}:`, error);
      }
    }

    console.log('→ Clipboard file path extraction candidates', JSON.stringify({
      candidateFormats: Array.from(candidateFormats),
      rawTexts: Array.from(rawTexts).slice(0, 10)
    }));

    for (const rawText of rawTexts) {
      for (const filePath of this.extractFilePathsFromRawText(rawText)) {
        candidates.add(filePath);
      }
    }

    return Array.from(candidates).filter((filePath) => fs.existsSync(filePath));
  }

  private extractFilePathsFromRawText(rawText: string): string[] {
    if (!rawText) return [];

    const candidates = new Set<string>();
    const text = rawText.replace(/\r/g, '\n');

    const addPath = (value: string) => {
      const trimmed = value.trim().replace(/\0/g, '');
      if (!trimmed) return;

      const normalized = this.normalizeClipboardFilePath(trimmed);
      if (normalized) {
        candidates.add(normalized);
      }
    };

    const plistMatches = text.matchAll(/<string>([\s\S]*?)<\/string>/g);
    for (const match of plistMatches) {
      addPath(this.decodeXmlEntities(match[1] || ''));
    }

    const uriMatches = text.matchAll(/file:\/\/[^\s"'<>]+/g);
    for (const match of uriMatches) {
      addPath(match[0]);
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      addPath(trimmed);
    }

    return Array.from(candidates);
  }

  private normalizeClipboardFilePath(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('file://')) {
      try {
        return decodeURIComponent(new URL(trimmed).pathname);
      } catch {
        return null;
      }
    }

    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }

    return null;
  }

  private decodeXmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  private backupClipboard(): Array<{ format: string; buffer: Buffer }> {
    const formats = clipboard.availableFormats();
    console.log(`→ Backing up clipboard formats: ${formats.join(', ') || '(empty)'}`);
    return formats.map((format) => ({
      format,
      buffer: clipboard.readBuffer(format)
    }));
  }

  private restoreClipboard(backup: Array<{ format: string; buffer: Buffer }>) {
    clipboard.clear();
    for (const item of backup) {
      clipboard.writeBuffer(item.format, item.buffer);
    }
    console.log(`→ Clipboard restored (${backup.length} formats)`);
  }

  private stopGlobalEventListeners() {
    try {
      if (this.uiohook) {
        this.uiohook.stop();
      }
    } catch (error) {
      // Ignore
    }
  }

  private startCapture() {
    if (this.isActive) return;

    this.isActive = true;
    if (this.onCaptureModeActiveChangeCallback) {
      this.onCaptureModeActiveChangeCallback(true);
    }
    this.lastFrame = null;
    console.log('✓ Starting continuous capture...');

    // First capture: always run OCR regardless of change
    this.captureScreen(true);

    // Subsequent captures: only run OCR if screen changed
    this.captureInterval = setInterval(() => {
      if (this.isActive) {
        this.captureScreen(false);
      }
    }, 500);
  }

  private stopCapture() {
    this.isActive = false;
    if (this.onCaptureModeActiveChangeCallback) {
      this.onCaptureModeActiveChangeCallback(false);
    }
    this.clearMouseSelectionState();

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.onClearCallback) {
      this.onClearCallback();
    }

    this.lastFrame = null;
  }

  private async captureScreen(forceOCR: boolean = false) {
    if (this.isProcessing || !this.isActive) return;

    // For forced OCR (first capture), skip debounce
    const debounceMs = forceOCR ? 0 : 200;

    try {
      this.isProcessing = true;

      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.bounds;
      const menuBarHeight = primaryDisplay.workArea.y;

      // The first frame of a press usually comes from the speculative capture started on keydown.
      const prewarmedAnalysis = forceOCR ? await this.takePrewarmedAnalysis() : null;
      let frame = prewarmedAnalysis?.frame || null;
      const usedPrewarm = frame !== null;
      if (!frame) {
        frame = await this.grabFrame();
      }

      if (!this.isActive) return;

      if (!frame) {
        console.error('No screen sources available');
        return;
      }

      console.log(`✓ Captured screen: ${frame.width}x${frame.height}, ${frame.bitmap.length} bytes${usedPrewarm ? ' (prewarmed)' : ''}`);

      const previous = this.lastFrame;
      let changedRegions: ChangedRegion[] | null = null;
      if (!forceOCR && previous) {
        changedRegions = this.detectChangedRegions(previous, frame);
        if (changedRegions === null) {
          console.log('✓ Frame size changed, running OCR on the full frame');
        } else {
          console.log(`✓ Found ${changedRegions.length} changed regions`);
        }
      } else {
        console.log('✓ Force OCR on first capture...');
      }

      // A frame is only worth OCRing when this is the first capture of a press, the frame size
      // changed, or pixels actually moved. Nothing else can change what gets underlined.
      const shouldRunOcr = forceOCR || changedRegions === null || changedRegions.length > 0;
      if (!shouldRunOcr) {
        return;
      }

      let ocrFrame = frame;
      let ocrRegion: ChangedRegion | null = null;
      if (changedRegions && changedRegions.length > 0 && changedRegions.length < 50) {
        ocrRegion = this.mergeChangedRegions(changedRegions, frame.width, frame.height);

        // OCR only the changed area: crop the pixels the native module will read.
        try {
          ocrFrame = this.cropFrame(frame, ocrRegion);
          console.log(`✓ Cropped to changed region: ${ocrRegion.width}x${ocrRegion.height} at (${ocrRegion.x},${ocrRegion.y})`);
        } catch (e) {
          // Fallback to full frame
          ocrFrame = frame;
          ocrRegion = null;
        }
      }
      // else: too many changed regions, just OCR the full frame

      this.lastFrame = frame;

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      if (debounceMs === 0) {
        // No debounce for first capture
        if (!this.isActive) return;
        console.log('→ Starting OCR (immediate)...');
        await this.callback(
          ocrFrame,
          { width, height, menuBarHeight },
          changedRegions ?? [],
          ocrRegion,
          true,
          prewarmedAnalysis?.fastMatches
        );
      } else {
        this.debounceTimer = setTimeout(async () => {
          if (!this.isActive) return;
          console.log('→ Starting OCR...');
          await this.callback(ocrFrame, { width, height, menuBarHeight }, changedRegions ?? [], ocrRegion, false);
        }, debounceMs);
      }
    } catch (error) {
      console.error('Screen capture error:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Grabs the primary display as a raw bitmap through the configured frame provider.
   * One pixel in the returned frame maps to one point on screen.
   */
  private async grabFrame(): Promise<CapturedFrame | null> {
    if (!this.frameProvider) {
      console.error('No screen frame provider configured');
      return null;
    }

    return this.frameProvider.grabFrame();
  }

  private clearMouseSelectionState() {
    this.pendingMouseSelectionStart = null;
    this.isMouseSelectionActive = false;
    if (this.onSelectionRegionInteractionCallback) {
      this.onSelectionRegionInteractionCallback(false);
    }
    if (this.onSelectionRegionCallback) {
      this.onSelectionRegionCallback(null);
    }
  }

  private isPrimaryMouseButton(event: any): boolean {
    return event?.button === 1;
  }

  private normalizeMousePoint(event: { x: number; y: number }): { x: number; y: number } {
    try {
      const point = screen.screenToDipPoint({ x: event.x, y: event.y });
      return { x: point.x, y: point.y };
    } catch {
      return { x: event.x, y: event.y };
    }
  }

  private buildSelectionRegion(start: { x: number; y: number }, end: { x: number; y: number }): ChangedRegion {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    return { x, y, width, height };
  }

  private async captureSelectionRegion(region: ChangedRegion): Promise<Buffer | null> {
    const frame = await this.grabFrame();
    if (!frame) {
      return null;
    }

    const cropped = this.cropFrame(frame, region);

    // nativeImage expects BGRA, while a frame from the display stream is RGBA.
    if (cropped.pixelFormat === 'rgba') {
      const pixels = cropped.bitmap;
      for (let i = 0; i < pixels.length; i += 4) {
        const red = pixels[i];
        pixels[i] = pixels[i + 2];
        pixels[i + 2] = red;
      }
    }

    const image = nativeImage.createFromBitmap(cropped.bitmap, { width: cropped.width, height: cropped.height });
    return image.toPNG();
  }

  /**
   * Compares two frames block by block and returns the blocks whose pixels moved.
   * Returns null when the frames cannot be compared because their size changed.
   */
  private detectChangedRegions(previous: CapturedFrame, current: CapturedFrame): ChangedRegion[] | null {
    if (previous.width !== current.width || previous.height !== current.height) {
      return null;
    }

    try {
      const width = current.width;
      const height = current.height;
      const oldData = previous.bitmap;
      const newData = current.bitmap;

      // Use horizontal blocks for text-oriented detection
      const blockWidth = 300;  // Wide blocks for horizontal text
      const blockHeight = 100; // Shorter height
      const cols = Math.ceil(width / blockWidth);
      const rows = Math.ceil(height / blockHeight);

      const changedRegions: ChangedRegion[] = [];
      const threshold = 30;
      const changeRatio = 0.05;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const blockX = col * blockWidth;
          const blockY = row * blockHeight;
          const blockW = Math.min(blockWidth, width - blockX);
          const blockH = Math.min(blockHeight, height - blockY);

          let changedPixels = 0;
          let totalPixels = 0;

          for (let y = blockY; y < blockY + blockH; y += 4) {
            for (let x = blockX; x < blockX + blockW; x += 4) {
              const idx = (y * width + x) * 4;

              const rDiff = Math.abs(oldData[idx] - newData[idx]);
              const gDiff = Math.abs(oldData[idx + 1] - newData[idx + 1]);
              const bDiff = Math.abs(oldData[idx + 2] - newData[idx + 2]);
              const diff = (rDiff + gDiff + bDiff) / 3;

              if (diff > threshold) {
                changedPixels++;
              }
              totalPixels++;
            }
          }

          if (totalPixels > 0 && changedPixels / totalPixels > changeRatio) {
            changedRegions.push({
              x: blockX,
              y: blockY,
              width: blockW,
              height: blockH
            });
          }
        }
      }

      return changedRegions;
    } catch (error) {
      console.error('Region detection error:', error);
      return [];
    }
  }

  /** Merges changed blocks into one padded bounding rect, clamped to the frame. */
  private mergeChangedRegions(regions: ChangedRegion[], width: number, height: number): ChangedRegion {
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    for (const region of regions) {
      minX = Math.min(minX, region.x);
      minY = Math.min(minY, region.y);
      maxX = Math.max(maxX, region.x + region.width);
      maxY = Math.max(maxY, region.y + region.height);
    }

    // Add padding around the changed area for context
    const padding = 50;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(width, maxX + padding);
    maxY = Math.min(height, maxY + padding);

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Copies a region out of a frame, row by row. */
  private cropFrame(frame: CapturedFrame, region: ChangedRegion): CapturedFrame {
    const left = Math.max(0, Math.min(Math.round(region.x), frame.width - 1));
    const top = Math.max(0, Math.min(Math.round(region.y), frame.height - 1));
    const width = Math.max(1, Math.min(Math.round(region.width), frame.width - left));
    const height = Math.max(1, Math.min(Math.round(region.height), frame.height - top));

    const bitmap = Buffer.allocUnsafe(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const rowStart = ((top + y) * frame.width + left) * 4;
      frame.bitmap.copy(bitmap, y * rowBytes, rowStart, rowStart + rowBytes);
    }

    return { bitmap, width, height, pixelFormat: frame.pixelFormat };
  }
}

