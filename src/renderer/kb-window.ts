declare const d3: any;
declare const marked: {
  parse: (markdown: string) => string;
  setOptions?: (options: Record<string, unknown>) => void;
} | undefined;
declare const DOMPurify: {
  sanitize: (dirty: string, config?: Record<string, unknown>) => string;
} | undefined;

type Entry = {
  id: string;
  type: string;
  title: string;
  created_at: string;
  image_path?: string | null;
  source_app_name?: string | null;
  source_app_bundle_id?: string | null;
  source_app_type?: string | null;
  source_window_title?: string | null;
  keywords?: string;
  score?: number;
};

type Keyword = {
  keyword: string;
  doc_count: number;
  updated_at: string;
  description?: string | null;
};

type GraphNode = {
  id: string;
  type: 'keyword' | 'entry';
  label: string;
  description?: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
};

type GraphLink = {
  source: any;
  target: any;
};

type AskMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type AskSource = {
  id: string;
  type: string;
  title: string;
  created_at: string;
  score: number;
  excerpt: string;
  source_url?: string | null;
  source_app_name?: string | null;
  source_window_title?: string | null;
};

type AskResponse = {
  answer: string;
  sources: AskSource[];
};

type AskUiMessage = AskMessage & {
  sources?: AskSource[];
  pending?: boolean;
  error?: boolean;
};

type KbSettings = {
  apiBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  language: string;
};

type KbElectronAPI = {
  kbAddText: (title: string, content: string) => Promise<unknown>;
  kbAddImage: (title: string, imagePath: string) => Promise<unknown>;
  kbAddPdf: (title: string, pdfPath: string) => Promise<unknown>;
  kbDelete: (id: string) => Promise<void>;
  kbList: () => Promise<Entry[]>;
  kbSearch: (query: string) => Promise<Entry[]>;
  kbListKeywords: () => Promise<Keyword[]>;
  kbGraphData: () => Promise<{ nodes: GraphNode[]; links: GraphLink[] }>;
  kbAgentChat: (messages: AskMessage[]) => Promise<AskResponse>;
  kbGetSettings: () => Promise<KbSettings>;
  kbListModels: (apiBaseUrl?: string) => Promise<string[]>;
  kbUpdateSettings: (settings: Partial<KbSettings>) => Promise<KbSettings>;
  selectFile: () => Promise<string | null>;
  getPathForFile: (file: File) => string;
  openDocument: (keyword: string, entry: { id: string; title: string; type: string; time: string }) => Promise<void>;
};

type KbWindowGlobal = Window & typeof globalThis & {
  electronAPI?: KbElectronAPI;
  __kbWindowInitialized?: boolean;
  deleteEntry?: (id: string) => Promise<void>;
};

