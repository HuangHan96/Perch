import { desktopCapturer, screen } from 'electron';
import sharp from 'sharp';

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ScreenCapture {
  private captureInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private optionKeyTimer: NodeJS.Timeout | null = null;
  private lastScreenHash: string = '';
  private lastImageBuffer: Buffer | null = null;
  private nativeModule: any = null;
  private uiohook: any = null;
  private isOptionKeyPressed: boolean = false;
  isActive: boolean = false; // Public so index.ts can check
  private callback: (
    imageBuffer: Buffer,
    displayBounds: { width: number; height: number; menuBarHeight: number },
    windowBounds: { x: number; y: number; width: number; height: number } | null,
    changedRegions?: ChangedRegion[],
    ocrRegion?: ChangedRegion | null
  ) => Promise<void>;
  private onClearCallback: (() => void) | null = null;
  private isProcessing: boolean = false;

  constructor(
    callback: (
      imageBuffer: Buffer,
      displayBounds: { width: number; height: number; menuBarHeight: number },
      windowBounds: { x: number; y: number; width: number; height: number } | null,
      changedRegions?: ChangedRegion[],
      ocrRegion?: ChangedRegion | null
    ) => Promise<void>,
    onClear?: () => void
  ) {
    this.callback = callback;
    this.onClearCallback = onClear || null;

    try {
      this.nativeModule = require('../../build/Release/ocr.node');
    } catch (error) {
      console.warn('⚠ Native module not available for window bounds');
    }
  }

  async start() {
    console.log('✓ Screen capture ready. Press and hold Option key to analyze.');
    this.setupGlobalEventListeners();
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
            console.log('✓ Option key pressed, starting in 50ms...');

            this.optionKeyTimer = setTimeout(() => {
              if (this.isOptionKeyPressed) {
                this.startCapture();
              }
            }, 50);
          }
        }
      });

      this.uiohook.on('keyup', (e: any) => {
        if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
          this.isOptionKeyPressed = false;

          if (this.optionKeyTimer) {
            clearTimeout(this.optionKeyTimer);
            this.optionKeyTimer = null;
          }

          if (this.isActive) {
            console.log('✓ Option key released, clearing...');
            this.stopCapture();
          }
        }
      });

      this.uiohook.start();
      console.log('✓ Global event listeners started');
    } catch (error) {
      console.warn('⚠ Could not start global event listeners:', error);
    }
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
    this.lastScreenHash = '';
    this.lastImageBuffer = null;
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

    this.lastScreenHash = '';
    this.lastImageBuffer = null;
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

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      });

      if (!this.isActive) return;

      if (sources.length === 0) {
        console.error('No screen sources available');
        return;
      }

      const source = sources[0];
      const thumbnail = source.thumbnail;
      const imageBuffer = thumbnail.toPNG();
      const thumbnailSize = thumbnail.getSize();

      console.log(`✓ Captured screen: ${thumbnailSize.width}x${thumbnailSize.height}, ${imageBuffer.length} bytes`);

      const currentHash = await this.computeHash(imageBuffer);

      if (!this.isActive) return;

      if (forceOCR || currentHash !== this.lastScreenHash) {
        let changedRegions: ChangedRegion[] = [];
        let ocrBuffer = imageBuffer;
        let ocrRegion: ChangedRegion | null = null;

        if (!forceOCR && this.lastImageBuffer) {
          changedRegions = await this.detectChangedRegions(
            this.lastImageBuffer,
            imageBuffer,
            thumbnailSize.width,
            thumbnailSize.height
          );
          console.log(`✓ Found ${changedRegions.length} changed regions`);

          if (changedRegions.length > 0 && changedRegions.length < 50) {
            // Merge changed regions into a single bounding rect
            let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
            for (const r of changedRegions) {
              minX = Math.min(minX, r.x);
              minY = Math.min(minY, r.y);
              maxX = Math.max(maxX, r.x + r.width);
              maxY = Math.max(maxY, r.y + r.height);
            }

            // Add padding around the changed area for context
            const padding = 50;
            minX = Math.max(0, minX - padding);
            minY = Math.max(0, minY - padding);
            maxX = Math.min(thumbnailSize.width, maxX + padding);
            maxY = Math.min(thumbnailSize.height, maxY + padding);

            ocrRegion = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

            // Crop the image to the changed region
            try {
              ocrBuffer = await sharp(imageBuffer)
                .extract({ left: minX, top: minY, width: ocrRegion.width, height: ocrRegion.height })
                .toBuffer();
              console.log(`✓ Cropped to changed region: ${ocrRegion.width}x${ocrRegion.height} at (${minX},${minY})`);
            } catch (e) {
              // Fallback to full image
              ocrBuffer = imageBuffer;
              ocrRegion = null;
            }
          }
          // else: too many changed regions, just OCR the full image
        } else {
          console.log('✓ Force OCR on first capture...');
        }

        this.lastImageBuffer = imageBuffer;

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        const capturedWindowBounds = null;
        if (debounceMs === 0) {
          // No debounce for first capture
          if (!this.isActive) return;
          console.log('→ Starting OCR (immediate)...');
          await this.callback(ocrBuffer, { width, height, menuBarHeight }, capturedWindowBounds, changedRegions, ocrRegion);
        } else {
          this.debounceTimer = setTimeout(async () => {
            if (!this.isActive) return;
            console.log('→ Starting OCR...');
            await this.callback(ocrBuffer, { width, height, menuBarHeight }, capturedWindowBounds, changedRegions, ocrRegion);
          }, debounceMs);
        }

        this.lastScreenHash = currentHash;
      }
    } catch (error) {
      console.error('Screen capture error:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async computeHash(imageBuffer: Buffer): Promise<string> {
    try {
      const { data, info } = await sharp(imageBuffer)
        .resize(16, 16, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i];
      }
      const avg = sum / data.length;

      let hash = '';
      for (let i = 0; i < data.length; i++) {
        hash += data[i] > avg ? '1' : '0';
      }

      return hash;
    } catch (error) {
      console.error('Hash computation error:', error);
      return '';
    }
  }

  private async detectChangedRegions(
    oldBuffer: Buffer,
    newBuffer: Buffer,
    width: number,
    height: number
  ): Promise<ChangedRegion[]> {
    try {
      const oldData = await sharp(oldBuffer).raw().toBuffer();
      const newData = await sharp(newBuffer).raw().toBuffer();

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

              if (idx + 2 < oldData.length && idx + 2 < newData.length) {
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
}
