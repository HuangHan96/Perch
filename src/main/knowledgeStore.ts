import Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execFile } from 'child_process';
import type { SelectionClipboardContent } from './screenCapture';

const DATA_DIR = path.join(require('os').homedir(), '.perch');
const DB_PATH = path.join(DATA_DIR, 'knowledge.db');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const FILES_DIR = path.join(DATA_DIR, 'data');
const TEXTS_DIR = path.join(FILES_DIR, 'texts');
const IMAGES_DIR = path.join(FILES_DIR, 'images');
const PDFS_DIR = path.join(FILES_DIR, 'pdfs');
const WEB_PAGES_DIR = path.join(FILES_DIR, 'web');

const LMSTUDIO_EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const DEFAULT_CHAT_MODEL = 'qwen3.5-4b';

export interface KnowledgeEntry {
  id: string;
  type: 'text' | 'image' | 'pdf' | 'web';
  title: string;
  content: string;
  image_path: string | null;
  source_path: string | null;
  source_url: string | null;
  source_app_name: string | null;
  source_app_bundle_id: string | null;
  source_app_type: string | null;
  source_window_title: string | null;
  created_at: string;
}

export interface SourceContext {
  source_app_name: string | null;
  source_app_bundle_id: string | null;
  source_app_type: string | null;
  source_window_title: string | null;
}

export interface KeywordInfo {
  keyword: string;
  description: string | null;
  doc_count: number;
  created_at: string;
  updated_at: string;
}

export interface AskAgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskAgentSource {
  id: string;
  type: KnowledgeEntry['type'];
  title: string;
  created_at: string;
  score: number;
  excerpt: string;
  source_url: string | null;
  source_app_name: string | null;
  source_window_title: string | null;
}

export interface AskAgentResponse {
  answer: string;
  sources: AskAgentSource[];
}

export interface KnowledgeBaseSettings {
  apiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  language: string;
}

type AskAgentToolCall =
  | { type: 'tool_call'; tool: 'search_entries'; args?: { query?: string; top_n?: number } }
  | { type: 'tool_call'; tool: 'list_entries'; args?: { start_date?: string; end_date?: string; type?: string; query?: string; limit?: number } }
  | { type: 'tool_call'; tool: 'get_entry'; args?: { id?: string } }
  | { type: 'tool_call'; tool: 'list_keywords'; args?: { query?: string; limit?: number } }
  | { type: 'final'; answer_markdown?: string };

type KeywordExtractionToolCall =
  | { type: 'tool_call'; tool: 'search_existing_keywords'; args?: { query?: string; limit?: number } }
  | { type: 'tool_call'; tool: 'add_keyword'; args?: { keyword?: string; description?: string } }
  | { type: 'final' };