(() => {
  const kbWindow = window as KbWindowGlobal;
  if (kbWindow.__kbWindowInitialized) {
    console.warn('kb-window.js already initialized; skipping duplicate execution.');
    return;
  }

  kbWindow.__kbWindowInitialized = true;

  function requireElectronAPI(api: KbElectronAPI | undefined): KbElectronAPI {
    if (!api) {
      throw new Error('electronAPI is not available in the knowledge base window.');
    }
    return api;
  }

  const electronAPI = requireElectronAPI(kbWindow.electronAPI);
  let activeBrowseQuery = '';
  let activeEntryTypeFilter = 'all';
  let browseEntriesCache: Entry[] = [];
  let keywordSearchQuery = '';
  let keywordCache: Keyword[] = [];
  let askConversation: AskUiMessage[] = [];
  let askBusy = false;
  let kbSettings: KbSettings | null = null;
  let availableModels: string[] = [];
  let modelsLoadedForEndpoint = '';
  let modelsBusy = false;
  const expandedAskSources = new Set<number>();

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      item.classList.add('active');

      const tab = item.getAttribute('data-tab') || '';
      const panel = document.getElementById(tab);
      if (panel) panel.classList.add('active');

      if (tab === 'browse') void loadEntries();
      if (tab === 'ask') renderAskConversation();
      if (tab === 'keywords') void loadKeywordsTab();
      if (tab === 'graph') void loadGraph();
      if (tab === 'settings') void loadSettingsTab();
    });
  });

  document.getElementById('browse-refresh-btn')?.addEventListener('click', () => {
    void refreshBrowseEntries();
  });

  let selectedFilePath: string | null = null;
  let inputMode = 'text';

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      inputMode = btn.getAttribute('data-mode') || 'text';
      const textInput = document.getElementById('text-input') as HTMLDivElement;
      const fileInput = document.getElementById('file-input') as HTMLDivElement;
      textInput.style.display = inputMode === 'text' ? 'block' : 'none';
      fileInput.style.display = inputMode === 'file' ? 'block' : 'none';
    });
  });

  document.getElementById('btn-add')?.addEventListener('click', async () => {
    const status = document.getElementById('add-status') as HTMLDivElement;

    if (inputMode === 'text') {
      const textarea = document.getElementById('text-content') as HTMLTextAreaElement;
      const content = textarea.value.trim();
      if (!content) {
        setStatus(status, 'Please enter text content', 'error');
        return;
      }

      setStatus(status, 'Processing: embedding + keyword extraction...', 'processing');
      try {
        const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
        await electronAPI.kbAddText(title, content);
        setStatus(status, '✓ Entry added successfully', 'success');
        textarea.value = '';
      } catch (error) {
        setStatus(status, 'Failed: ' + String((error as Error).message || error), 'error');
      }
      return;
    }

    if (!selectedFilePath) {
      setStatus(status, 'Please select a file first', 'error');
      return;
    }

    setStatus(status, 'Processing: extraction + embedding + keywords...', 'processing');
    try {
      const fileName = selectedFilePath.split('/').pop() || 'File';
      const title = fileName.replace(/\.[^/.]+$/, '');
      if (fileName.toLowerCase().endsWith('.pdf')) {
        await electronAPI.kbAddPdf(title, selectedFilePath);
      } else {
        await electronAPI.kbAddImage(title, selectedFilePath);
      }
      setStatus(status, '✓ Entry added successfully', 'success');
      selectedFilePath = null;
      resetDropZone();
    } catch (error) {
      setStatus(status, 'Failed: ' + String((error as Error).message || error), 'error');
    }
  });

  function setStatus(el: HTMLElement | null, text: string, type: string) {
    if (!el) return;
    el.textContent = text;
    el.className = 'status ' + type;
  }

  const dropZone = document.getElementById('drop-zone') as HTMLDivElement;

  dropZone.addEventListener('click', async () => {
    const filePath = await electronAPI.selectFile();
    if (filePath) handleFilePath(filePath);
  });

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    const file = event.dataTransfer?.files[0];
    if (!file) return;

    const filePath = electronAPI.getPathForFile(file);
    if (filePath) handleFilePath(filePath);
  });

  function handleFilePath(filePath: string) {
    selectedFilePath = filePath;
    const fileName = filePath.split('/').pop() || 'File';
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(fileName)) {
      dropZone.innerHTML = `<img src="file://${filePath}"><div style="margin-top:8px;color:var(--text-tertiary);font-size:12px;">${fileName}</div>`;
    } else {
      dropZone.innerHTML = `<div class="drop-zone-icon">📄</div><div class="drop-zone-text" style="color:var(--text-primary);">${fileName}</div>`;
    }
  }

  function resetDropZone() {
    dropZone.innerHTML = '<div class="drop-zone-icon">↑</div><div class="drop-zone-text">Drop a file here or click to select</div>';
  }

  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  document.getElementById('search-box')?.addEventListener('input', (event) => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      activeBrowseQuery = (event.target as HTMLInputElement).value.trim();
      void refreshBrowseEntries();
    }, 300);
  });

  document.querySelectorAll('[data-entry-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextType = button.getAttribute('data-entry-type') || 'all';
      activeEntryTypeFilter = nextType;
      document.querySelectorAll('[data-entry-type]').forEach((current) => current.classList.remove('active'));
      button.classList.add('active');
      renderBrowseEntries();
    });
  });

  let keywordSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  document.getElementById('keyword-search-box')?.addEventListener('input', (event) => {
    if (keywordSearchTimeout) clearTimeout(keywordSearchTimeout);
    keywordSearchTimeout = setTimeout(() => {
      keywordSearchQuery = (event.target as HTMLInputElement).value.trim().toLowerCase();
      renderKeywordResults();
    }, 200);
  });

  document.getElementById('ask-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitAskQuestion();
  });

  document.getElementById('ask-input')?.addEventListener('keydown', async (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      await submitAskQuestion();
    }
  });

  document.getElementById('ask-clear-btn')?.addEventListener('click', () => {
    if (askBusy) return;
    askConversation = [];
    expandedAskSources.clear();
    setAskStatus('');
    renderAskConversation();
    const input = document.getElementById('ask-input') as HTMLTextAreaElement | null;
    input?.focus();
  });

  document.getElementById('settings-save-btn')?.addEventListener('click', async () => {
    await saveSettings();
  });

  document.getElementById('settings-refresh-models-btn')?.addEventListener('click', async () => {
    await refreshAvailableModels(false);
  });

  document.getElementById('settings-api-base-url')?.addEventListener('input', () => {
    availableModels = [];
    modelsLoadedForEndpoint = '';
    renderAvailableModels();
  });

  async function loadEntries() {
    try {
      browseEntriesCache = await electronAPI.kbList();
      renderBrowseEntries();
    } catch {
      const list = document.getElementById('entry-list') as HTMLDivElement;
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠</div>Failed to load entries</div>';
    }
  }

  async function loadSettingsTab() {
    const status = document.getElementById('settings-status') as HTMLDivElement | null;
    const endpointInput = document.getElementById('settings-api-base-url') as HTMLInputElement | null;
    const chatModelInput = document.getElementById('settings-chat-model') as HTMLInputElement | null;
    const embeddingModelInput = document.getElementById('settings-embedding-model') as HTMLInputElement | null;
    const languageSelect = document.getElementById('settings-language') as HTMLSelectElement | null;
    const meta = document.getElementById('settings-meta') as HTMLDivElement | null;

    if (!chatModelInput || !endpointInput || !languageSelect) return;
    setStatus(status, 'Loading settings...', 'processing');

    try {
      kbSettings = await electronAPI.kbGetSettings();
      endpointInput.value = kbSettings.apiBaseUrl || '';
      chatModelInput.value = kbSettings.chatModel || '';
      if (embeddingModelInput) embeddingModelInput.value = kbSettings.embeddingModel || '';
      languageSelect.value = kbSettings.language || 'en';
      if (meta) {
        meta.textContent = `Endpoint: ${kbSettings.apiBaseUrl} · Model: ${kbSettings.chatModel} · Embedding: ${kbSettings.embeddingModel}`;
      }
      setStatus(status, '', '');
      await refreshAvailableModels(true);
    } catch (error) {
      if (meta) meta.textContent = '';
      setStatus(status, 'Failed: ' + String((error as Error).message || error), 'error');
    }
  }

  function renderAvailableModels() {
    const list = document.getElementById('settings-model-list') as HTMLDataListElement | null;
    if (!list) return;

    list.innerHTML = availableModels
      .map((model) => `<option value="${escapeHtmlAttribute(model)}"></option>`)
      .join('');
  }

  async function refreshAvailableModels(silent: boolean) {
    const endpointInput = document.getElementById('settings-api-base-url') as HTMLInputElement | null;
    const status = document.getElementById('settings-status') as HTMLDivElement | null;
    const button = document.getElementById('settings-refresh-models-btn') as HTMLButtonElement | null;
    const meta = document.getElementById('settings-meta') as HTMLDivElement | null;

    if (!endpointInput || modelsBusy) return;

    const requestedEndpoint = endpointInput.value.trim();
    if (!requestedEndpoint) return;
    if (silent && requestedEndpoint === modelsLoadedForEndpoint && availableModels.length > 0) {
      return;
    }

    modelsBusy = true;
    if (button) button.disabled = true;
    if (!silent) {
      setStatus(status, 'Loading models...', 'processing');
    }

    try {
      availableModels = await electronAPI.kbListModels(requestedEndpoint);
      modelsLoadedForEndpoint = endpointInput.value.trim();
      renderAvailableModels();

      if (meta) {
        const currentModel = (document.getElementById('settings-chat-model') as HTMLInputElement | null)?.value.trim() || kbSettings?.chatModel || '';
        const countSuffix = availableModels.length > 0 ? ` · ${availableModels.length} models available` : ' · no models returned';
        meta.textContent = `Endpoint: ${requestedEndpoint} · Model: ${currentModel}${countSuffix}`;
      }

      if (!silent) {
        setStatus(
          status,
          availableModels.length > 0 ? `✓ Loaded ${availableModels.length} models` : 'No models returned by endpoint',
          availableModels.length > 0 ? 'success' : 'processing'
        );
      }
    } catch (error) {
      availableModels = [];
      renderAvailableModels();
      if (!silent) {
        setStatus(status, 'Failed to load models: ' + String((error as Error).message || error), 'error');
      }
    } finally {
      modelsBusy = false;
      if (button) button.disabled = false;
    }
  }

  async function saveSettings() {
    const status = document.getElementById('settings-status') as HTMLDivElement | null;
    const endpointInput = document.getElementById('settings-api-base-url') as HTMLInputElement | null;
    const chatModelInput = document.getElementById('settings-chat-model') as HTMLInputElement | null;
    const embeddingModelInput = document.getElementById('settings-embedding-model') as HTMLInputElement | null;
    const languageSelect = document.getElementById('settings-language') as HTMLSelectElement | null;
    const button = document.getElementById('settings-save-btn') as HTMLButtonElement | null;
    const meta = document.getElementById('settings-meta') as HTMLDivElement | null;

    if (!chatModelInput || !endpointInput || !languageSelect || !button) return;

    const apiBaseUrl = endpointInput.value.trim();
    const chatModel = chatModelInput.value.trim();
    const embeddingModel = embeddingModelInput?.value.trim() || '';
    const language = languageSelect.value;
    const oldLanguage = kbSettings?.language || 'en';

    if (!apiBaseUrl) {
      setStatus(status, 'Please enter an endpoint', 'error');
      endpointInput.focus();
      return;
    }
    if (!chatModel) {
      setStatus(status, 'Please enter a model name', 'error');
      chatModelInput.focus();
      return;
    }

    button.disabled = true;
    setStatus(status, 'Saving settings...', 'processing');

    try {
      kbSettings = await electronAPI.kbUpdateSettings({ apiBaseUrl, chatModel, embeddingModel, language });
      endpointInput.value = kbSettings.apiBaseUrl;
      chatModelInput.value = kbSettings.chatModel;
      if (embeddingModelInput) embeddingModelInput.value = kbSettings.embeddingModel;
      languageSelect.value = kbSettings.language;
      modelsLoadedForEndpoint = kbSettings.apiBaseUrl;
      if (meta) {
        const countSuffix = availableModels.length > 0 ? ` · ${availableModels.length} models available` : '';
        meta.textContent = `Endpoint: ${kbSettings.apiBaseUrl} · Model: ${kbSettings.chatModel} · Embedding: ${kbSettings.embeddingModel}${countSuffix}`;
      }

      // If language changed, reload window
      if (language !== oldLanguage) {
        setStatus(status, '✓ Settings saved. Reloading...', 'success');
        setTimeout(() => {
          window.location.reload();
        }, 500);
      } else {
        setStatus(status, '✓ Settings saved', 'success');
      }
    } catch (error) {
      setStatus(status, 'Failed: ' + String((error as Error).message || error), 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function searchEntries(query: string) {
    try {
      browseEntriesCache = await electronAPI.kbSearch(query);
      renderBrowseEntries();
    } catch {
      const list = document.getElementById('entry-list') as HTMLDivElement;
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠</div>Search failed</div>';
    }
  }

  async function refreshBrowseEntries() {
    if (activeBrowseQuery) {
      await searchEntries(activeBrowseQuery);
    } else {
      await loadEntries();
    }
  }

  function formatEntryTime(value: string): string {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value.replace('T', ' ').slice(0, 16);
    }

    const pad = (part: number) => String(part).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }

  function toFileUrl(filePath: string): string {
    return encodeURI(`file://${filePath}`).replace(/"/g, '%22');
  }

  function renderEntryIcon(entry: Entry): string {
    if (entry.type === 'web' && entry.image_path) {
      return `<img class="entry-favicon" src="${toFileUrl(entry.image_path)}" alt="">`;
    }

    const typeIcons: Record<string, string> = { image: '🖼', pdf: '📑', text: '📝', web: '↗' };
    return typeIcons[entry.type] || '📝';
  }

  function renderBrowseEntries() {
    const list = document.getElementById('entry-list') as HTMLDivElement;
    const filteredEntries = activeEntryTypeFilter === 'all'
      ? browseEntriesCache
      : browseEntriesCache.filter((entry) => entry.type === activeEntryTypeFilter);
    renderEntries(filteredEntries, list);
  }

  function formatSourceContext(entry: Entry): string {
    const parts = [
      entry.source_app_type,
      entry.source_app_name,
      entry.source_window_title
    ].filter((value): value is string => Boolean(value && value.trim()));

    return parts.join(' · ');
  }

  function renderEntries(entries: Entry[], container: HTMLDivElement) {
    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◇</div>No entries found</div>';
      return;
    }

    container.innerHTML = entries.map((entry) => {
      let keywords: string[] = [];
      try { keywords = JSON.parse(entry.keywords || '[]'); } catch {}

      const tagsHtml = keywords.map((keyword) => `<span class="tag">${keyword}</span>`).join('');
      const icon = renderEntryIcon(entry);
      const createdAt = formatEntryTime(entry.created_at);
      const sourceContext = formatSourceContext(entry);

      return `
    <div class="entry-item" data-entry-id="${entry.id}">
      <div class="entry-icon">${icon}</div>
      <div class="entry-info">
        <div class="entry-title">${entry.title}</div>
        <div class="entry-meta">${entry.type} · ${createdAt}${entry.score !== undefined ? ` · ${entry.score.toFixed(3)}` : ''}</div>
        ${sourceContext ? `<div class="entry-source">${sourceContext}</div>` : ''}
        ${tagsHtml ? `<div class="entry-tags">${tagsHtml}</div>` : ''}
      </div>
      <button class="btn btn-danger entry-remove" data-entry-id="${entry.id}" type="button">Remove</button>
    </div>`;
    }).join('');

    container.querySelectorAll('.entry-item').forEach((item) => {
      item.addEventListener('click', async (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.entry-remove')) return;

        const entryId = item.getAttribute('data-entry-id');
        const entry = entries.find((current) => current.id === entryId);
        if (!entry) return;

        await electronAPI.openDocument(entry.title, {
          id: entry.id,
          title: entry.title,
          type: entry.type,
          time: entry.created_at
        });
      });
    });

    container.querySelectorAll('.entry-remove').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const entryId = (button as HTMLButtonElement).getAttribute('data-entry-id');
        if (!entryId) return;
        await deleteEntry(entryId);
      });
    });
  }

  async function loadKeywordsTab() {
    try {
      keywordCache = await electronAPI.kbListKeywords();
      renderKeywordResults();
    } catch {
      const list = document.getElementById('keyword-list') as HTMLDivElement;
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠</div>Failed to load keywords</div>';
    }
  }

  function renderKeywordResults() {
    const list = document.getElementById('keyword-list') as HTMLDivElement;
    const filteredKeywords = keywordSearchQuery
      ? keywordCache.filter((keyword) => {
          const haystack = [
            keyword.keyword,
            keyword.description || ''
          ].join(' ').toLowerCase();
          return haystack.includes(keywordSearchQuery);
        })
      : keywordCache;
    renderKeywords(filteredKeywords, list);
  }

  function renderKeywords(keywords: Keyword[], container: HTMLDivElement) {
    if (keywords.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◈</div>No keywords yet. Add some entries first.</div>';
      return;
    }

    container.innerHTML = keywords.map((keyword) => `
    <div class="keyword-item">
      <div class="keyword-name">${keyword.keyword}</div>
      <div class="keyword-meta">${keyword.doc_count} document${keyword.doc_count !== 1 ? 's' : ''} · updated ${keyword.updated_at}</div>
      ${keyword.description ? `<div class="keyword-desc">${keyword.description}</div>` : ''}
    </div>
  `).join('');
  }

  async function submitAskQuestion() {
    if (askBusy) return;

    const input = document.getElementById('ask-input') as HTMLTextAreaElement | null;
    if (!input) return;

    const question = input.value.trim();
    if (!question) {
      setAskStatus('Ask something first.');
      return;
    }

    askBusy = true;
    setAskControlsDisabled(true);
    input.value = '';

    askConversation = [
      ...askConversation,
      { role: 'user', content: question },
      { role: 'assistant', content: 'Thinking...', pending: true }
    ];
    renderAskConversation();
    setAskStatus('Agent is retrieving relevant entries...');

    try {
      const history = askConversation
        .filter((message) => !message.pending && !message.error)
        .map(({ role, content }) => ({ role, content }));
      const response = await electronAPI.kbAgentChat(history);
      askConversation = [
        ...askConversation.slice(0, -1),
        { role: 'assistant', content: response.answer, sources: response.sources }
      ];
      setAskStatus(response.sources.length > 0 ? `Used ${response.sources.length} source${response.sources.length === 1 ? '' : 's'}.` : 'No matching sources found.');
    } catch (error) {
      askConversation = [
        ...askConversation.slice(0, -1),
        { role: 'assistant', content: String((error as Error).message || error), error: true }
      ];
      setAskStatus('Agent request failed.');
    } finally {
      askBusy = false;
      setAskControlsDisabled(false);
      renderAskConversation();
      input.focus();
    }
  }

  function setAskStatus(message: string) {
    const status = document.getElementById('ask-status') as HTMLDivElement | null;
    if (status) status.textContent = message;
  }

  function setAskControlsDisabled(disabled: boolean) {
    const input = document.getElementById('ask-input') as HTMLTextAreaElement | null;
    const sendButton = document.getElementById('ask-send-btn') as HTMLButtonElement | null;
    const clearButton = document.getElementById('ask-clear-btn') as HTMLButtonElement | null;
    if (input) input.disabled = disabled;
    if (sendButton) sendButton.disabled = disabled;
    if (clearButton) clearButton.disabled = disabled || askConversation.length === 0;
  }

  function renderAskConversation() {
    const thread = document.getElementById('ask-thread') as HTMLDivElement | null;
    const header = document.getElementById('ask-header') as HTMLDivElement | null;
    if (!thread) return;

    header?.classList.toggle('hidden', askConversation.length > 0);
    setAskControlsDisabled(askBusy);

    if (askConversation.length === 0) {
      thread.innerHTML = `
        <div class="ask-empty">
          Ask about anything in your knowledge base. The agent will retrieve related entries first, then answer with source-backed context.
        </div>
      `;
      return;
    }

    thread.innerHTML = askConversation.map((message, messageIndex) => {
      const sourcesHtml = message.sources && message.sources.length > 0
        ? `
          <div class="ask-sources ${expandedAskSources.has(messageIndex) ? '' : 'collapsed'}">
            <div class="ask-sources-header">
              <div class="ask-sources-title">Sources</div>
              <button
                class="ask-sources-toggle"
                type="button"
                data-source-toggle-index="${messageIndex}"
              >${expandedAskSources.has(messageIndex) ? 'Hide' : 'Show'} ${message.sources.length}</button>
            </div>
            <ol class="ask-source-list">
              ${message.sources.map((source, sourceIndex) => `
                <li class="ask-source-item">
                  <button
                    class="ask-source-button"
                    type="button"
                    data-source-message-index="${messageIndex}"
                    data-source-index="${sourceIndex}"
                  >${escapeHtml(source.title)}</button>
                  <span class="ask-source-meta">${escapeHtml(source.type)} · ${escapeHtml(formatEntryTime(source.created_at))} · ${escapeHtml(source.score.toFixed(3))}</span>
                  <span class="ask-source-excerpt">${escapeHtml(source.excerpt)}</span>
                </li>
              `).join('')}
            </ol>
          </div>
        `
        : '';

      return `
        <div class="ask-message ${message.role}">
          <div class="ask-role">${message.role === 'user' ? 'You' : 'Agent'}</div>
          <div class="ask-content">${message.role === 'assistant' ? renderAskAnswerHtml(message.content, message.sources || [], messageIndex) : renderPlainMessageHtml(message.content)}</div>
          ${sourcesHtml}
        </div>
      `;
    }).join('');

    thread.querySelectorAll('.ask-sources-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const element = button as HTMLButtonElement;
        const messageIndex = Number(element.getAttribute('data-source-toggle-index'));
        if (expandedAskSources.has(messageIndex)) {
          expandedAskSources.delete(messageIndex);
        } else {
          expandedAskSources.add(messageIndex);
        }
        renderAskConversation();
      });
    });

    thread.querySelectorAll('.ask-source-button').forEach((button) => {
      button.addEventListener('click', async () => {
        const element = button as HTMLButtonElement;
        const messageIndex = Number(element.getAttribute('data-source-message-index'));
        const sourceIndex = Number(element.getAttribute('data-source-index'));
        const source = askConversation[messageIndex]?.sources?.[sourceIndex];
        if (!source) return;

        await openAskSource(source);
      });
    });

    thread.querySelectorAll('.ask-cite').forEach((citeLink) => {
      citeLink.addEventListener('click', async (event) => {
        event.preventDefault();
        const element = citeLink as HTMLAnchorElement;
        const messageIndex = Number(element.getAttribute('data-source-message-index'));
        const sourceIndex = Number(element.getAttribute('data-source-index'));
        const source = askConversation[messageIndex]?.sources?.[sourceIndex];
        if (!source) return;

        await openAskSource(source);
      });
    });

    thread.scrollTop = thread.scrollHeight;
  }

  async function openAskSource(source: AskSource) {
    await electronAPI.openDocument(source.title, {
      id: source.id,
      title: source.title,
      type: source.type,
      time: source.created_at
    });
  }

  async function deleteEntry(id: string) {
    try {
      await electronAPI.kbDelete(id);
      await loadEntries();
      await loadKeywordsTab();
    } catch (error) {
      console.error('Delete failed:', error);
    }
  }

  const GRAPH_COLORS = [
    '#D97706', '#059669', '#2563EB', '#DC2626', '#7C3AED',
    '#0891B2', '#CA8A04', '#BE185D', '#4F46E5', '#15803D'
  ];

  async function loadGraph() {
    const svg = d3.select('#graph-svg');
    svg.selectAll('*').remove();

    const data = await electronAPI.kbGraphData();
    if (!data || data.nodes.length === 0) {
      svg.append('text').attr('x', '50%').attr('y', '50%')
        .attr('text-anchor', 'middle').attr('fill', '#9B8E82')
        .attr('font-family', 'DM Sans, sans-serif').attr('font-size', '14px')
        .text('No data in knowledge base');
      return;
    }

    const container = document.getElementById('graph-svg') as unknown as SVGElement;
    const width = container.clientWidth;
    const height = container.clientHeight || 500;
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g');
    const zoomBehavior = d3.zoom()
      .scaleExtent([0.3, 5])
      .on('zoom', (event: any) => { g.attr('transform', event.transform); });
    svg.call(zoomBehavior);

    const kwColorMap: Record<string, string> = {};
    let colorIdx = 0;
    data.nodes.filter((node) => node.type === 'keyword').forEach((node) => {
      kwColorMap[node.id] = GRAPH_COLORS[colorIdx++ % GRAPH_COLORS.length];
    });

    const simulation = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(data.links).id((d: GraphNode) => d.id).distance(76).strength(0.7))
      .force('charge', d3.forceManyBody().strength(-185).distanceMax(Math.min(width, height) * 0.54))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d: GraphNode) => d.type === 'keyword' ? 34 : 24).strength(0.92))
      .force('x', d3.forceX(width / 2).strength(0.03))
      .force('y', d3.forceY(height / 2).strength(0.03));

    const link = g.append('g')
      .selectAll('line')
      .data(data.links)
      .join('line')
      .attr('stroke', '#D5CCBF')
      .attr('stroke-width', 1.2)
      .attr('stroke-opacity', 0.5);

    const node = g.append('g')
      .selectAll('g')
      .data(data.nodes)
      .join('g')
      .call(d3.drag()
        .on('start', (event: any, d: GraphNode) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event: any, d: GraphNode) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event: any, d: GraphNode) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    node.filter((d: GraphNode) => d.type === 'keyword')
      .append('circle')
      .attr('r', 16)
      .attr('fill', (d: GraphNode) => kwColorMap[d.id] || '#888')
      .attr('stroke', '#FEFCF9')
      .attr('stroke-width', 2.5);

    node.filter((d: GraphNode) => d.type === 'entry')
      .append('rect')
      .attr('width', 14).attr('height', 14).attr('x', -7).attr('y', -7)
      .attr('rx', 3)
      .attr('fill', '#C4B8A9')
      .attr('stroke', '#FEFCF9')
      .attr('stroke-width', 1.5);

    node.append('text')
      .text((d: GraphNode) => d.label.length > 22 ? d.label.slice(0, 22) + '…' : d.label)
      .attr('x', (d: GraphNode) => d.type === 'keyword' ? 22 : 14)
      .attr('y', 4)
      .attr('fill', (d: GraphNode) => d.type === 'keyword' ? '#1A1614' : '#6B5F54')
      .attr('font-size', (d: GraphNode) => d.type === 'keyword' ? '13px' : '11px')
      .attr('font-weight', (d: GraphNode) => d.type === 'keyword' ? '600' : '400')
      .attr('font-family', (d: GraphNode) => d.type === 'keyword' ? 'Source Serif 4, Georgia, serif' : 'DM Sans, sans-serif');

    const tooltip = d3.select('body').append('div')
      .style('position', 'fixed')
      .style('background', '#1A1614')
      .style('color', '#F5F0E8')
      .style('padding', '10px 14px')
      .style('border-radius', '8px')
      .style('font-family', 'DM Sans, sans-serif')
      .style('font-size', '12px')
      .style('pointer-events', 'none')
      .style('opacity', 0)
      .style('z-index', 10000)
      .style('max-width', '280px')
      .style('line-height', '1.5')
      .style('box-shadow', '0 8px 24px rgba(26,22,20,0.25)');

    node.on('mouseover', (event: MouseEvent, d: GraphNode) => {
      const text = d.description ? `<strong>${d.label}</strong><br>${d.description}` : `<strong>${d.label}</strong>`;
      tooltip.html(text)
        .style('left', (event.pageX + 12) + 'px')
        .style('top', (event.pageY - 12) + 'px')
        .style('opacity', 1);
    }).on('mouseout', () => {
      tooltip.style('opacity', 0);
    });

    let hasFittedGraph = false;
    const fitGraphToViewport = (animate: boolean) => {
      const bounds = (g.node() as SVGGElement | null)?.getBBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

      const padding = 48;
      const scale = Math.max(
        0.45,
        Math.min(
          1.35,
          Math.min(
            (width - padding * 2) / bounds.width,
            (height - padding * 2) / bounds.height
          )
        )
      );
      const translateX = width / 2 - (bounds.x + bounds.width / 2) * scale;
      const translateY = height / 2 - (bounds.y + bounds.height / 2) * scale;
      const transform = d3.zoomIdentity.translate(translateX, translateY).scale(scale);

      if (animate) {
        svg.transition().duration(280).call(zoomBehavior.transform, transform);
      } else {
        svg.call(zoomBehavior.transform, transform);
      }
    };

    simulation.on('tick', () => {
      link.attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: GraphNode) => `translate(${d.x},${d.y})`);

      if (!hasFittedGraph && simulation.alpha() < 0.22) {
        hasFittedGraph = true;
        fitGraphToViewport(true);
      }
    });

    simulation.on('end', () => {
      fitGraphToViewport(!hasFittedGraph);
      hasFittedGraph = true;
    });
  }

  kbWindow.deleteEntry = deleteEntry;
  void refreshBrowseEntries();
})();

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

function renderPlainMessageHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function renderAskAnswerHtml(markdown: string, sources: AskSource[], messageIndex: number): string {
  const rendered = renderMarkdownHtml(markdown);
  return injectCitationLinks(rendered, sources, messageIndex);
}

function renderMarkdownHtml(markdown: string): string {
  if (marked?.setOptions) {
    marked.setOptions({
      breaks: true,
      gfm: true
    });
  }

  const rendered = marked?.parse
    ? marked.parse(markdown)
    : fallbackMarkdownToHtml(markdown);

  if (DOMPurify?.sanitize) {
    return DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'data-source-index', 'data-source-message-index']
    });
  }

  return rendered;
}

function injectCitationLinks(html: string, sources: AskSource[], messageIndex: number): string {
  if (!html || sources.length === 0) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, a')) return NodeFilter.FILTER_REJECT;
      return /\[(\d+)\]/.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  const textNodes: Text[] = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const pattern = /\[(\d+)\]/g;

    while ((match = pattern.exec(text)) !== null) {
      const citeNumber = Number(match[1]);
      const sourceIndex = citeNumber - 1;
      if (sourceIndex < 0 || sourceIndex >= sources.length) {
        continue;
      }

      if (match.index > lastIndex) {
        fragment.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
      }

      const link = doc.createElement('a');
      link.setAttribute('href', '#');
      link.setAttribute('class', 'ask-cite');
      link.setAttribute('data-source-index', String(sourceIndex));
      link.setAttribute('data-source-message-index', String(messageIndex));
      link.textContent = `[${citeNumber}]`;
      fragment.appendChild(link);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex === 0) continue;
    if (lastIndex < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }

  return root.innerHTML;
}

function fallbackMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const htmlParts: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${renderInlineMarkdown(bulletMatch[1])}</li>`);
      continue;
    }

    closeList();

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      htmlParts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    htmlParts.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  return htmlParts.join('');
}

function renderInlineMarkdown(value: string): string {
  const replacements: string[] = [];
  const stash = (html: string) => {
    const token = `\u0000${replacements.length}\u0000`;
    replacements.push(html);
    return token;
  };

  let html = value;
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`));
  html = html.replace(/`([^`]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_match, index) => replacements[Number(index)] || '');
  return html;
}
