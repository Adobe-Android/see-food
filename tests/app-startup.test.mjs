import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function startApp({ staticHost = false, staticBuild, checkSupport, BrowserModel, imageEnvironment = {} } = {}) {
  let source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  if (checkSupport) source = source.replace("import('./browser-core.js')", 'Promise.resolve({ checkWebGPUSupport: checkSupport })');
  if (BrowserModel) source = source.replace("import('./browser-client.js')", 'Promise.resolve(browserClientModule)');
  const backendOptions = new Set(['lmstudio', 'browser']);
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', hidden: false, disabled: false, dataset: {}, listeners: {},
      value: id === 'backend-select' ? 'lmstudio' : '',
      classList: { toggle() {}, remove() {}, add() {} },
      removeAttribute(name) { delete this[name]; },
      focus() {},
      querySelector(selector) {
        const value = selector.match(/^option\[value="(.+)"\]$/)?.[1];
        return backendOptions.has(value) ? { remove() { backendOptions.delete(value); } } : null;
      },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      append() {},
    });
    return nodes.get(id);
  };
  let resolveStatus;
  let requests = 0;
  const script = new vm.Script(source, {
    importModuleDynamically: async () => { throw new Error('404 browser-core.js'); },
  });
  const context = vm.createContext({
    document: { getElementById: node, hidden: false, addEventListener() {}, createElement: () => ({ setAttribute() {} }) },
    location: { hostname: staticHost ? 'example.github.io' : 'localhost' },
    fetch: () => { requests++; return new Promise((resolve) => { resolveStatus = resolve; }); },
    checkSupport, browserClientModule: { BrowserModel },
    AbortController, setTimeout: () => 1, clearTimeout() {},
    ...imageEnvironment,
  });
  if (staticBuild !== undefined) context.__STATIC_HOST__ = staticBuild;
  script.runInContext(context);
  await new Promise(setImmediate);
  return { node, context, requests, resolveStatus, backendOptions };
}

// An older Python process may not serve newly added browser modules.
test('missing browser modules do not prevent startup or switching away from LM Studio', async () => {
  const { node, requests, resolveStatus } = await startApp();
  assert.equal(requests, 1);
  assert.equal(node('backend-select').disabled, false);
  node('backend-select').value = 'browser';
  node('backend-select').listeners.change();
  assert.equal(node('ai-status').textContent, 'OFF AIR');
  assert.match(node('model-progress').textContent, /stop and restart/);
  assert.equal(node('load-model-button').disabled, true);
  assert.equal(node('browser-controls').hidden, false);
  resolveStatus({ ok: true, json: async () => ({ state: 'ready', message: 'Stale LM status' }) });
  await new Promise(setImmediate);
  assert.equal(node('ai-status').textContent, 'OFF AIR');
  assert.match(node('model-progress').textContent, /stop and restart/);
  assert.equal(node('model-progress').hidden, false);
  assert.equal(node('availability-message').hidden, true);
  assert.equal(node('backend-description').hidden, true);
});

test('browser panel uses one status for preflight, loading, readiness, and errors', async () => {
  const { node, context, requests } = await startApp({ staticHost: true });
  const run = (source) => vm.runInContext(source, context);
  assert.equal(requests, 0);

  run("browserSupport = 'checking'; browserMessage = ''; refreshModelStatus();");
  assert.equal(node('model-progress').textContent, 'Checking browser support…');
  assert.equal(node('load-model-button').disabled, true);

  run("browserSupport = 'supported'; refreshModelStatus();");
  assert.equal(node('model-progress').textContent, 'Loading browser model…');
  assert.equal(node('load-model-button').disabled, false);
  assert.equal(node('upload-button').disabled, true);

  for (const [state, message] of [
    ['checking', 'Downloading model: 50%'],
    ['ready', 'Browser model ready.'],
    ['busy', 'Analyzing your photo on this device…'],
    ['offline', 'Not enough GPU memory. Reload the model to retry.'],
  ]) {
    run(`browserModel = { state: ${JSON.stringify(state)}, stop() {} }; browserMessage = ${JSON.stringify(message)}; refreshModelStatus();`);
    assert.equal(node('model-progress').textContent, message);
    assert.equal(node('model-progress').hidden, false);
    assert.equal(node('availability-message').hidden, true);
    assert.equal(node('backend-description').hidden, true);
    assert.equal(node('upload-button').disabled, state !== 'ready');
    assert.equal(node('load-model-button').disabled, state !== 'offline');
    assert.equal(node('unload-model-button').hidden, state === 'offline');
  }

  run("browserSupport = 'unsupported'; browserMessage = 'WebGPU is unavailable.'; refreshModelStatus();");
  assert.equal(node('model-progress').textContent, 'WebGPU is unavailable.');
  assert.equal(node('load-model-button').disabled, true);

});