export class KnowledgeStore {
  private db: Database.Database;
  private settings: KnowledgeBaseSettings;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(FILES_DIR, { recursive: true });
    fs.mkdirSync(TEXTS_DIR, { recursive: true });
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.mkdirSync(PDFS_DIR, { recursive: true });
    fs.mkdirSync(WEB_PAGES_DIR, { recursive: true });
    this.settings = this.loadSettings();
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT, image_path TEXT, created_at TEXT NOT NULL,
        embedding BLOB, keywords TEXT, source_path TEXT, source_url TEXT,
        source_app_name TEXT, source_app_bundle_id TEXT, source_app_type TEXT, source_window_title TEXT
      );
      CREATE TABLE IF NOT EXISTS keywords (
        keyword TEXT PRIMARY KEY, description TEXT, embedding BLOB,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry_keywords (
        entry_id TEXT NOT NULL, keyword TEXT NOT NULL,
        PRIMARY KEY (entry_id, keyword),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
        FOREIGN KEY (keyword) REFERENCES keywords(keyword) ON DELETE CASCADE
      );
    `);
    try { this.db.exec('ALTER TABLE entries ADD COLUMN keywords TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_path TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_url TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_app_name TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_app_bundle_id TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_app_type TEXT'); } catch (e) {}
    try { this.db.exec('ALTER TABLE entries ADD COLUMN source_window_title TEXT'); } catch (e) {}
    console.log(`✓ Knowledge store initialized at ${DB_PATH}`);
  }

  // --- Entry CRUD ---

  async addText(title: string, content: string, sourceContext?: SourceContext | null): Promise<KnowledgeEntry & { keywords: string[] }> {
    const id = `txt-${Date.now()}`;
    const now = this.formatTimestamp();
    const sourcePath = this.writeTextSourceFile(id, title, content);
    const context = this.normalizeSourceContext(sourceContext);

    let embedding: Buffer | null = null;
    try {
      const vec = await this.getEmbedding(`${title} ${content}`);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (e) { console.warn('⚠ Embedding failed:', e); }

    const keywords = await this.extractKeywords(`${title}\n${content}`);

    this.db.prepare(
      'INSERT INTO entries (id, type, title, content, image_path, created_at, embedding, keywords, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, 'text', title, content, null, now, embedding, JSON.stringify(keywords), sourcePath, null,
      context.source_app_name, context.source_app_bundle_id, context.source_app_type, context.source_window_title
    );

    await this.linkKeywords(id, keywords);

    console.log(`✓ Added text entry: ${title}, keywords: ${keywords.join(', ')}`);
    return {
      id, type: 'text', title, content, image_path: null, source_path: sourcePath, source_url: null,
      source_app_name: context.source_app_name,
      source_app_bundle_id: context.source_app_bundle_id,
      source_app_type: context.source_app_type,
      source_window_title: context.source_window_title,
      created_at: now, keywords
    };
  }

  async addRichTextSelection(title: string, selection: SelectionClipboardContent, sourceContext?: SourceContext | null): Promise<KnowledgeEntry & { keywords: string[] }> {
    const id = `txt-${Date.now()}`;
    const now = this.formatTimestamp();
    const context = this.normalizeSourceContext(sourceContext);
    const { markdown, plainText } = await this.convertSelectionToMarkdown(id, title, selection);
    const sourcePath = this.writeTextSourceFile(id, title, markdown, '.md');

    let embedding: Buffer | null = null;
    try {
      const vec = await this.getEmbedding(`${title} ${plainText}`);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (e) { console.warn('⚠ Embedding failed:', e); }

    const keywords = await this.extractKeywords(`${title}\n${plainText}`);

    this.db.prepare(
      'INSERT INTO entries (id, type, title, content, image_path, created_at, embedding, keywords, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, 'text', title, plainText, null, now, embedding, JSON.stringify(keywords), sourcePath, null,
      context.source_app_name, context.source_app_bundle_id, context.source_app_type, context.source_window_title
    );

    await this.linkKeywords(id, keywords);

    console.log(`✓ Added rich text entry: ${title}, keywords: ${keywords.join(', ')}`);
    return {
      id, type: 'text', title, content: plainText, image_path: null, source_path: sourcePath, source_url: null,
      source_app_name: context.source_app_name,
      source_app_bundle_id: context.source_app_bundle_id,
      source_app_type: context.source_app_type,
      source_window_title: context.source_window_title,
      created_at: now, keywords
    };
  }

  async addImage(title: string, imagePath: string, ocrText: string, sourceContext?: SourceContext | null): Promise<KnowledgeEntry & { keywords: string[] }> {
    const id = `img-${Date.now()}`;
    const now = this.formatTimestamp();
    const context = this.normalizeSourceContext(sourceContext);

    const ext = path.extname(imagePath) || '.png';
    const destPath = path.join(IMAGES_DIR, `${id}${ext}`);
    fs.copyFileSync(imagePath, destPath);

    let embedding: Buffer | null = null;
    try {
      const vec = await this.getEmbedding(`${title} ${ocrText}`);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (e) { console.warn('⚠ Embedding failed:', e); }

    const keywords = await this.extractKeywords(`${title}\n${ocrText}`);

    this.db.prepare(
      'INSERT INTO entries (id, type, title, content, image_path, created_at, embedding, keywords, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, 'image', title, ocrText, destPath, now, embedding, JSON.stringify(keywords), destPath, null,
      context.source_app_name, context.source_app_bundle_id, context.source_app_type, context.source_window_title
    );

    await this.linkKeywords(id, keywords);

    console.log(`✓ Added image entry: ${title}, keywords: ${keywords.join(', ')}`);
    return {
      id, type: 'image', title, content: ocrText, image_path: destPath, source_path: destPath, source_url: null,
      source_app_name: context.source_app_name,
      source_app_bundle_id: context.source_app_bundle_id,
      source_app_type: context.source_app_type,
      source_window_title: context.source_window_title,
      created_at: now, keywords
    };
  }

  async addPdf(title: string, pdfPath: string, content: string, sourceContext?: SourceContext | null): Promise<KnowledgeEntry & { keywords: string[] }> {
    const id = `pdf-${Date.now()}`;
    const now = this.formatTimestamp();
    const context = this.normalizeSourceContext(sourceContext);

    const ext = path.extname(pdfPath) || '.pdf';
    const destPath = path.join(PDFS_DIR, `${id}${ext}`);
    fs.copyFileSync(pdfPath, destPath);

    let embedding: Buffer | null = null;
    try {
      const vec = await this.getEmbedding(`${title} ${content}`);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (e) { console.warn('⚠ Embedding failed:', e); }

    const keywords = await this.extractKeywords(`${title}\n${content}`);

    this.db.prepare(
      'INSERT INTO entries (id, type, title, content, image_path, created_at, embedding, keywords, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, 'pdf', title, content, null, now, embedding, JSON.stringify(keywords), destPath, null,
      context.source_app_name, context.source_app_bundle_id, context.source_app_type, context.source_window_title
    );

    await this.linkKeywords(id, keywords);

    console.log(`✓ Added pdf entry: ${title}, keywords: ${keywords.join(', ')}`);
    return {
      id, type: 'pdf', title, content, image_path: null, source_path: destPath, source_url: null,
      source_app_name: context.source_app_name,
      source_app_bundle_id: context.source_app_bundle_id,
      source_app_type: context.source_app_type,
      source_window_title: context.source_window_title,
      created_at: now, keywords
    };
  }

  async addWebPage(url: string, sourceContext?: SourceContext | null): Promise<KnowledgeEntry & { keywords: string[] }> {
    const id = `web-${Date.now()}`;
    const now = this.formatTimestamp();
    const snapshotDir = path.join(WEB_PAGES_DIR, id);
    const context = this.normalizeSourceContext(sourceContext);
    const { finalUrl, title, content, sourcePath, faviconPath } = await this.captureWebPageSnapshot(url, snapshotDir);

    let embedding: Buffer | null = null;
    try {
      const vec = await this.getEmbedding(`${title} ${content}`);
      embedding = Buffer.from(new Float32Array(vec).buffer);
    } catch (e) { console.warn('⚠ Embedding failed:', e); }

    const keywords = await this.extractKeywords(`${title}\n${content}`);

    this.db.prepare(
      'INSERT INTO entries (id, type, title, content, image_path, created_at, embedding, keywords, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, 'web', title, content, faviconPath, now, embedding, JSON.stringify(keywords), sourcePath, finalUrl,
      context.source_app_name, context.source_app_bundle_id, context.source_app_type, context.source_window_title
    );

    await this.linkKeywords(id, keywords);

    console.log(`✓ Added web entry: ${title}, keywords: ${keywords.join(', ')}`);
    return {
      id, type: 'web', title, content, image_path: faviconPath, source_path: sourcePath, source_url: finalUrl,
      source_app_name: context.source_app_name,
      source_app_bundle_id: context.source_app_bundle_id,
      source_app_type: context.source_app_type,
      source_window_title: context.source_window_title,
      created_at: now, keywords
    };
  }

  async delete(id: string) {
    // Get affected keywords before deleting
    const affectedKeywords = this.db.prepare(
      'SELECT keyword FROM entry_keywords WHERE entry_id = ?'
    ).all(id) as Array<{ keyword: string }>;

    const entry = this.db.prepare('SELECT type, image_path, source_path FROM entries WHERE id = ?').get(id) as any;
    if (entry?.type === 'web' && entry?.source_path) {
      const snapshotDir = path.dirname(entry.source_path);
      if (snapshotDir.startsWith(WEB_PAGES_DIR) && fs.existsSync(snapshotDir)) {
        try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch (e) {}
      }
    } else {
      if (entry?.type === 'text' && entry?.source_path) {
        const textAssetDir = this.getTextAssetDir(entry.source_path);
        if (fs.existsSync(textAssetDir)) {
          try { fs.rmSync(textAssetDir, { recursive: true, force: true }); } catch (e) {}
        }
      }
      for (const filePath of [entry?.image_path, entry?.source_path]) {
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
      }
    }

    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    // entry_keywords rows deleted by CASCADE

    // Clean up orphaned keywords or update descriptions
    for (const { keyword } of affectedKeywords) {
      const count = (this.db.prepare(
        'SELECT COUNT(*) as c FROM entry_keywords WHERE keyword = ?'
      ).get(keyword) as any).c;

      if (count === 0) {
        this.db.prepare('DELETE FROM keywords WHERE keyword = ?').run(keyword);
        console.log(`✓ Removed orphaned keyword: ${keyword}`);
      }
    }
  }

  list(): Array<KnowledgeEntry & { keywords: string }> {
    return this.db.prepare(
      'SELECT id, type, title, content, image_path, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title, created_at, keywords FROM entries ORDER BY created_at DESC'
    ).all() as Array<KnowledgeEntry & { keywords: string }>;
  }

  getEntry(id: string): KnowledgeEntry | null {
    return (this.db.prepare(
      'SELECT id, type, title, content, image_path, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title, created_at FROM entries WHERE id = ?'
    ).get(id) as KnowledgeEntry) || null;
  }

  getSettings(): KnowledgeBaseSettings {
    return { ...this.settings };
  }

  async listAvailableModels(apiBaseUrl?: string): Promise<string[]> {
    const response = await this.requestOpenAICompatible('GET', 'models', undefined, 15000, apiBaseUrl);
    const models: string[] = Array.isArray(response?.data)
      ? (response.data as Array<{ id?: unknown }>)
          .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
          .filter((value): value is string => value.length > 0)
      : [];
    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
  }

  updateSettings(nextSettings: Partial<KnowledgeBaseSettings>): KnowledgeBaseSettings {
    const nextApiBaseUrl = typeof nextSettings.apiBaseUrl === 'string'
      ? this.normalizeApiBaseUrl(nextSettings.apiBaseUrl)
      : this.settings.apiBaseUrl;
    const nextModel = typeof nextSettings.chatModel === 'string'
      ? nextSettings.chatModel.trim()
      : this.settings.chatModel;
    const nextEmbeddingModel = typeof nextSettings.embeddingModel === 'string'
      ? nextSettings.embeddingModel.trim()
      : this.settings.embeddingModel;
    const nextLanguage = typeof nextSettings.language === 'string'
      ? nextSettings.language.trim()
      : this.settings.language;

    this.settings = {
      apiBaseUrl: nextApiBaseUrl,
      chatModel: nextModel || DEFAULT_CHAT_MODEL,
      embeddingModel: nextEmbeddingModel || LMSTUDIO_EMBED_MODEL,
      language: nextLanguage || 'en'
    };
    this.saveSettings();
    return this.getSettings();
  }

  // --- Keyword management ---

  private async linkKeywords(entryId: string, keywords: string[]) {
    const now = this.formatTimestamp();
    const ensureKw = this.db.prepare(
      'INSERT OR IGNORE INTO keywords (keyword, description, embedding, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?)'
    );
    const insertLink = this.db.prepare(
      'INSERT OR IGNORE INTO entry_keywords (entry_id, keyword) VALUES (?, ?)'
    );

    for (const kw of keywords) {
      ensureKw.run(kw, now, now);
      insertLink.run(entryId, kw);
    }
  }

  getKeywordInfo(keyword: string): (KeywordInfo & { entries: KnowledgeEntry[] }) | null {
    const kw = this.db.prepare(
      'SELECT keyword, description, created_at, updated_at FROM keywords WHERE keyword = ?'
    ).get(keyword) as any;

    if (!kw) return null;

    const entries = this.db.prepare(`
      SELECT e.id, e.type, e.title, e.content, e.image_path, e.source_path, e.source_url, e.source_app_name, e.source_app_bundle_id, e.source_app_type, e.source_window_title, e.created_at FROM entries e
      JOIN entry_keywords ek ON e.id = ek.entry_id
      WHERE ek.keyword = ?
      ORDER BY e.created_at DESC
    `).all(keyword) as KnowledgeEntry[];

    return {
      keyword: kw.keyword,
      description: kw.description,
      doc_count: entries.length,
      created_at: kw.created_at,
      updated_at: kw.updated_at,
      entries
    };
  }

  listKeywords(): KeywordInfo[] {
    return this.db.prepare(`
      SELECT k.keyword, k.description, k.created_at, k.updated_at,
        (SELECT COUNT(*) FROM entry_keywords ek WHERE ek.keyword = k.keyword) as doc_count
      FROM keywords k
      ORDER BY doc_count DESC, k.keyword ASC
    `).all() as KeywordInfo[];
  }

  updateKeyword(oldKeyword: string, newKeyword: string, newDescription: string): void {
    const trimmedOld = oldKeyword.trim();
    const trimmedNew = newKeyword.trim();
    const trimmedDesc = newDescription.trim();

    if (!trimmedOld || !trimmedNew) {
      throw new Error('Keyword name cannot be empty');
    }

    const now = this.formatTimestamp();

    if (trimmedOld !== trimmedNew) {
      const existing = this.db.prepare('SELECT keyword FROM keywords WHERE keyword = ?').get(trimmedNew);
      if (existing) {
        throw new Error('A keyword with this name already exists');
      }

      this.db.prepare('UPDATE keywords SET keyword = ?, description = ?, updated_at = ? WHERE keyword = ?')
        .run(trimmedNew, trimmedDesc, now, trimmedOld);
      this.db.prepare('UPDATE entry_keywords SET keyword = ? WHERE keyword = ?')
        .run(trimmedNew, trimmedOld);
    } else {
      this.db.prepare('UPDATE keywords SET description = ?, updated_at = ? WHERE keyword = ?')
        .run(trimmedDesc, now, trimmedOld);
    }
  }

  getAllKeywords(): string[] {
    // Only return keywords that have at least one linked document
    return (this.db.prepare(
      'SELECT k.keyword FROM keywords k WHERE EXISTS (SELECT 1 FROM entry_keywords ek WHERE ek.keyword = k.keyword)'
    ).all() as Array<{ keyword: string }>).map(r => r.keyword);
  }

  cleanupOrphanedKeywords() {
    const result = this.db.prepare(
      'DELETE FROM keywords WHERE keyword NOT IN (SELECT DISTINCT keyword FROM entry_keywords)'
    ).run();
    if (result.changes > 0) {
      console.log(`✓ Cleaned up ${result.changes} orphaned keywords`);
    }
  }

  getGraphData(): { nodes: Array<{ id: string; type: 'keyword' | 'entry'; label: string; description?: string }>; links: Array<{ source: string; target: string }> } {
    const keywords = this.db.prepare(`
      SELECT k.keyword, k.description FROM keywords k
      WHERE EXISTS (SELECT 1 FROM entry_keywords ek WHERE ek.keyword = k.keyword)
    `).all() as Array<{ keyword: string; description: string }>;

    const entries = this.db.prepare(
      'SELECT id, title, type FROM entries'
    ).all() as Array<{ id: string; title: string; type: string }>;

    const links = this.db.prepare(
      'SELECT entry_id, keyword FROM entry_keywords'
    ).all() as Array<{ entry_id: string; keyword: string }>;

    const nodes: Array<{ id: string; type: 'keyword' | 'entry'; label: string; description?: string }> = [];

    for (const kw of keywords) {
      nodes.push({ id: `kw:${kw.keyword}`, type: 'keyword', label: kw.keyword, description: kw.description });
    }
    for (const e of entries) {
      nodes.push({ id: `entry:${e.id}`, type: 'entry', label: e.title });
    }

    const graphLinks = links.map(l => ({
      source: `kw:${l.keyword}`,
      target: `entry:${l.entry_id}`
    }));

    return { nodes, links: graphLinks };
  }

  // --- Search ---

  async search(keyword: string, topN: number = 5): Promise<Array<KnowledgeEntry & { score: number }>> {
    let queryVec: number[];
    try {
      queryVec = await this.getEmbedding(keyword);
    } catch (e) {
      return this.textSearch(keyword, topN);
    }

    const rows = this.db.prepare(
      'SELECT id, type, title, content, image_path, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title, created_at, embedding FROM entries WHERE embedding IS NOT NULL'
    ).all() as Array<KnowledgeEntry & { embedding: Buffer }>;

    const results: Array<KnowledgeEntry & { score: number }> = [];
    for (const row of rows) {
      const entryVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = this.cosineSimilarity(queryVec, Array.from(entryVec));
      results.push({
        id: row.id, type: row.type, title: row.title, content: row.content, image_path: row.image_path,
        source_path: row.source_path, source_url: row.source_url,
        source_app_name: row.source_app_name, source_app_bundle_id: row.source_app_bundle_id,
        source_app_type: row.source_app_type, source_window_title: row.source_window_title,
        created_at: row.created_at, score
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  async askAgent(messages: AskAgentMessage[]): Promise<AskAgentResponse> {
    const conversation = messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
      .map((message) => ({
        role: message.role,
        content: message.content.trim()
      }))
      .filter((message) => message.content.length > 0)
      .slice(-10);

    const latestUserMessage = [...conversation].reverse().find((message) => message.role === 'user');
    if (!latestUserMessage) {
      return { answer: 'Please ask a question first.', sources: [] };
    }

    const conversationText = conversation.map((message) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${message.content}`;
    }).join('\n');

    const nowContext = this.getCurrentDateTimeContext();
    const sourceRegistry = new Map<string, AskAgentSource>();
    const toolTranscript: string[] = [];

    for (let step = 0; step < 6; step++) {
      const prompt = [
        'You are the built-in agent for a personal knowledge base.',
        'The knowledge-base sources come from the user\'s clipped text selections, saved webpages, screenshots/images, and imported files such as PDFs.',
        'Treat the sources as user-collected evidence, not generic web search results.',
        'You can use tools to query the knowledge base before answering.',
        'This is especially important when the user asks for summaries over a specific time range, relative dates, or historical periods.',
        `Current local datetime: ${nowContext.currentDateTime}`,
        `Current local date: ${nowContext.currentDate}`,
        `Current local weekday: ${nowContext.weekday}`,
        `Timezone: ${nowContext.timeZone}`,
        '',
        'Available tools:',
        '1. search_entries',
        'args: {"query":"string","top_n":1-10}',
        'Use for semantic search when the user asks about a topic or concept.',
        '2. list_entries',
        'args: {"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","type":"text|image|pdf|web","query":"optional string","limit":1-50}',
        'Use when the user asks for entries in a time range, recent entries, or filtered summaries.',
        '3. get_entry',
        'args: {"id":"entry id"}',
        'Use to inspect one specific entry in more detail.',
        '4. list_keywords',
        'args: {"query":"optional string","limit":1-50}',
        'Use when the user asks about recurring themes or keywords.',
        '',
        'Output rules:',
        'Return EXACTLY one JSON object and nothing else.',
        'Tool call format: {"type":"tool_call","tool":"list_entries","args":{"start_date":"2026-04-01","end_date":"2026-04-20","limit":20}}',
        'Final answer format: {"type":"final","answer_markdown":"..."}',
        'When you have enough evidence, answer in markdown.',
        'Use inline citations like [1], [2] that refer to the source numbers shown in tool results.',
        'Do not append a separate sources section; the UI renders sources below the answer.',
        'If evidence is insufficient, say what is missing, but still provide the best answer possible from the available entries.',
        'For time-range questions, prefer list_entries first, then use get_entry on the most relevant items if you need detail.',
        'After one or more useful tool results, do not keep exploring indefinitely. Produce a final answer within the next 1-2 steps.',
        'Never mention internal implementation details such as tools, JSON, parsing, or failure modes.',
        'Match the user language.',
        '',
        'Conversation:',
        conversationText,
        '',
        'Tool transcript so far:',
        toolTranscript.length > 0 ? toolTranscript.join('\n\n') : '(none yet)',
        '',
        'Return the next JSON action now.'
      ].join('\n');

      const rawResponse = (await this.ollamaGenerate(prompt, 900)).trim();
      const parsedAction = this.parseAskAgentAction(rawResponse);

      if (!parsedAction) {
        const directAnswer = await this.generateAskAgentAnswerFromSources(
          latestUserMessage.content,
          Array.from(sourceRegistry.values()),
          toolTranscript,
          nowContext
        );
        if (directAnswer) {
          return {
            answer: directAnswer,
            sources: Array.from(sourceRegistry.values())
          };
        }
        break;
      }

      if (parsedAction.type === 'final') {
        const answer = (parsedAction.answer_markdown || '').trim();
        if (answer) {
          return {
            answer,
            sources: Array.from(sourceRegistry.values())
          };
        }
        const directAnswer = await this.generateAskAgentAnswerFromSources(
          latestUserMessage.content,
          Array.from(sourceRegistry.values()),
          toolTranscript,
          nowContext
        );
        return {
          answer: directAnswer || 'I could not produce an answer from the current knowledge-base context.',
          sources: Array.from(sourceRegistry.values())
        };
      }

      const toolResult = await this.executeAskAgentTool(parsedAction, sourceRegistry);
      toolTranscript.push(toolResult);
    }

    const fallbackSources = await this.buildAskAgentFallbackSources(latestUserMessage.content, sourceRegistry);
    const fallbackAnswer = await this.generateAskAgentAnswerFromSources(
      latestUserMessage.content,
      fallbackSources,
      toolTranscript,
      nowContext
    );
    return {
      answer: fallbackAnswer || this.buildDeterministicAskFallback(latestUserMessage.content, fallbackSources),
      sources: fallbackSources
    };
  }

  private textSearch(keyword: string, topN: number): Array<KnowledgeEntry & { score: number }> {
    const rows = this.db.prepare(
      'SELECT id, type, title, content, image_path, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title, created_at FROM entries WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(`%${keyword}%`, `%${keyword}%`, topN) as KnowledgeEntry[];
    return rows.map(r => ({ ...r, score: 1.0 }));
  }

  private normalizeSourceContext(sourceContext?: SourceContext | null): SourceContext {
    return {
      source_app_name: sourceContext?.source_app_name || null,
      source_app_bundle_id: sourceContext?.source_app_bundle_id || null,
      source_app_type: sourceContext?.source_app_type || null,
      source_window_title: sourceContext?.source_window_title || null
    };
  }

  private writeTextSourceFile(id: string, title: string, content: string, extension: '.txt' | '.md' = '.txt'): string {
    const slug = this.slugify(title) || id;
    const filePath = path.join(TEXTS_DIR, `${id}-${slug}${extension}`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  private buildAgentExcerpt(value: string, maxLength: number = 600): string {
    return value
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  private getCurrentDateTimeContext() {
    const now = new Date();
    return {
      currentDateTime: now.toLocaleString('sv-SE', { timeZoneName: 'short' }).replace(' ', ' '),
      currentDate: now.toLocaleDateString('sv-SE'),
      weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
    };
  }

  private parseAskAgentAction(value: string): AskAgentToolCall | null {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as AskAgentToolCall;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async executeAskAgentTool(action: Exclude<AskAgentToolCall, { type: 'final' }>, sourceRegistry: Map<string, AskAgentSource>): Promise<string> {
    switch (action.tool) {
      case 'search_entries': {
        const query = action.args?.query?.trim() || '';
        const topN = this.clampInteger(action.args?.top_n, 1, 10, 6);
        const results = query ? await this.search(query, topN) : [];
        const sources = results.map((entry) => this.registerAskAgentSource(sourceRegistry, this.toAskAgentSource(entry)));
        return this.formatAskAgentToolResult(sourceRegistry, 'search_entries', { query, top_n: topN }, sources);
      }

      case 'list_entries': {
        const startDate = this.normalizeDateOnly(action.args?.start_date);
        const endDate = this.normalizeDateOnly(action.args?.end_date);
        const type = this.normalizeEntryType(action.args?.type);
        const query = action.args?.query?.trim() || '';
        const limit = this.clampInteger(action.args?.limit, 1, 50, 20);
        const entries = this.listEntriesForAgent({ startDate, endDate, type, query, limit });
        const sources = entries.map((entry) => this.registerAskAgentSource(sourceRegistry, this.toAskAgentSource(entry)));
        return this.formatAskAgentToolResult(sourceRegistry, 'list_entries', { start_date: startDate, end_date: endDate, type, query, limit }, sources);
      }

      case 'get_entry': {
        const id = action.args?.id?.trim() || '';
        const entry = id ? this.getEntry(id) : null;
        const source = entry ? this.registerAskAgentSource(sourceRegistry, this.toAskAgentSource({ ...entry, score: 1 }, 1400)) : null;
        if (!source || !entry) {
          return this.formatAskAgentToolResult(sourceRegistry, 'get_entry', { id }, []);
        }
        const sourceContext = [
          source.type,
          source.created_at,
          source.source_app_name || '',
          source.source_window_title || '',
          source.source_url || '',
          'score=1.000'
        ].filter(Boolean).join(' | ');
        const sourceIndex = this.getAskAgentSourceIndex(sourceRegistry, source.id);
        return [
          'Tool: get_entry',
          `Args: ${JSON.stringify({ id })}`,
          'Results:',
          `[${sourceIndex}] ${source.title}`,
          sourceContext,
          this.buildAgentExcerpt(entry.content || entry.title, 4000) || '(empty)'
        ].join('\n');
      }

      case 'list_keywords': {
        const query = action.args?.query?.trim().toLowerCase() || '';
        const limit = this.clampInteger(action.args?.limit, 1, 50, 20);
        const keywords = (query
          ? this.listKeywords().filter((keyword) => `${keyword.keyword} ${keyword.description || ''}`.toLowerCase().includes(query))
          : this.listKeywords()
        ).slice(0, limit);

        const keywordLines = keywords.length > 0
          ? keywords.map((keyword, index) => `[K${index + 1}] ${keyword.keyword} | docs=${keyword.doc_count} | updated=${keyword.updated_at}${keyword.description ? `\n${keyword.description}` : ''}`).join('\n\n')
          : '(no keywords found)';
        return [
          `Tool: list_keywords`,
          `Args: ${JSON.stringify({ query, limit })}`,
          'Results:',
          keywordLines
        ].join('\n');
      }
    }
  }

  private formatAskAgentToolResult(sourceRegistry: Map<string, AskAgentSource>, tool: string, args: Record<string, unknown>, sources: AskAgentSource[]): string {
    const resultsText = sources.length > 0
      ? sources.map((source) => {
          const sourceContext = [
            source.type,
            source.created_at,
            source.source_app_name || '',
            source.source_window_title || '',
            source.source_url || '',
            `score=${source.score.toFixed(3)}`
          ].filter(Boolean).join(' | ');

          const sourceIndex = this.getAskAgentSourceIndex(sourceRegistry, source.id);
          return [
            `[${sourceIndex}] ${source.title}`,
            sourceContext,
            source.excerpt
          ].join('\n');
        }).join('\n\n')
      : '(no results)';

    return [
      `Tool: ${tool}`,
      `Args: ${JSON.stringify(args)}`,
      'Results:',
      resultsText
    ].join('\n');
  }

  private listEntriesForAgent(options: {
    startDate: string | null;
    endDate: string | null;
    type: KnowledgeEntry['type'] | null;
    query: string;
    limit: number;
  }): Array<KnowledgeEntry & { score: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.startDate) {
      conditions.push('created_at >= ?');
      params.push(`${options.startDate} 00:00`);
    }
    if (options.endDate) {
      conditions.push('created_at <= ?');
      params.push(`${options.endDate} 23:59`);
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.query) {
      conditions.push('(title LIKE ? OR content LIKE ? OR source_window_title LIKE ? OR source_app_name LIKE ?)');
      const like = `%${options.query}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT id, type, title, content, image_path, source_path, source_url, source_app_name, source_app_bundle_id, source_app_type, source_window_title, created_at FROM entries ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, options.limit) as KnowledgeEntry[];

    return rows.map((entry, index) => ({
      ...entry,
      score: Math.max(0.1, 1 - index * 0.02)
    }));
  }

  private toAskAgentSource(entry: KnowledgeEntry & { score: number }, excerptLength: number = 600): AskAgentSource {
    return {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      created_at: entry.created_at,
      score: entry.score,
      excerpt: this.buildAgentExcerpt(entry.content || entry.title, excerptLength),
      source_url: entry.source_url,
      source_app_name: entry.source_app_name,
      source_window_title: entry.source_window_title
    };
  }

  private async buildAskAgentFallbackSources(
    latestQuestion: string,
    sourceRegistry: Map<string, AskAgentSource>
  ): Promise<AskAgentSource[]> {
    const deduped = new Map<string, AskAgentSource>(sourceRegistry);

    const semanticResults = await this.search(latestQuestion, 6);
    for (const entry of semanticResults) {
      const source = this.toAskAgentSource(entry, 1000);
      if (!deduped.has(source.id)) {
        deduped.set(source.id, source);
      }
    }

    if (deduped.size === 0) {
      const recentEntries = this.listEntriesForAgent({
        startDate: null,
        endDate: null,
        type: null,
        query: '',
        limit: 6
      });
      for (const entry of recentEntries) {
        const source = this.toAskAgentSource(entry, 1000);
        if (!deduped.has(source.id)) {
          deduped.set(source.id, source);
        }
      }
    }

    return Array.from(deduped.values()).slice(0, 8);
  }

  private async generateAskAgentAnswerFromSources(
    question: string,
    sources: AskAgentSource[],
    toolTranscript: string[],
    nowContext: ReturnType<KnowledgeStore['getCurrentDateTimeContext']>
  ): Promise<string> {
    if (sources.length === 0) return '';

    const sourceText = sources.map((source, index) => {
      const sourceContext = [
        source.type,
        source.created_at,
        source.source_app_name || '',
        source.source_window_title || '',
        source.source_url || '',
        `score=${source.score.toFixed(3)}`
      ].filter(Boolean).join(' | ');

      return [
        `[${index + 1}] ${source.title}`,
        sourceContext,
        source.excerpt || '(empty)'
      ].join('\n');
    }).join('\n\n');

    const toolContext = toolTranscript.length > 0
      ? toolTranscript.slice(-3).join('\n\n')
      : '(none)';

    try {
      const answer = (await this.ollamaGenerate([
        'You are answering a question from a personal knowledge base.',
        'The sources are user-clipped text, webpages, screenshots/images, and files.',
        'Answer using only the provided sources and current date context.',
        `Current local datetime: ${nowContext.currentDateTime}`,
        `Current local date: ${nowContext.currentDate}`,
        `Timezone: ${nowContext.timeZone}`,
        'Requirements:',
        'Write the best possible answer from the available evidence.',
        'If the evidence is partial, say so briefly, but still summarize what is available.',
        'Never mention tools, JSON, parsing, internal failures, or that you could not complete a tool-driven process.',
        'Use markdown.',
        'Use inline citations like [1], [2] that refer to the source indices below.',
        'Do not append a separate Sources heading.',
        'Match the user language.',
        '',
        `User question: ${question}`,
        '',
        'Recent tool notes:',
        toolContext,
        '',
        'Available sources:',
        sourceText,
        '',
        'Return only the final answer in markdown.'
      ].join('\n'), 900)).trim();

      return answer;
    } catch {
      return '';
    }
  }

  private buildDeterministicAskFallback(question: string, sources: AskAgentSource[]): string {
    const isChinese = /[\u3400-\u9fff]/.test(question);
    if (sources.length === 0) {
      return isChinese
        ? '知识库里暂时没有找到足够相关的摘抄。可以换一个更具体的主题、关键词或时间范围再试。'
        : 'I could not find enough relevant clips in the knowledge base yet. Try a narrower topic, keyword, or time range.';
    }

    const lines = sources.slice(0, 5).map((source, index) => {
      const context = [source.created_at, source.type, source.title].filter(Boolean).join(' · ');
      return isChinese
        ? `- [${index + 1}] ${context}`
        : `- [${index + 1}] ${context}`;
    });

    return isChinese
      ? `我先基于目前找到的摘抄给出可用结果，证据还不算完整。以下条目与问题最相关：\n\n${lines.join('\n')}`
      : `Here is the best answer I can give from the currently matched clips; the evidence is still partial.\n\n${lines.join('\n')}`;
  }

  private registerAskAgentSource(sourceRegistry: Map<string, AskAgentSource>, source: AskAgentSource): AskAgentSource {
    if (!sourceRegistry.has(source.id)) {
      sourceRegistry.set(source.id, source);
    }
    return sourceRegistry.get(source.id)!;
  }

  private getAskAgentSourceIndex(sourceRegistry: Map<string, AskAgentSource>, sourceId: string): number {
    let index = 1;
    for (const id of sourceRegistry.keys()) {
      if (id === sourceId) return index;
      index += 1;
    }
    return index;
  }

  private clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  }

  private normalizeDateOnly(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
  }

  private normalizeEntryType(value: unknown): KnowledgeEntry['type'] | null {
    return value === 'text' || value === 'image' || value === 'pdf' || value === 'web'
      ? value
      : null;
  }

  private getTextAssetDir(sourcePath: string): string {
    const parsed = path.parse(sourcePath);
    return path.join(parsed.dir, `${parsed.name}-assets`);
  }

  private async convertSelectionToMarkdown(id: string, title: string, selection: SelectionClipboardContent): Promise<{ markdown: string; plainText: string }> {
    const assetDir = this.getTextAssetDir(path.join(TEXTS_DIR, `${id}-${this.slugify(title) || id}.md`));

    if (selection.html) {
      const converted = await this.convertHtmlFragmentToMarkdown(selection.html);
      const markdown = await this.localizeMarkdownImages(converted.markdown, converted.images, assetDir, selection.imageDataUrl);
      const plainText = (selection.text || converted.plainText || title).trim() || title;
      return { markdown, plainText };
    }

    if (selection.imageDataUrl) {
      const localizedImagePath = await this.saveSelectionImage(selection.imageDataUrl, assetDir, 0);
      const relativeImagePath = localizedImagePath
        ? this.toPosixPath(path.relative(TEXTS_DIR, localizedImagePath))
        : null;
      const markdown = relativeImagePath
        ? `![Selection image](${relativeImagePath})`
        : selection.text || title;
      const plainText = (selection.text || title).trim() || title;
      return { markdown, plainText };
    }

    return { markdown: selection.text, plainText: selection.text || title };
  }

  private async convertHtmlFragmentToMarkdown(html: string): Promise<{
    markdown: string;
    plainText: string;
    images: Array<{ placeholder: string; src: string; alt: string }>;
  }> {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    try {
      await window.loadURL('about:blank');
      return await window.webContents.executeJavaScript(`
        (() => {
          const html = ${JSON.stringify(html)};
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const images = [];
          let imageIndex = 0;

          const normalizeWhitespace = (value) =>
            value.replace(/\\r/g, '').replace(/[ \\t]+/g, ' ');

          const renderInline = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              return normalizeWhitespace(node.textContent || '');
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const element = node;
            const tag = element.tagName.toLowerCase();
            const children = () => Array.from(element.childNodes).map(renderInline).join('');

            if (tag === 'br') return '\\n';
            if (tag === 'strong' || tag === 'b') {
              const text = children().trim();
              return text ? \`**\${text}**\` : '';
            }
            if (tag === 'em' || tag === 'i') {
              const text = children().trim();
              return text ? \`*\${text}*\` : '';
            }
            if (tag === 'code' && element.parentElement?.tagName.toLowerCase() !== 'pre') {
              const text = (element.textContent || '').trim();
              return text ? \`\\\`\${text}\\\`\` : '';
            }
            if (tag === 'a') {
              const href = element.getAttribute('href') || '';
              const text = children().trim() || href;
              return href ? \`[\${text}](\${href})\` : text;
            }
            if (tag === 'img') {
              const src = element.getAttribute('src') || element.getAttribute('data-src') || '';
              if (!src) return '';
              const alt = element.getAttribute('alt') || 'image';
              const placeholder = \`__IMG_\${imageIndex++}__\`;
              images.push({ placeholder, src, alt });
              return placeholder;
            }

            return children();
          };

          const renderList = (element, ordered) => {
            return Array.from(element.children).map((child, index) => {
              const prefix = ordered ? \`\${index + 1}. \` : '- ';
              const text = Array.from(child.childNodes).map(renderNode).join('').trim();
              return prefix + text.replace(/\\n/g, '\\n  ');
            }).join('\\n') + '\\n\\n';
          };

          const renderNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
              return normalizeWhitespace(node.textContent || '');
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const element = node;
            const tag = element.tagName.toLowerCase();
            const children = () => Array.from(element.childNodes).map(renderNode).join('');
            const inlineChildren = () => Array.from(element.childNodes).map(renderInline).join('');

            if (tag === 'img' || tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'code' || tag === 'a' || tag === 'span') {
              return renderInline(element);
            }

            if (tag === 'pre') {
              const code = element.textContent || '';
              return \`\\n\\\`\\\`\\\`\\n\${code.replace(/\\n+$/, '')}\\n\\\`\\\`\\\`\\n\\n\`;
            }
            if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
              const level = Number(tag.slice(1));
              return \`\${'#'.repeat(level)} \${inlineChildren().trim()}\\n\\n\`;
            }
            if (tag === 'ul') return renderList(element, false);
            if (tag === 'ol') return renderList(element, true);
            if (tag === 'blockquote') {
              const text = children().trim().split('\\n').map((line) => line ? \`> \${line}\` : '>').join('\\n');
              return text + '\\n\\n';
            }
            if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'figure') {
              const text = inlineChildren().trim();
              return text ? text + '\\n\\n' : '';
            }
            if (tag === 'li') {
              return inlineChildren().trim();
            }

            return children();
          };

          const body = doc.body || doc;
          const markdown = Array.from(body.childNodes).map(renderNode).join('')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          const plainText = normalizeWhitespace((body.innerText || '').replace(/\\n{3,}/g, '\\n\\n')).trim();

          return { markdown, plainText, images };
        })();
      `, true);
    } finally {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  }

  private async localizeMarkdownImages(
    markdown: string,
    images: Array<{ placeholder: string; src: string; alt: string }>,
    assetDir: string,
    fallbackImageDataUrl: string | null
  ): Promise<string> {
    let nextMarkdown = markdown;
    let localizedImageCount = 0;

    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      const localizedPath = await this.saveSelectionImage(image.src, assetDir, index, fallbackImageDataUrl);
      const replacementPath = localizedPath
        ? this.toPosixPath(path.relative(TEXTS_DIR, localizedPath))
        : image.src;
      if (localizedPath) {
        localizedImageCount += 1;
      }
      nextMarkdown = nextMarkdown.replace(image.placeholder, `![${image.alt || 'image'}](${replacementPath})`);
    }

    if (localizedImageCount === 0 && fallbackImageDataUrl) {
      const localizedPath = await this.saveSelectionImage(fallbackImageDataUrl, assetDir, images.length);
      if (localizedPath) {
        const replacementPath = this.toPosixPath(path.relative(TEXTS_DIR, localizedPath));
        nextMarkdown = `${nextMarkdown.trim()}\n\n![Selection image](${replacementPath})`.trim();
      }
    }

    return nextMarkdown;
  }

  private async saveSelectionImage(
    src: string,
    assetDir: string,
    index: number,
    fallbackImageDataUrl: string | null = null
  ): Promise<string | null> {
    const effectiveSrc = src.startsWith('blob:') && fallbackImageDataUrl ? fallbackImageDataUrl : src || fallbackImageDataUrl;
    if (!effectiveSrc) return null;

    try {
      const { buffer, contentType, finalUrl } = await this.fetchUrlBuffer(effectiveSrc);
      if (!buffer.length) return null;

      fs.mkdirSync(assetDir, { recursive: true });
      const ext = this.getResourceExtension(finalUrl, contentType, '.png');
      const filePath = path.join(assetDir, `image-${index + 1}${ext}`);
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (error) {
      console.warn(`⚠ Failed to localize selection image from ${effectiveSrc}:`, error);
      return null;
    }
  }

  private toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
  }

  private formatTimestamp(date: Date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  private async captureWebPageSnapshot(url: string, snapshotDir: string): Promise<{
    finalUrl: string;
    title: string;
    content: string;
    sourcePath: string;
    faviconPath: string | null;
  }> {
    fs.mkdirSync(snapshotDir, { recursive: true });

    const sourcePath = path.join(snapshotDir, 'index.html');
    await this.runSingleFileSnapshot(url, sourcePath);

    const html = fs.readFileSync(sourcePath, 'utf8');
    const finalUrl = this.extractSavedPageUrl(html, url);
    const title = this.extractHtmlTitle(html, finalUrl);
    const content = this.extractReadableText(html, title);
    const faviconPath = await this.downloadFavicon(
      [this.extractFaviconUrl(html, finalUrl), this.defaultFaviconUrl(finalUrl)],
      snapshotDir
    );

    return { finalUrl, title, content, sourcePath, faviconPath };
  }

  private runSingleFileSnapshot(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '--yes',
        '--package',
        'single-file-cli',
        'single-file',
        url,
        outputPath,
        '--browser-headless=true',
        '--browser-wait-until=networkIdle',
        '--browser-wait-until-delay=3000',
        '--browser-wait-delay=3000',
        '--browser-load-max-time=120000',
        '--browser-capture-max-time=120000',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--browser-arg=--disable-blink-features=AutomationControlled',
        '--browser-arg=--disable-dev-shm-usage',
        '--browser-arg=--no-sandbox',
        '--browser-arg=--disable-setuid-sandbox',
        '--browser-arg=--disable-web-security',
        '--browser-arg=--disable-features=IsolateOrigins,site-per-process',
        '--accept-language=en-US,en;q=0.9',
        '--block-scripts=false',
        '--block-images=false',
        '--block-fonts=false',
        '--block-videos=false',
        '--block-audios=false',
        '--remove-hidden-elements=false',
        '--remove-unused-styles=false',
        '--remove-unused-fonts=false',
        '--remove-alternative-fonts=false',
        '--remove-alternative-medias=false',
        '--remove-alternative-images=false',
        '--compress-HTML=false',
        '--compress-content=false',
        '--self-extracting-archive=false',
        '--save-original-URLs=true',
        '--insert-meta-CSP=true',
        '--filename-conflict-action=overwrite'
      ];

      execFile('npx', args, {
        timeout: 240000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_cache: path.join(DATA_DIR, 'npm-cache'),
          HOME: require('os').homedir()
        }
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`single-file snapshot failed for ${url}: ${(stderr || stdout || error.message).trim()}`));
          return;
        }
        if (!fs.existsSync(outputPath)) {
          reject(new Error(`single-file did not produce snapshot file for ${url}`));
          return;
        }
        resolve();
      });
    });
  }

  private extractSavedPageUrl(html: string, fallbackUrl: string): string {
    const candidates = [
      this.matchHtmlAttribute(html, /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:url["']/i),
      this.matchHtmlAttribute(html, /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i),
      this.matchHtmlAttribute(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i)
    ];

    for (const candidate of candidates) {
      const resolved = this.resolveHtmlUrl(candidate, fallbackUrl);
      if (resolved) return resolved;
    }

    return fallbackUrl;
  }

  private extractFaviconUrl(html: string, pageUrl: string): string | null {
    const patterns = [
      /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/ig,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/ig
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(html)) !== null) {
        const resolved = this.resolveHtmlUrl(match[1], pageUrl);
        if (resolved) return resolved;
      }
    }

    return null;
  }

  private extractHtmlTitle(html: string, fallbackTitle: string): string {
    const candidates = [
      this.matchHtmlAttribute(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      this.matchHtmlAttribute(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i),
      this.matchHtmlAttribute(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i),
      this.matchHtmlAttribute(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
    ];

    for (const candidate of candidates) {
      const cleaned = this.normalizeExtractedText(candidate);
      if (cleaned) return cleaned;
    }

    return fallbackTitle;
  }

  private extractReadableText(html: string, fallbackText: string): string {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const source = bodyMatch ? bodyMatch[1] : html;
    const cleaned = source
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<template[\s\S]*?<\/template>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    const normalized = this.decodeHtmlEntities(cleaned)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    return normalized || fallbackText;
  }

  private matchHtmlAttribute(html: string, pattern: RegExp): string | null {
    const match = html.match(pattern);
    return match?.[1] ? this.decodeHtmlEntities(match[1].trim()) : null;
  }

  private normalizeExtractedText(value: string | null): string {
    if (!value) return '';
    return this.decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  private resolveHtmlUrl(value: string | null, baseUrl: string): string | null {
    if (!value) return null;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  }

  private decodeHtmlEntities(value: string): string {
    return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const normalized = entity.toLowerCase();
      const namedEntities: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        hellip: '...',
        mdash: '-',
        ndash: '-'
      };

      if (normalized in namedEntities) {
        return namedEntities[normalized];
      }

      if (normalized.startsWith('#x')) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }

      if (normalized.startsWith('#')) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }

      return match;
    });
  }

  private defaultFaviconUrl(pageUrl: string): string | null {
    try {
      const parsed = new URL(pageUrl);
      return `${parsed.origin}/favicon.ico`;
    } catch {
      return null;
    }
  }

  private async downloadFavicon(candidates: Array<string | null | undefined>, snapshotDir: string): Promise<string | null> {
    const uniqueCandidates = Array.from(new Set(candidates.filter((value): value is string => Boolean(value))));
    for (const candidate of uniqueCandidates) {
      try {
        const { buffer, contentType, finalUrl } = await this.fetchUrlBuffer(candidate);
        if (!buffer.length) continue;

        const ext = this.getResourceExtension(finalUrl, contentType, '.ico');
        const faviconPath = path.join(snapshotDir, `favicon${ext}`);
        fs.writeFileSync(faviconPath, buffer);
        return faviconPath;
      } catch (error) {
        console.warn(`⚠ Failed to download favicon from ${candidate}:`, error);
      }
    }

    return null;
  }

  private fetchUrlBuffer(url: string): Promise<{ finalUrl: string; buffer: Buffer; contentType: string | undefined }> {
    return new Promise((resolve, reject) => {
      if (url.startsWith('data:')) {
        try {
          const match = url.match(/^data:([^;,]+)?((?:;base64)?),(.*)$/);
          if (!match) {
            reject(new Error('Invalid data URL'));
            return;
          }

          const [, contentType, encoding, data] = match;
          const buffer = encoding === ';base64'
            ? Buffer.from(data, 'base64')
            : Buffer.from(decodeURIComponent(data), 'utf8');
          resolve({ finalUrl: url, buffer, contentType });
        } catch (error) {
          reject(error);
        }
        return;
      }

      const visit = (targetUrl: string, redirectCount: number) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const client = targetUrl.startsWith('https:') ? https : http;
        const req = client.get(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 KeywordsHighlighter/1.0',
            'Accept': '*/*'
          }
        }, (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location;

          if (status >= 300 && status < 400 && location) {
            res.resume();
            visit(new URL(location, targetUrl).toString(), redirectCount + 1);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on('end', () => {
            resolve({
              finalUrl: targetUrl,
              buffer: Buffer.concat(chunks),
              contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined
            });
          });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Fetch timeout')));
      };

      visit(url, 0);
    });
  }

  private getResourceExtension(resourceUrl: string, contentType?: string, fallback: string = ''): string {
    try {
      const pathname = new URL(resourceUrl).pathname;
      const ext = path.extname(pathname);
      if (ext) return ext;
    } catch {}

    const normalizedType = (contentType || '').split(';')[0].trim().toLowerCase();
    const contentTypeMap: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico'
    };

    return contentTypeMap[normalizedType] || fallback;
  }

  // --- LLM / Embedding ---

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private getEmbedding(text: string): Promise<number[]> {
    return this.requestOpenAICompatible('POST', 'embeddings', {
      model: this.settings.embeddingModel,
      input: text.slice(0, 2000)
    }).then((response) => {
      if (response?.data?.[0]?.embedding) {
        return response.data[0].embedding as number[];
      }
      throw new Error('No embedding');
    });
  }

  private async extractKeywords(text: string): Promise<string[]> {
    try {
      const extracted = await this.extractKeywordsWithTools(text);
      if (extracted.length > 0) return extracted.slice(0, 10);
      return this.extractKeywordsFallback(text).slice(0, 10);
    } catch (e) { console.warn('⚠ Keyword extraction failed:', e); return []; }
  }

  private async extractKeywordsWithTools(text: string): Promise<string[]> {
    const existingKeywords = this.listKeywords();
    const existingKeywordMap = new Map(existingKeywords.map((keyword) => [keyword.keyword.toLowerCase(), keyword]));
    const selectedKeywords: string[] = [];
    const selectedKeywordSet = new Set<string>();
    const keywordDescriptions = new Map<string, string>();
    const toolTranscript: string[] = [];

    for (let step = 0; step < 8; step++) {
      const prompt = [
        'Extract 0-5 keywords from the text and provide a short description for each.',
        '',
        'Use tools to either:',
        '1. Search existing keywords in the knowledge base',
        '2. Add one keyword with its description',
        '3. Finish when done',
        '',
        'Rules:',
        '- Keywords must be specific named entities or concepts',
        '- Exclude dates, numbers, generic words, and common terms',
        '- Each keyword must have a 1-sentence description explaining what it is',
        '- Reuse existing keywords when they match',
        '- Descriptions should explain the concept itself, not where it appears',
        '',
        'Available tools:',
        '1. search_existing_keywords',
        '   args: {"query":"string","limit":1-20}',
        '2. add_keyword',
        '   args: {"keyword":"string","description":"string"}',
        '3. final',
        '   args: {}',
        '',
        'Output rules:',
        'Return EXACTLY one JSON object and nothing else.',
        'Examples:',
        '{"type":"tool_call","tool":"search_existing_keywords","args":{"query":"OpenAI","limit":5}}',
        '{"type":"tool_call","tool":"add_keyword","args":{"keyword":"GPT-4","description":"GPT-4 is a large language model developed by OpenAI for advanced text and multimodal tasks."}}',
        '{"type":"final"}',
        '',
        `Selected keywords so far: ${selectedKeywords.length > 0 ? selectedKeywords.join(', ') : '(none)'}`,
        '',
        'Tool transcript so far:',
        toolTranscript.length > 0 ? toolTranscript.join('\n\n') : '(none yet)',
        '',
        'Text:',
        text.slice(0, 1500),
        '',
        'Return the next JSON action now.'
      ].join('\n');

      const rawResponse = (await this.ollamaGenerate(prompt, 1024)).trim();
      const action = this.parseKeywordExtractionAction(rawResponse);

      if (!action) {
        console.warn('⚠ Failed to parse keyword extraction action:', rawResponse);
        break;
      }

      if (action.type === 'final') {
        break;
      }

      switch (action.tool) {
        case 'search_existing_keywords': {
          const query = action.args?.query?.trim() || '';
          const limit = this.clampInteger(action.args?.limit, 1, 20, 8);
          const results = this.searchExistingKeywordsForExtraction(existingKeywords, query, limit);
          const resultText = results.length > 0
            ? results.map((keyword, index) =>
                `[K${index + 1}] ${keyword.keyword}${keyword.description ? ` | ${keyword.description}` : ''}`
              ).join('\n')
            : '(no matching existing keywords)';
          toolTranscript.push([
            'Tool: search_existing_keywords',
            `Args: ${JSON.stringify({ query, limit })}`,
            'Results:',
            resultText
          ].join('\n'));
          break;
        }

        case 'add_keyword': {
          const rawKeyword = action.args?.keyword?.trim() || '';
          const rawDescription = action.args?.description?.trim() || '';
          if (!rawKeyword || !rawDescription || this.shouldRejectKeywordCandidate(rawKeyword)) {
            toolTranscript.push([
              'Tool: add_keyword',
              `Args: ${JSON.stringify(action.args || {})}`,
              'Results:',
              '(rejected: invalid keyword or description)'
            ].join('\n'));
            break;
          }

          const existingMatch = existingKeywordMap.get(rawKeyword.toLowerCase());
          const resolvedKeyword = existingMatch?.keyword || rawKeyword;
          if (!selectedKeywordSet.has(resolvedKeyword)) {
            selectedKeywordSet.add(resolvedKeyword);
            selectedKeywords.push(resolvedKeyword);
          }
          if (rawDescription) {
            keywordDescriptions.set(resolvedKeyword, rawDescription);
          }

          toolTranscript.push([
            'Tool: add_keyword',
            `Args: ${JSON.stringify({ keyword: rawKeyword, description: rawDescription })}`,
            'Results:',
            `${resolvedKeyword} | ${rawDescription}`
          ].join('\n'));
          break;
        }
      }
    }

    // Persist model-provided descriptions immediately
    const now = this.formatTimestamp();
    for (const keyword of selectedKeywords) {
      const description = keywordDescriptions.get(keyword)?.trim();
      if (!description) continue;
      this.db.prepare(
        'INSERT INTO keywords (keyword, description, embedding, created_at, updated_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(keyword) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at'
      ).run(keyword, description, now, now);
    }

    return selectedKeywords.slice(0, 10);
  }

  private extractKeywordsFallback(text: string): string[] {
    const keywords = new Set<string>();
    const source = text.slice(0, 1200);
    const existingKeywords = this.getAllKeywords();
    const lowerSource = source.toLowerCase();

    for (const keyword of existingKeywords) {
      const normalized = keyword.trim();
      if (!normalized) continue;
      if (lowerSource.includes(normalized.toLowerCase())) {
        if (!this.shouldRejectKeywordCandidate(normalized)) {
          keywords.add(normalized);
        }
      }
      if (keywords.size >= 5) {
        return Array.from(keywords);
      }
    }

    const phraseMatches = source.match(/[A-Z][A-Za-z0-9.+/-]*(?:\s+[A-Z][A-Za-z0-9.+/-]*){0,4}/g) || [];
    for (const phrase of phraseMatches) {
      const normalized = phrase.trim().replace(/\s+/g, ' ');
      if (!normalized || this.shouldRejectKeywordCandidate(normalized)) continue;
      keywords.add(normalized);
      if (keywords.size >= 5) break;
    }

    return Array.from(keywords);
  }

  private parseKeywordExtractionAction(value: string): KeywordExtractionToolCall | null {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as KeywordExtractionToolCall;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private searchExistingKeywordsForExtraction(keywords: KeywordInfo[], query: string, limit: number): KeywordInfo[] {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = normalizedQuery
      ? keywords.filter((keyword) => {
          const haystack = `${keyword.keyword} ${keyword.description || ''}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : keywords;

    return matches
      .slice()
      .sort((a, b) => b.doc_count - a.doc_count || a.keyword.localeCompare(b.keyword))
      .slice(0, limit);
  }

  private sanitizeExtractedKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const unique = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const keyword = item.trim();
      if (!keyword || this.shouldRejectKeywordCandidate(keyword)) continue;
      unique.add(keyword);
    }
    return Array.from(unique);
  }

  private shouldRejectKeywordCandidate(keyword: string): boolean {
    const normalized = keyword.trim();
    if (!normalized) return true;

    const lower = normalized.toLowerCase();
    const compact = lower.replace(/\s+/g, ' ');

    const stopwords = new Set([
      'today', 'tomorrow', 'yesterday', 'text', 'image', 'images', 'file', 'files', 'document', 'documents',
      'article', 'articles', 'page', 'pages', 'website', 'web', 'pdf', 'summary', 'report', 'reports',
      'note', 'notes', 'keyword', 'keywords', 'date', 'time', 'month', 'year', 'day', 'week', 'number',
      'thinking process', 'thinking', 'process', 'analysis', 'reasoning', 'step', 'steps'
    ]);
    const monthWords = new Set([
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
      'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun'
    ]);

    if (stopwords.has(compact) || monthWords.has(compact)) return true;
    if (/^[\d\s\-/:.,%$¥€£+]+$/.test(normalized)) return true;
    if (/^\d{1,4}([\-/.]\d{1,2}([\-/.]\d{1,4})?)?$/.test(normalized)) return true;
    if (/^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?$/i.test(normalized)) return true;
    if (/^(19|20)\d{2}$/.test(normalized)) return true;
    if (normalized.length <= 1) return true;

    return false;
  }

  private ollamaGenerate(prompt: string, maxTokens?: number): Promise<string> {
    const payload: any = {
      model: this.settings.chatModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5
    };

    // Only add max_tokens if explicitly specified
    if (maxTokens !== undefined) {
      payload.max_tokens = maxTokens;
    }

    return this.requestOpenAICompatible('POST', 'chat/completions', payload, 120000)
      .then((response) => response?.choices?.[0]?.message?.content || '');
  }

  private loadSettings(): KnowledgeBaseSettings {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<KnowledgeBaseSettings>;
      return {
        apiBaseUrl: this.normalizeApiBaseUrl(parsed.apiBaseUrl),
        chatModel: typeof parsed.chatModel === 'string' && parsed.chatModel.trim()
          ? parsed.chatModel.trim()
          : DEFAULT_CHAT_MODEL,
        embeddingModel: typeof parsed.embeddingModel === 'string' && parsed.embeddingModel.trim()
          ? parsed.embeddingModel.trim()
          : LMSTUDIO_EMBED_MODEL,
        language: typeof parsed.language === 'string' && parsed.language.trim()
          ? parsed.language.trim()
          : 'en'
      };
    } catch {
      const defaults = {
        apiBaseUrl: this.normalizeApiBaseUrl('http://127.0.0.1:1234'),
        chatModel: DEFAULT_CHAT_MODEL,
        embeddingModel: LMSTUDIO_EMBED_MODEL,
        language: 'en'
      };
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2), 'utf8');
      return defaults;
    }
  }

  private saveSettings() {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  private normalizeApiBaseUrl(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    const withProtocol = raw
      ? (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
      : 'http://127.0.0.1:1234';

    try {
      const url = new URL(withProtocol);
      const normalizedPath = !url.pathname || url.pathname === '/'
        ? '/v1'
        : url.pathname.replace(/\/+$/, '');
      url.pathname = normalizedPath;
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return 'http://127.0.0.1:1234/v1';
    }
  }

  private buildOpenAICompatibleUrl(endpointPath: string, apiBaseUrl?: string): URL {
    const baseUrl = apiBaseUrl ? this.normalizeApiBaseUrl(apiBaseUrl) : this.settings.apiBaseUrl;
    const base = `${baseUrl.replace(/\/+$/, '')}/`;
    return new URL(endpointPath.replace(/^\/+/, ''), base);
  }

  private requestOpenAICompatible(
    method: 'GET' | 'POST',
    endpointPath: string,
    payload?: Record<string, unknown>,
    timeout: number = 30000,
    apiBaseUrl?: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = this.buildOpenAICompatibleUrl(endpointPath, apiBaseUrl);
      const body = method === 'POST' && payload ? JSON.stringify(payload) : null;
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if ((res.statusCode || 500) >= 400) {
              reject(new Error(parsed?.error?.message || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (error) {
            const preview = data.slice(0, 200);
            console.error(`⚠ LLM API returned non-JSON response (${res.statusCode}): ${preview}`);
            reject(new Error(`LLM API error: received HTML/non-JSON response. Is the model loaded in LM Studio?`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('OpenAI-compatible request timeout'));
      });
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  close() { this.db.close(); }
}
