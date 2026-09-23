import { UnderlinePosition } from './overlayManager';
import { CapturedFrame } from './screenCapture';
import * as fs from 'fs';
import * as path from 'path';
import { loadNativeModule } from './nativeLoader';

let nativeOCR: any = null;

try {
  nativeOCR = loadNativeModule('ocr');
  console.log('✓ Native OCR module loaded, performOCRBitmap available:', typeof nativeOCR?.performOCRBitmap);
} catch (error) {
  console.warn('Native OCR module not available, using mock implementation');
}

interface OCRResult {
  text: string;
  keyword: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OCRLevel = 'fast' | 'accurate';

/**
 * Languages the live capture path recognises. Pinning them (and switching off automatic
 * language detection) skips a detection pass, which is worth ~15% of the recognition time.
 * They match the locales the app itself ships.
 */
const CAPTURE_LANGUAGES = ['en-US', 'zh-Hans', 'ja-JP'];

export class OCRManager {
  private keywords: string[] = ['LLM'];
  private configPath: string;

  constructor() {
    this.configPath = path.join(__dirname, '../../config.json');
    this.loadKeywords();
  }

  loadKeywords() {
    try {
      const data = fs.readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(data);
      if (Array.isArray(config.keywords) && config.keywords.length > 0) {
        this.keywords = config.keywords;
      }
    } catch (error) {
      console.warn('⚠ Could not load config.json, using default keywords');
    }
    console.log(`✓ Keywords: ${this.keywords.join(', ')}`);
  }

  getKeywords(): string[] {
    return this.keywords;
  }

  setKeywords(keywords: string[]) {
    this.keywords = keywords;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({ keywords }, null, 2));
    } catch (error) {
      console.error('✗ Failed to save config:', error);
    }
  }

  setKeywordsInMemory(keywords: string[]) {
    this.keywords = keywords;
  }

  async findKeywordMatches(
    frame: CapturedFrame,
    displayBounds: { width: number; height: number; menuBarHeight: number },
    ocrRegion: { x: number; y: number; width: number; height: number } | null,
    level: OCRLevel = 'accurate'
  ): Promise<UnderlinePosition[]> {
    if (frame.width === 0 || frame.height === 0 || frame.bitmap.length === 0) {
      return [];
    }

    if (!nativeOCR || !nativeOCR.performOCRBitmap) {
      console.warn('⚠ Native OCR not available in findKeywordMatches');
      return [];
    }

    try {
      const startTime = performance.now();
      console.log(`→ OCR Manager: ${level} pass on ${frame.width}x${frame.height} (${frame.bitmap.length} bytes) with keywords: ${this.keywords.join(', ')}`);

      const ocrResults: OCRResult[] = await new Promise<OCRResult[]>((resolve, reject) => {
        const options = {
          level,
          pixelFormat: frame.pixelFormat,
          automaticallyDetectsLanguage: false,
          languages: CAPTURE_LANGUAGES
        };
        nativeOCR.performOCRBitmap(frame.bitmap, frame.width, frame.height, this.keywords, options, (err: Error | null, results: OCRResult[]) => {
          if (err) {
            console.error('✗ Native OCR error:', err);
            reject(err);
          } else {
            console.log(`→ Native OCR returned ${results?.length || 0} results`);
            resolve(results || []);
          }
        });
      });

      const ocrTime = performance.now() - startTime;

      // Vision returns boxes normalized to the image it was given, so scale them by the
      // frame size and offset them by where that frame sits on the display.
      const regionOffsetX = ocrRegion ? ocrRegion.x : 0;
      const regionOffsetY = ocrRegion ? ocrRegion.y : 0;

      const matches: UnderlinePosition[] = [];

      for (const result of ocrResults) {
        matches.push({
          x: regionOffsetX + result.x * frame.width,
          y: regionOffsetY + result.y * frame.height - displayBounds.menuBarHeight,
          width: result.width * frame.width,
          height: result.height * frame.height,
          keyword: result.keyword || result.text
        });
      }

      const totalTime = performance.now() - startTime;
      console.log(`✓ OCR complete (${level}): ${ocrResults.length} matches, ${ocrTime.toFixed(0)}ms OCR + ${(totalTime - ocrTime).toFixed(0)}ms processing = ${totalTime.toFixed(0)}ms total`);
      return matches;
    } catch (error) {
      console.error('OCR processing error:', error);
      return [];
    }
  }
}