test('static hosting only offers the browser backend', async () => {
  for (const options of [{ staticHost: true }, { staticBuild: true }]) {
    const { node, context, backendOptions, requests } = await startApp(options);
    assert.deepEqual([...backendOptions], ['browser']);
    assert.equal(node('backend-select').value, 'browser');
    assert.equal(node('browser-controls').hidden, false);
    assert.equal(node('backend-description').hidden, true);
    assert.equal(requests, 0);

    node('backend-select').value = 'lmstudio';
    node('backend-select').listeners.change();
    assert.equal(vm.runInContext('backend', context), 'browser');
    assert.equal(node('backend-select').value, 'browser');
    assert.equal(node('model-progress').hidden, false);
    assert.equal(node('availability-message').hidden, true);
  }
});

test('switching backends clears the previous retry action', async () => {
  const { node } = await startApp();
  node('classify-button').textContent = 'Retry';
  node('backend-select').value = 'browser';
  node('backend-select').listeners.change();
  assert.equal(node('classify-button').textContent, 'Is it a hotdog?');
});

test('LM Studio keeps its setup guidance and availability notice', async () => {
  const { node, resolveStatus, backendOptions } = await startApp();
  assert.deepEqual([...backendOptions], ['lmstudio', 'browser']);
  assert.equal(node('backend-select').value, 'lmstudio');
  assert.equal(node('backend-description').hidden, false);
  assert.equal(node('availability-message').hidden, false);
  assert.equal(node('model-progress').hidden, true);
  resolveStatus({ ok: true, json: async () => ({ state: 'ready', message: 'Ready' }) });
  await new Promise(setImmediate);
  assert.equal(node('upload-button').disabled, false);
  assert.equal(node('availability-message').hidden, true);
});

test('browser technical notes remain available without crowding the panel', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="browser-support"/);
  assert.match(html, /<details>\s*<summary>Technical details<\/summary>/);
  assert.match(html, /<details>[\s\S]*d1-omni-600M[\s\S]*~600 MB first download[\s\S]*WebGPU with FP16[\s\S]*<\/details>/);
  assert.match(html, /id="load-model-button"[^>]*hidden disabled>Reload browser model<\/button>/);
  assert.match(html, /id="unload-model-button"[^>]*>Unload Model<\/button>/);
  assert.match(html, /Model downloads contact Hugging Face[\s\S]*jsDelivr[\s\S]*offline availability is not guaranteed/);
});

class FakeBrowserModel {
  constructor(onStatus) { this.onStatus = onStatus; this.state = 'offline'; this.loads = 0; }
  notify(state, message) { this.state = state; this.onStatus(state, message); }
  load() { this.loads++; this.notify('checking', 'Loading browser model…'); }
  stop() { this.notify('offline', 'Browser model unloaded.'); }
}

const flush = () => new Promise(setImmediate);

test('browser model loads automatically after preflight on page load and preserves status and reload controls', async () => {
  let finishSupport;
  const { node, context } = await startApp({
    staticHost: true,
    checkSupport: () => new Promise((resolve) => { finishSupport = resolve; }),
    BrowserModel: FakeBrowserModel,
  });
  assert.equal(vm.runInContext('browserModel', context), null);
  assert.equal(node('model-progress').textContent, 'Checking browser support…');
  assert.equal(node('load-model-button').hidden, true);
  finishSupport();
  await flush();
  const model = vm.runInContext('browserModel', context);
  assert.equal(model.loads, 1);
  assert.equal(node('model-progress').textContent, 'Loading browser model…');
  assert.equal(node('load-model-button').hidden, true);
  assert.equal(node('unload-model-button').hidden, false);
  model.notify('checking', 'Downloading model: 50%');
  assert.equal(node('model-progress').textContent, 'Downloading model: 50%');
  model.notify('ready', 'Browser model ready.');
  assert.equal(node('model-progress').textContent, 'Browser model ready.');
  assert.equal(node('upload-button').disabled, false);
  assert.equal(node('load-model-button').hidden, true);
  node('unload-model-button').listeners.click();
  await flush();
  assert.equal(model.loads, 1);
  assert.equal(node('model-progress').textContent, 'Browser model unloaded.');
  assert.equal(node('load-model-button').hidden, false);
  assert.equal(node('upload-button').disabled, true);
  await node('load-model-button').listeners.click();
  assert.equal(model.loads, 2);
  model.notify('offline', 'Not enough GPU memory.');
  assert.equal(node('model-progress').textContent, 'Not enough GPU memory.');
  assert.equal(node('load-model-button').hidden, false);
});

test('LM Studio does not load a browser model until switching to WebGPU', async () => {
  const { node, context } = await startApp({ checkSupport: async () => {}, BrowserModel: FakeBrowserModel });
  assert.equal(vm.runInContext('browserModel', context), null);
  node('backend-select').value = 'browser';
  node('backend-select').listeners.change();
  await flush();
  const model = vm.runInContext('browserModel', context);
  assert.equal(model.loads, 1);
  node('backend-select').value = 'lmstudio';
  node('backend-select').listeners.change();
  assert.equal(model.state, 'offline');
  node('backend-select').value = 'browser';
  node('backend-select').listeners.change();
  await flush();
  assert.equal(model.loads, 2);
});

