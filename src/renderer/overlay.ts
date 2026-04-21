interface UnderlinePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  keyword?: string;
}

interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElectronAPI {
  onDrawUnderlines: (callback: (positions: UnderlinePosition[]) => void) => void;
  onClearUnderlines: (callback: () => void) => void;
  onShowSelectionMenu: (callback: (payload: { x: number; y: number; text: string; actionLabel: string }) => void) => void;
  onHideSelectionMenu: (callback: () => void) => void;
  onShowSelectionRegion: (callback: (region: SelectionRegion) => void) => void;
  onHideSelectionRegion: (callback: () => void) => void;
  onShowProcessingToast: (callback: (payload: { title?: string; message: string; tone?: 'processing' | 'success' | 'error' }) => void) => void;
  onHideProcessingToast: (callback: () => void) => void;
  saveSelectedText: (content: string) => Promise<unknown>;
  setMouseRegion: (hasHoverRegion: boolean) => void;
  getKnowledgeData: (keyword: string) => Promise<{
    summary: string;
    entries: Array<{ type: string; title: string; id: string; time: string }>;
  } | null>;
  openDocument: (keyword: string, entry: { type: string; title: string; id: string; time: string }) => Promise<void>;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hoverCard = document.getElementById('hover-card') as HTMLDivElement;
const hoverKeyword = document.getElementById('hover-keyword') as HTMLDivElement;
const hoverSummary = document.getElementById('hover-summary') as HTMLDivElement;
const hoverEntries = document.getElementById('hover-entries') as HTMLDivElement;
const selectionMenu = document.getElementById('selection-menu') as HTMLDivElement;
const selectionAction = document.getElementById('selection-action') as HTMLButtonElement;
const processingToast = document.getElementById('processing-toast') as HTMLDivElement;
const processingToastTitle = document.getElementById('processing-toast-title') as HTMLDivElement;
const processingToastMessage = document.getElementById('processing-toast-message') as HTMLDivElement;
let selectedText = '';
let underlinePositions: UnderlinePosition[] = [];
let activeHoverKeyword = '';
let hoverCardVisible = false;
let selectionMenuVisible = false;
let currentHoverRequestId = 0;
let hoveredUnderlineKey = '';
let activeHoverPosition: UnderlinePosition | null = null;
let hoverCardBounds: { left: number; top: number; right: number; bottom: number } | null = null;
let selectionActionLabel = '摘抄文本';
let activeSelectionRegion: SelectionRegion | null = null;
let processingToastHideTimer: number | null = null;

// Get i18n instance from window (set by overlay-i18n.ts)
function getOverlayI18n() {
  return (window as any).__overlayI18n;
}

// Initialize i18n with language from settings
async function initOverlayI18n() {
  try {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI && electronAPI.kbGetSettings) {
      const settings = await electronAPI.kbGetSettings();
      const lang = settings?.language || 'en';
      const i18n = getOverlayI18n();
      if (i18n) {
        await i18n.loadLanguage(lang);
        selectionActionLabel = i18n.t('captureText');
        console.log(`✓ Overlay initialized with language: ${lang}`);
      }
    }
  } catch (error) {
    console.error('Failed to initialize overlay i18n:', error);
  }
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOverlayI18n);
} else {
  initOverlayI18n();
}

function resizeCanvas() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = window.devicePixelRatio;

  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderOverlay();
}

function drawUnderlines(positions: UnderlinePosition[]) {
  console.log(`[Overlay] Drawing ${positions.length} underlines`);
  underlinePositions = positions;
  renderOverlay();
}

function clearUnderlines() {
  console.log('[Overlay] Clearing underlines');
  underlinePositions = [];
  hoveredUnderlineKey = '';
  activeHoverPosition = null;
  renderOverlay();
  hideHoverCard();
}

function showSelectionRegion(region: SelectionRegion) {
  activeSelectionRegion = region;
  hideHoverCard();
  renderOverlay();
}

function hideSelectionRegion() {
  if (!activeSelectionRegion) return;
  activeSelectionRegion = null;
  renderOverlay();
}

