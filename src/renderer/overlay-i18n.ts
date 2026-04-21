// i18n for overlay window
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

class OverlayI18n {
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

  async loadLanguage(lang: string): Promise<void> {
    try {
      const response = await fetch(`../locales/${lang}.json`);
      if (!response.ok) {
        throw new Error(`Failed to load ${lang}.json`);
      }
      const data = await response.json();
      if (data.overlay) {
        this.translations = data.overlay;
      }
      console.log(`✓ Overlay loaded language: ${lang}`);
    } catch (error) {
      console.error(`Failed to load overlay language ${lang}:`, error);
      // Keep default English translations
    }
  }

  t(key: keyof OverlayTranslations): string {
    return this.translations[key] || key;
  }
}

const overlayI18n = new OverlayI18n();

// Export for use in overlay.ts
(window as any).__overlayI18n = overlayI18n;
