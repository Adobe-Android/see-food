import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserModel } from '../browser-client.js';

class FakeWorker {
  static latest;
  constructor(url, options) { this.url = url; this.options = options; this.listeners = {}; FakeWorker.latest = this; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  postMessage(data) { this.message = data; }
  terminate() { this.terminated = true; }
  send(data) { this.listeners.message({ data }); }
}

test('worker starts only when requested; readiness, result routing, and disposal', async () => {
  const originalWorker = globalThis.Worker;
  const secure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
  globalThis.Worker = FakeWorker;
  const updates = [];
  const model = new BrowserModel((state) => updates.push(state));
  try {
    assert.equal(model.worker, null);
    await assert.rejects(model.classify('photo', new AbortController().signal), /Load/);
    model.load();
    const worker = FakeWorker.latest;
    assert.equal(worker.message.type, 'load');
    assert.equal(worker.options.type, 'module');
    assert.equal(model.state, 'checking');
    worker.send({ type: 'progress', message: '50 MB' });
    worker.send({ type: 'ready' });
    const controller = new AbortController();
    const result = model.classify('data:image/jpeg;base64,test', controller.signal);
    assert.equal(model.state, 'busy');
    worker.send({ type: 'result', id: -1, result: { label: 'not_hotdog' } });
    assert.equal(model.state, 'busy');
    worker.send({ type: 'result', id: worker.message.id, result: { label: 'hotdog' } });
    assert.equal((await result).label, 'hotdog');
    assert.equal(model.state, 'ready');
    const pending = model.classify('photo', controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(worker.terminated, true);
    assert.equal(model.state, 'offline');
    worker.send({ type: 'ready' });
    assert.equal(model.state, 'offline');
    model.load();
    const replacement = FakeWorker.latest;
    worker.send({ type: 'progress', message: 'Stale progress' });
    worker.send({ type: 'ready' });
    worker.send({ type: 'error', message: 'Stale failure' });
    worker.listeners.error();
    assert.equal(model.worker, replacement);
    assert.equal(model.state, 'checking');
    assert.equal(replacement.terminated, undefined);
    replacement.send({ type: 'ready' });
    assert.equal(model.state, 'ready');
    assert.ok(updates.includes('ready'));
  } finally {
    model.stop();
    globalThis.Worker = originalWorker;
    delete navigator.gpu;
    if (secure) Object.defineProperty(globalThis, 'isSecureContext', secure);
    else delete globalThis.isSecureContext;
  }
});

test('unsupported context does not create worker or download model', () => {
  const model = new BrowserModel(() => {});
  model.load();
  assert.equal(model.state, 'offline');
  assert.equal(model.worker, null);
});