test('switching away during preflight prevents automatic browser loading', async () => {
  let finishSupport;
  const { node, context } = await startApp({
    checkSupport: () => new Promise((resolve) => { finishSupport = resolve; }),
    BrowserModel: FakeBrowserModel,
  });
  node('backend-select').value = 'browser';
  node('backend-select').listeners.change();
  node('backend-select').value = 'lmstudio';
  node('backend-select').listeners.change();
  finishSupport();
  await flush();
  assert.equal(vm.runInContext('browserModel', context), null);
});

test('unsupported WebGPU never starts browser loading', async () => {
  const { node, context } = await startApp({
    staticHost: true,
    checkSupport: async () => { throw new Error('WebGPU is unavailable.'); },
    BrowserModel: FakeBrowserModel,
  });
  assert.equal(vm.runInContext('browserModel', context), null);
  assert.equal(node('model-progress').textContent, 'WebGPU is unavailable.');
  assert.equal(node('load-model-button').hidden, true);
});

test('photo selection retains only the resized JPEG and reuses it for classification', async () => {
  const images = [];
  const canvases = [];
  const revoked = [];
  const draws = [];
  class Photo {
    constructor() { this.naturalWidth = 4032; this.naturalHeight = 3024; images.push(this); }
    async decode() {}
    removeAttribute(name) { delete this[name]; }
  }
  const { context, node } = await startApp({ imageEnvironment: {
    Image: Photo,
    URL: { createObjectURL: () => 'blob:original', revokeObjectURL: (url) => revoked.push(url) },
  } });
  context.document.createElement = (tag) => {
    if (tag !== 'canvas') return { setAttribute() {} };
    const canvas = { width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }),
      toDataURL: (type, quality) => { assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.85); return 'data:image/jpeg;base64,resized'; },
    };
    canvases.push(canvas);
    return canvas;
  };
  vm.runInContext("renderModelStatus('ready', 'Ready');", context);
  await vm.runInContext("selectPhoto({type:'image/jpeg', size:1000, name:'camera.jpg'})", context);
  assert.equal(vm.runInContext('selectedImage', context), 'data:image/jpeg;base64,resized');
  assert.equal(node('preview').src, 'data:image/jpeg;base64,resized');
  assert.equal(images[0].src, undefined);
  assert.deepEqual(revoked, ['blob:original']);
  assert.deepEqual(draws[0].slice(1), [0, 0, 512, 384]);
  assert.equal(canvases[0].width * canvases[0].height, 0);
  let classified;
  context.classifier = { state: 'ready', classify: async (image) => { classified = image; return { label: 'hotdog' }; } };
  vm.runInContext("backend = 'browser'; browserModel = classifier;", context);
  await node('classify-button').listeners.click();
  assert.equal(classified, 'data:image/jpeg;base64,resized');
  assert.equal(canvases.length, 1, 'classification does not reencode the photo');
  node('reset-button').listeners.click();
  assert.equal(vm.runInContext('selectedImage', context), null);
  assert.equal(node('preview').src, undefined);
});

test('photo preparation releases source URLs and canvas on failure and ignores stale decodes', async () => {
  let decode;
  const revoked = [];
  const images = [];
  class Photo {
    constructor() { this.naturalWidth = 8000; this.naturalHeight = 6000; images.push(this); }
    decode() { return new Promise((resolve) => { decode = resolve; }); }
    removeAttribute(name) { delete this[name]; }
  }
  const { context, node } = await startApp({ imageEnvironment: { Image: Photo,
    URL: { createObjectURL: () => 'blob:source', revokeObjectURL: (url) => revoked.push(url) } } });
  const canvas = { width: 0, height: 0, getContext: () => null };
  context.document.createElement = (tag) => tag === 'canvas' ? canvas : { setAttribute() {} };
  vm.runInContext("renderModelStatus('ready', 'Ready');", context);
  const failed = vm.runInContext("selectPhoto({type:'image/jpeg',size:100,name:'photo'})", context);
  decode();
  await failed;
  assert.equal(canvas.width * canvas.height, 0);
  assert.match(node('error-message').textContent, /could not be prepared/);
  const stale = vm.runInContext("selectPhoto({type:'image/jpeg',size:100,name:'stale'})", context);
  vm.runInContext('++selectionVersion', context);
  decode();
  await stale;
  assert.equal(vm.runInContext('selectedImage', context), null);
  assert.deepEqual(revoked, ['blob:source', 'blob:source']);
  assert.ok(images.every((image) => image.src === undefined));
});

for (const [width, height, expected] of [
  [4032, 3024, [512, 384]],
  [3024, 4032, [384, 512]],
  [1024, 1024, [512, 512]],
  [320, 240, [320, 240]],
  [10000, 1, [512, 1]],
]) {
  test(`image preparation caps ${width}x${height} at a 512-pixel edge without upscaling`, async () => {
    const { context } = await startApp();
    let dimensions;
    const canvas = {
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toDataURL() { dimensions = [this.width, this.height]; return 'data:image/jpeg;base64,resized'; },
    };
    context.document.createElement = () => canvas;
    context.image = { naturalWidth: width, naturalHeight: height };
    vm.runInContext('prepareImage(image)', context);
    assert.deepEqual(dimensions, expected);
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  });
}