function hideSelectionMenu() {
  console.log('[Overlay] Hiding selection menu');
  selectedText = '';
  const i18n = getOverlayI18n();
  selectionActionLabel = i18n?.t('captureText') || '摘抄文本';
  selectionMenuVisible = false;
  selectionMenu.classList.add('hidden');
  selectionAction.textContent = selectionActionLabel;
  updateMouseRegionState(false);
}

function showProcessingToast(payload: { title?: string; message: string; tone?: 'processing' | 'success' | 'error' }) {
  if (processingToastHideTimer !== null) {
    window.clearTimeout(processingToastHideTimer);
    processingToastHideTimer = null;
  }

  processingToast.classList.remove('hidden', 'success', 'error');
  if (payload.tone === 'success') {
    processingToast.classList.add('success');
  } else if (payload.tone === 'error') {
    processingToast.classList.add('error');
  }

  const i18n = getOverlayI18n();
  processingToastTitle.textContent = payload.title || (
    payload.tone === 'success' ? (i18n?.t('saved') || '已完成') :
    payload.tone === 'error' ? (i18n?.t('failed') || '失败') :
    (i18n?.t('processing') || '处理中')
  );
  processingToastMessage.textContent = payload.message;

  if (payload.tone === 'success' || payload.tone === 'error') {
    processingToastHideTimer = window.setTimeout(() => {
      hideProcessingToast();
    }, payload.tone === 'success' ? 1800 : 2600);
  }
}

function hideProcessingToast() {
  if (processingToastHideTimer !== null) {
    window.clearTimeout(processingToastHideTimer);
    processingToastHideTimer = null;
  }
  processingToast.classList.add('hidden');
  processingToast.classList.remove('success', 'error');
}

function showSelectionMenu(payload: { x: number; y: number; text: string; actionLabel: string }) {
  console.log('[Overlay] Showing selection menu payload:', {
    x: payload.x,
    y: payload.y,
    textLength: payload.text.length,
    actionLabel: payload.actionLabel
  });
  selectedText = payload.text;
  selectionActionLabel = payload.actionLabel || '摘抄文本';
  selectionMenuVisible = true;
  selectionMenu.classList.remove('hidden');
  selectionAction.textContent = selectionActionLabel;
  selectionMenu.style.left = '0px';
  selectionMenu.style.top = '0px';

  const edgeMargin = 8;
  const pointerGap = 6;
  const menuWidth = selectionMenu.offsetWidth || 96;
  const menuHeight = selectionMenu.offsetHeight || 40;
  const preferredLeft = payload.x + pointerGap;
  const preferredTop = payload.y + pointerGap;
  const left = Math.min(
    Math.max(edgeMargin, preferredLeft),
    Math.max(edgeMargin, window.innerWidth - menuWidth - edgeMargin)
  );
  const topBelow = preferredTop;
  const topAbove = payload.y - menuHeight - pointerGap;
  const top = topBelow + menuHeight + edgeMargin <= window.innerHeight
    ? topBelow
    : Math.max(edgeMargin, topAbove);

  selectionMenu.style.left = `${left}px`;
  selectionMenu.style.top = `${top}px`;
  updateMouseRegionState(true);
}

function renderOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#FF6B6B';
  for (const pos of underlinePositions) {
    const underlineY = getUnderlineY(pos);
    const isHovered = getUnderlineKey(pos) === hoveredUnderlineKey;
    ctx.lineWidth = isHovered ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(pos.x, underlineY);
    ctx.lineTo(pos.x + pos.width, underlineY);
    ctx.stroke();
  }

  if (activeSelectionRegion && activeSelectionRegion.width > 0 && activeSelectionRegion.height > 0) {
    ctx.save();
    ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.fillRect(activeSelectionRegion.x, activeSelectionRegion.y, activeSelectionRegion.width, activeSelectionRegion.height);
    ctx.strokeRect(activeSelectionRegion.x, activeSelectionRegion.y, activeSelectionRegion.width, activeSelectionRegion.height);
    ctx.restore();
  }
}

