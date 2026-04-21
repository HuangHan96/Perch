import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onDrawUnderlines: (callback: (positions: any[]) => void) => {
    ipcRenderer.on('draw-underlines', (_event, positions) => callback(positions));
  },
  onClearUnderlines: (callback: () => void) => {
    ipcRenderer.on('clear-underlines', () => callback());
  },
  onShowSelectionMenu: (callback: (payload: { x: number; y: number; text: string }) => void) => {
    ipcRenderer.on('show-selection-menu', (_event, payload) => callback(payload));
  },
  onHideSelectionMenu: (callback: () => void) => {
    ipcRenderer.on('hide-selection-menu', () => callback());
  },
  onShowSelectionRegion: (callback: (region: { x: number; y: number; width: number; height: number }) => void) => {
    ipcRenderer.on('show-selection-region', (_event, region) => callback(region));
  },
  onHideSelectionRegion: (callback: () => void) => {
    ipcRenderer.on('hide-selection-region', () => callback());
  },
  onShowProcessingToast: (callback: (payload: { title?: string; message: string; tone?: 'processing' | 'success' | 'error' }) => void) => {
    ipcRenderer.on('show-processing-toast', (_event, payload) => callback(payload));
  },
  onHideProcessingToast: (callback: () => void) => {
    ipcRenderer.on('hide-processing-toast', () => callback());
  },
  setMouseRegion: (hasHoverRegion: boolean) => {
    ipcRenderer.send('set-mouse-region', hasHoverRegion);
  },
  saveSelectedText: (content: string) => ipcRenderer.invoke('save-selected-text', content),
  getKnowledgeData: (keyword: string) => ipcRenderer.invoke('get-knowledge-data', keyword),
  openDocument: (keyword: string, entry: any) => ipcRenderer.invoke('open-document', keyword, entry),
  kbAddText: (title: string, content: string) => ipcRenderer.invoke('kb-add-text', title, content),
  kbAddImage: (title: string, imagePath: string) => ipcRenderer.invoke('kb-add-image', title, imagePath),
  kbAddPdf: (title: string, pdfPath: string) => ipcRenderer.invoke('kb-add-pdf', title, pdfPath),
  kbDelete: (id: string) => ipcRenderer.invoke('kb-delete', id),
  kbList: () => ipcRenderer.invoke('kb-list'),
  kbSearch: (query: string) => ipcRenderer.invoke('kb-search', query),
  kbListKeywords: () => ipcRenderer.invoke('kb-list-keywords'),
  kbGetKeyword: (keyword: string) => ipcRenderer.invoke('kb-get-keyword', keyword),
  kbGraphData: () => ipcRenderer.invoke('kb-graph-data'),
  kbAgentChat: (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => ipcRenderer.invoke('kb-agent-chat', messages),
  kbGetSettings: () => ipcRenderer.invoke('kb-get-settings'),
  kbListModels: (apiBaseUrl?: string) => ipcRenderer.invoke('kb-list-models', apiBaseUrl),
  kbUpdateSettings: (settings: { apiBaseUrl?: string; chatModel?: string }) => ipcRenderer.invoke('kb-update-settings', settings),
  selectFile: () => ipcRenderer.invoke('select-file'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
});
