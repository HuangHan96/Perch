interface UnderlinePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElectronAPI {
  onDrawUnderlines: (callback: (positions: UnderlinePosition[]) => void) => void;
  onClearUnderlines: (callback: () => void) => void;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// Set canvas size to match screen
canvas.width = window.screen.width * window.devicePixelRatio;
canvas.height = window.screen.height * window.devicePixelRatio;
canvas.style.width = `${window.screen.width}px`;
canvas.style.height = `${window.screen.height}px`;

// Scale context for retina displays
ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

function drawUnderlines(positions: UnderlinePosition[]) {
  console.log(`[Overlay] Drawing ${positions.length} underlines`);

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw underlines
  ctx.strokeStyle = '#FF6B6B';
  ctx.lineWidth = 2;

  for (const pos of positions) {
    console.log(`[Overlay] Drawing at x=${pos.x}, y=${pos.y}, w=${pos.width}, h=${pos.height}`);
    const underlineY = pos.y + pos.height + 2;
    ctx.beginPath();
    ctx.moveTo(pos.x, underlineY);
    ctx.lineTo(pos.x + pos.width, underlineY);
    ctx.stroke();
  }

  console.log('[Overlay] Drawing complete');
}

function clearUnderlines() {
  console.log('[Overlay] Clearing underlines');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// Listen for IPC messages
(window as any).electronAPI.onDrawUnderlines((positions: UnderlinePosition[]) => {
  console.log('[Overlay] Received draw-underlines event');
  drawUnderlines(positions);
});

(window as any).electronAPI.onClearUnderlines(() => {
  console.log('[Overlay] Received clear-underlines event');
  clearUnderlines();
});

console.log('[Overlay] Renderer initialized, canvas size:', canvas.width, 'x', canvas.height);

export {};