function getUnderlineKey(pos: UnderlinePosition) {
  return `${pos.keyword || ''}:${Math.round(pos.x)}:${Math.round(pos.y)}:${Math.round(pos.width)}:${Math.round(pos.height)}`;
}

function getUnderlineY(pos: UnderlinePosition) {
  return pos.y + pos.height - 1;
}

function updateMouseRegionState(hoveringUnderline: boolean) {
  (window as any).electronAPI.setMouseRegion(
    hoveringUnderline || hoverCardVisible || selectionMenuVisible
  );
}

function isPointInUnderline(x: number, y: number, pos: UnderlinePosition) {
  const paddingX = 6;
  const paddingTop = 6;
  const paddingBottom = 8;
  const underlineY = getUnderlineY(pos);

  return (
    x >= pos.x - paddingX &&
    x <= pos.x + pos.width + paddingX &&
    y >= underlineY - paddingTop &&
    y <= underlineY + paddingBottom
  );
}

function findUnderlineAt(x: number, y: number) {
  return underlinePositions.find((pos) => isPointInUnderline(x, y, pos)) || null;
}

function setHoveredUnderline(pos: UnderlinePosition | null) {
  const nextKey = pos ? getUnderlineKey(pos) : '';
  if (nextKey === hoveredUnderlineKey) {
    return;
  }

  hoveredUnderlineKey = nextKey;
  drawUnderlines(underlinePositions);
}

function isPointInHoverBridge(x: number, y: number) {
  if (!activeHoverPosition || !hoverCardBounds) {
    return false;
  }

  const underlineY = getUnderlineY(activeHoverPosition);
  const bridgeLeft = Math.min(activeHoverPosition.x, hoverCardBounds.left) - 12;
  const bridgeRight = Math.max(activeHoverPosition.x + activeHoverPosition.width, hoverCardBounds.right) + 12;
  const bridgeTop = Math.min(underlineY - 6, hoverCardBounds.top);
  const bridgeBottom = Math.max(underlineY + 10, hoverCardBounds.top + 6);

  return (
    x >= bridgeLeft &&
    x <= bridgeRight &&
    y >= bridgeTop &&
    y <= bridgeBottom
  );
}

function hideHoverCard() {
  if (!hoverCardVisible && hoverCard.classList.contains('hidden')) return;

  hoverCardVisible = false;
  activeHoverKeyword = '';
  activeHoverPosition = null;
  hoverCardBounds = null;
  hoverCard.classList.add('hidden');
  hoverEntries.innerHTML = '';
  setHoveredUnderline(null);
}

async function showHoverCard(pos: UnderlinePosition) {
  const keyword = pos.keyword || '';
  if (!keyword) return;

  const cardX = Math.min(pos.x, window.innerWidth - 340);
  const cardY = Math.min(pos.y + pos.height + 18, window.innerHeight - 220);

  hoverCard.style.left = `${Math.max(12, cardX)}px`;
  hoverCard.style.top = `${Math.max(12, cardY)}px`;
  hoverCard.classList.remove('hidden');
  hoverCardVisible = true;
  activeHoverPosition = pos;
  hoverCardBounds = {
    left: Math.max(12, cardX),
    top: Math.max(12, cardY),
    right: Math.max(12, cardX) + 320,
    bottom: Math.max(12, cardY) + 220
  };
  setHoveredUnderline(pos);
  updateMouseRegionState(true);

  if (activeHoverKeyword === keyword) {
    return;
  }

  activeHoverKeyword = keyword;
  hoverKeyword.textContent = keyword;
  hoverSummary.textContent = '加载中...';
  hoverEntries.innerHTML = '';

  const requestId = ++currentHoverRequestId;

  try {
    const data = await (window as any).electronAPI.getKnowledgeData(keyword);
    if (requestId !== currentHoverRequestId || activeHoverKeyword !== keyword) {
      return;
    }

    hoverSummary.textContent = data?.summary || '暂无知识库内容';
    hoverEntries.innerHTML = '';

    const entries = data?.entries || [];
    for (const entry of entries.slice(0, 4)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hover-entry';
      button.innerHTML = `
        <span class="hover-entry-title">${entry.title}</span>
        <span class="hover-entry-meta">${entry.type} · ${entry.time}</span>
      `;
      button.addEventListener('click', () => {
        (window as any).electronAPI.openDocument(keyword, entry);
      });
      hoverEntries.appendChild(button);
    }
  } catch (error) {
    console.error('[Overlay] Failed to load hover card data', error);
    if (requestId !== currentHoverRequestId || activeHoverKeyword !== keyword) {
      return;
    }
    hoverSummary.textContent = '加载失败';
  }
}

