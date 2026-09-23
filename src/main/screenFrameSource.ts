import { desktopCapturer, ipcMain, screen, session, WebContents } from 'electron';
import type { CapturedFrame } from './screenCapture';

const FRAME_REQUEST_TIMEOUT_MS = 1500;

/**
 * Supplies screen frames to the capture pipeline.
 *
 * The primary path keeps a live display stream running in the overlay renderer, where grabbing
 * a frame costs ~20ms. desktopCapturer.getSources() costs ~300ms per call because it starts a
 * fresh capture session every time, so it is only used as a fallback for when the stream is not
 * available (permission revoked, renderer gone, still starting up).
 */
export class ScreenFrameSource {
  private renderer: WebContents | null = null;
  private pendingRequests = new Map<number, (frame: CapturedFrame | null) => void>();
  private nextRequestId: number = 1;
  private streamStatus: 'starting' | 'ready' | 'failed' = 'starting';

  registerIpcHandlers() {
    ipcMain.on(
      'screen-frame-result',
      (_event, requestId: number, buffer: ArrayBuffer | null, width: number, height: number, pixelFormat: string) => {
        const resolve = this.pendingRequests.get(requestId);
        if (!resolve) return;
        this.pendingRequests.delete(requestId);

        if (!buffer || !width || !height) {
          resolve(null);
          return;
        }

        resolve({
          bitmap: Buffer.from(buffer),
          width,
          height,
          pixelFormat: pixelFormat === 'rgba' ? 'rgba' : 'bgra'
        });
      }
    );

    ipcMain.on('screen-stream-status', (_event, status: string, detail?: string) => {
      this.streamStatus = status === 'ready' ? 'ready' : 'failed';
      console.log(`✓ Screen stream ${this.streamStatus}${detail ? ` (${detail})` : ''}`);
    });
  }

  /** Lets the overlay renderer hand out frames of its display stream. */
  setUpDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0] });
      } catch (error) {
        console.warn('⚠ Could not provide a display media source:', error);
        callback({});
      }
    }, { useSystemPicker: false });
  }

  attachRenderer(renderer: WebContents | null) {
    this.renderer = renderer;
  }

  isLowLatency(): boolean {
    return this.streamStatus === 'ready';
  }

  async grabFrame(): Promise<CapturedFrame | null> {
    const streamed = await this.grabStreamedFrame();
    if (streamed) {
      return streamed;
    }
    return this.grabFrameWithDesktopCapturer();
  }

  private grabStreamedFrame(): Promise<CapturedFrame | null> {
    const renderer = this.renderer;
    if (this.streamStatus !== 'ready' || !renderer || renderer.isDestroyed()) {
      return Promise.resolve(null);
    }

    const requestId = this.nextRequestId++;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(null);
      }, FRAME_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });

      renderer.send('capture-screen-frame', requestId);
    });
  }

  /** Fallback: asks macOS for a fresh capture of the primary display. */
  private async grabFrameWithDesktopCapturer(): Promise<CapturedFrame | null> {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      return null;
    }

    const thumbnail = sources[0].thumbnail;
    const size = thumbnail.getSize();
    if (size.width === 0 || size.height === 0) {
      return null;
    }

    return { bitmap: thumbnail.toBitmap(), width: size.width, height: size.height, pixelFormat: 'bgra' };
  }
}
