import { UnderlinePosition } from './overlayManager';
import * as fs from 'fs';
import * as path from 'path';
import { loadNativeModule } from './nativeLoader';

let nativeOCR: any = null;

try {
  nativeOCR = loadNativeModule('ocr');
  console.log('✓ Native OCR module loaded, performOCR available:', typeof nativeOCR?.performOCR);
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
    imageBuffer: Buffer,
    displayBounds: { width: number; height: number; menuBarHeight: number },
    windowBounds: { x: number; y: number; width: number; height: number } | null,
    ocrRegion?: { x: number; y: number; width: number; height: number } | null
  ): Promise<UnderlinePosition[]> {
    if (imageBuffer.length === 0) {
      return [];
    }

    if (!nativeOCR || !nativeOCR.performOCR) {
      console.warn('⚠ Native OCR not available in findKeywordMatches');
      return [];
    }

    try {
      const startTime = performance.now();
      console.log(`→ OCR Manager: Processing ${imageBuffer.length} bytes with keywords: ${this.keywords.join(', ')}`);

      const ocrResults: OCRResult[] = await new Promise<OCRResult[]>((resolve, reject) => {
        nativeOCR.performOCR(imageBuffer, this.keywords, (err: Error | null, results: OCRResult[]) => {
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

      const matches: UnderlinePosition[] = [];

      const offsetX = windowBounds ? windowBounds.x : 0;
      const offsetY = windowBounds ? windowBounds.y : 0;
      const regionOffsetX = ocrRegion ? ocrRegion.x : 0;
      const regionOffsetY = ocrRegion ? ocrRegion.y : 0;
      const imageWidth = ocrRegion ? ocrRegion.width : (windowBounds ? windowBounds.width : displayBounds.width);
      const imageHeight = ocrRegion ? ocrRegion.height : (windowBounds ? windowBounds.height : displayBounds.height);

      for (const result of ocrResults) {
        const fullX = result.x * imageWidth;
        const fullY = result.y * imageHeight;
        const fullWidth = result.width * imageWidth;
        const fullHeight = result.height * imageHeight;

        matches.push({
          x: offsetX + regionOffsetX + fullX,
          y: offsetY + regionOffsetY + fullY - displayBounds.menuBarHeight,
          width: fullWidth,
          height: fullHeight,
          keyword: result.keyword || result.text
        });
      }

      const totalTime = performance.now() - startTime;
      console.log(`✓ OCR complete: ${ocrResults.length} matches, ${ocrTime.toFixed(0)}ms OCR + ${(totalTime - ocrTime).toFixed(0)}ms processing = ${totalTime.toFixed(0)}ms total`);
      return matches;
    } catch (error) {
      console.error('OCR processing error:', error);
      return [];
    }
  }
}
