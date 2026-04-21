// Simple i18n utility for renderer process
export class I18n {
  private translations: Record<string, any> = {};
  private currentLanguage: string = 'en';

  async loadLanguage(lang: string): Promise<void> {
    try {
      const response = await fetch(`../locales/${lang}.json`);
      this.translations = await response.json();
      this.currentLanguage = lang;
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
        return key; // Return key if translation not found
      }
    }

    if (typeof value !== 'string') {
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
}

export const i18n = new I18n();
