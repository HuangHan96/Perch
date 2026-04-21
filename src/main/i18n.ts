import * as fs from 'fs';
import * as path from 'path';

interface OverlayTranslations {
  captureText: string;
  captureFile: string;
  captureImage: string;
  captureWeb: string;
  processing: string;
  saved: string;
  failed: string;
  savingContent: string;
  captureProcessingFailed: string;
  screenshotProcessingFailed: string;
}

class MainI18n {
  private translations: OverlayTranslations = {
    captureText: 'Capture Text',
    captureFile: 'Capture File',
    captureImage: 'Capture Image',
    captureWeb: 'Capture Web',
    processing: 'Processing',
    saved: 'Saved',
    failed: 'Failed',
    savingContent: 'Saving content and building index...',
    captureProcessingFailed: 'Capture processing failed',
    screenshotProcessingFailed: 'Screenshot processing failed'
  };

  loadLanguage(lang: string): void {
    try {
      const localesDir = path.join(__dirname, '../locales');
      const filePath = path.join(localesDir, `${lang}.json`);

      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.overlay) {
          this.translations = data.overlay;
        }
        console.log(`✓ Main process loaded language: ${lang}`);
      }
    } catch (error) {
      console.error(`Failed to load main process language ${lang}:`, error);
      // Keep default English translations
    }
  }

  t(key: keyof OverlayTranslations): string {
    return this.translations[key] || key;
  }
}

export const mainI18n = new MainI18n();
