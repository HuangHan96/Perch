// i18n integration for kb-window
// This script should be loaded in kb-window.html before kb-window.js

interface Translations {
  [key: string]: string | Translations;
}

class I18n {
  private translations: Translations = {};
  private currentLanguage: string = 'en';

  async loadLanguage(lang: string): Promise<void> {
    try {
      const response = await fetch(`../locales/${lang}.json`);
      if (!response.ok) {
        throw new Error(`Failed to load ${lang}.json`);
      }
      this.translations = await response.json();
      this.currentLanguage = lang;
      console.log(`✓ Loaded language: ${lang}`);
    } catch (error) {
      console.error(`Failed to load language ${lang}:`, error);
      // Fallback to English
      if (lang !== 'en') {
        await this.loadLanguage('en');
      }
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: any = this.translations;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        console.warn(`Translation key not found: ${key}`);
        return key;
      }
    }

    if (typeof value !== 'string') {
      console.warn(`Translation value is not a string: ${key}`);
      return key;
    }

    // Replace parameters like {{count}}
    if (params) {
      return value.replace(/\{\{(\w+)\}\}/g, (match, paramKey) => {
        return params[paramKey]?.toString() || match;
      });
    }

    return value;
  }

  getCurrentLanguage(): string {
    return this.currentLanguage;
  }

  applyTranslations(): void {
    // Update elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = this.t(key);
      }
    });

    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        (el as HTMLInputElement | HTMLTextAreaElement).placeholder = this.t(key);
      }
    });

    // Update HTML content
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (key) {
        el.innerHTML = this.t(key);
      }
    });

    console.log('✓ Applied translations');
  }
}

// Create global i18n instance
const i18n = new I18n();

// Initialize i18n when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initI18n);
} else {
  initI18n();
}

async function initI18n() {
  try {
    // Get language from settings
    const electronAPI = (window as any).electronAPI;
    if (electronAPI && electronAPI.kbGetSettings) {
      const settings = await electronAPI.kbGetSettings();
      const lang = settings.language || 'en';
      await i18n.loadLanguage(lang);
      i18n.applyTranslations();
    } else {
      // Fallback to English if electronAPI is not available
      await i18n.loadLanguage('en');
      i18n.applyTranslations();
    }
  } catch (error) {
    console.error('Failed to initialize i18n:', error);
  }
}

// Export i18n instance
(window as any).__i18n = i18n;
