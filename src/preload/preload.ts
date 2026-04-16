import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onDrawUnderlines: (callback: (positions: any[]) => void) => {
    ipcRenderer.on('draw-underlines', (_event, positions) => callback(positions));
  },
  onClearUnderlines: (callback: () => void) => {
    ipcRenderer.on('clear-underlines', () => callback());
  },
  setMouseRegion: (hasHoverRegion: boolean) => {
    ipcRenderer.send('set-mouse-region', hasHoverRegion);
  },
  getKnowledgeData: (keyword: string) => {
    return ipcRenderer.invoke('get-knowledge-data', keyword);
  }
});
