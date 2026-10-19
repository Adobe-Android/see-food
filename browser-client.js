export class BrowserModel {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.worker = null;
    this.state = 'offline';
    this.pending = null;
    this.sequence = 0;
    this.timer = null;
  }

  notify(state, message) {
    this.state = state;
    this.onStatus(state, message);
  }

  stop(message = 'Browser model unloaded.') {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    if (this.pending) {
      const { reject, cleanup } = this.pending;
      this.pending = null;
      cleanup();
      reject(new Error(message));
    }
    this.notify('offline', message);
  }

  load() {
    if (this.state === 'checking' || this.state === 'ready' || this.state === 'busy') return;
    if (!globalThis.isSecureContext || !navigator.gpu) {
      this.notify('offline', 'WebGPU is unavailable. Use a supported browser over HTTPS or localhost.');
      return;
    }
    this.stop();
    this.notify('checking', 'Loading browser model…');
    try {
      const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.addEventListener('message', ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'progress') {
          this.notify('checking', data.message);
          return;
        }
        if (data.type === 'ready') {
          clearTimeout(this.timer);
          this.notify('ready', 'Browser model ready.');
          return;
        }
        if (data.type === 'error') {
          this.stop(data.message);
          return;
        }
        if (data.type === 'result' && this.pending?.id === data.id) {
          const { resolve, cleanup } = this.pending;
          this.pending = null;
          clearTimeout(this.timer);
          cleanup();
          this.notify('ready', 'Browser model ready.');
          resolve(data.result);
        }
      });
      worker.addEventListener('error', () => {
        if (this.worker === worker) this.stop('The browser model worker failed. Check network access and WebGPU support, then reload the model.');
      });
      this.timer = setTimeout(() => this.stop('Model loading timed out after 15 minutes. Check your connection and retry.'), 15 * 60 * 1000);
      this.worker.postMessage({ type: 'load' });
    } catch (error) { this.stop(error.message); }
  }

  classify(image, signal) {
    if (this.state !== 'ready' || this.pending) return Promise.reject(new Error('Load the browser model before analyzing a photo.'));
    return new Promise((resolve, reject) => {
      const abort = () => this.stop('Browser analysis was cancelled or timed out. Reload the model to retry.');
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      const id = ++this.sequence;
      const cleanup = () => signal.removeEventListener('abort', abort);
      this.pending = { id, resolve, reject, cleanup };
      signal.addEventListener('abort', abort, { once: true });
      this.notify('busy', 'Analyzing your photo on this device…');
      this.timer = setTimeout(abort, 130000);
      try { this.worker.postMessage({ type: 'classify', image, id }); }
      catch (error) { this.stop(error.message); }
    });
  }
}