window.addEventListener('mousemove', (event) => {
  if (activeSelectionRegion) {
    hideHoverCard();
    updateMouseRegionState(false);
    return;
  }

  const target = event.target as Node | null;
  const overMenu = !!target && selectionMenu.contains(target);
  const overCard = !!target && hoverCard.contains(target);
  const hit = findUnderlineAt(event.clientX, event.clientY);
  const overBridge = isPointInHoverBridge(event.clientX, event.clientY);

  if (overMenu || overCard) {
    updateMouseRegionState(false);
    return;
  }

  if (hit) {
    void showHoverCard(hit);
    updateMouseRegionState(true);
    return;
  }

  if (overBridge) {
    updateMouseRegionState(true);
    return;
  }

  hideHoverCard();
  updateMouseRegionState(false);
});

hoverCard.addEventListener('mouseenter', () => {
  hoverCardVisible = true;
  updateMouseRegionState(false);
});

hoverCard.addEventListener('mouseleave', () => {
  hideHoverCard();
  updateMouseRegionState(false);
});

selectionMenu.addEventListener('mouseenter', () => {
  selectionMenuVisible = true;
  updateMouseRegionState(false);
});

// Listen for IPC messages
(window as any).electronAPI.onDrawUnderlines((positions: UnderlinePosition[]) => {
  console.log('[Overlay] Received draw-underlines event');
  drawUnderlines(positions);
});

(window as any).electronAPI.onClearUnderlines(() => {
  console.log('[Overlay] Received clear-underlines event');
  clearUnderlines();
});

(window as any).electronAPI.onShowSelectionMenu((payload: { x: number; y: number; text: string; actionLabel: string }) => {
  console.log('[Overlay] Received show-selection-menu event');
  showSelectionMenu(payload);
});

(window as any).electronAPI.onHideSelectionMenu(() => {
  console.log('[Overlay] Received hide-selection-menu event');
  hideSelectionMenu();
});

(window as any).electronAPI.onShowProcessingToast((payload: { title?: string; message: string; tone?: 'processing' | 'success' | 'error' }) => {
  showProcessingToast(payload);
});

(window as any).electronAPI.onHideProcessingToast(() => {
  hideProcessingToast();
});

(window as any).electronAPI.onShowSelectionRegion((region: SelectionRegion) => {
  showSelectionRegion(region);
});

(window as any).electronAPI.onHideSelectionRegion(() => {
  hideSelectionRegion();
});

selectionAction.addEventListener('click', async () => {
  const text = selectedText.trim();

  console.log(`[Overlay] Saving selection via "${selectionActionLabel}" (${text.length} chars)`);
  selectionAction.disabled = true;
  selectionAction.textContent = '保存中...';

  try {
    await (window as any).electronAPI.saveSelectedText(text);
    console.log('[Overlay] Selected text saved successfully');
    selectionAction.textContent = '已摘抄';
    window.setTimeout(() => {
      hideSelectionMenu();
      selectionAction.disabled = false;
      selectionAction.textContent = selectionActionLabel;
    }, 600);
  } catch (error) {
    console.error('[Overlay] Failed to save selected text', error);
    selectionAction.disabled = false;
    selectionAction.textContent = `重试${selectionActionLabel}`;
  }
});

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
console.log('[Overlay] Renderer initialized, canvas size:', canvas.width, 'x', canvas.height);
