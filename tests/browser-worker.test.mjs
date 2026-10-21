import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../browser-core.js';

const source = (await readFile(new URL('../browser-worker.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/, '');
function workerContext(extra = {}) {
  const messages = [];
  const context = vm.createContext({ ...core, Uint8Array, Float32Array, BigInt64Array, Response,
    self: { postMessage: (message) => messages.push(message), addEventListener() {} }, ...extra });
  vm.runInContext(source, context);
  return { context, messages };
}

for (const [name, length, encoding] of [
  ['known length', '6', null], ['unknown length', null, null],
  ['underreported length', '2', null], ['overreported length', '9', null],
  ['compressed response', '2', 'gzip'],
]) {
  test(`model download preserves bytes and caching: ${name}`, async () => {
    let cached;
    let unlocked = false;
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])];
    const { context, messages } = workerContext({
      caches: { open: async () => ({ match: async () => null, put: async (_, response) => { cached = new Uint8Array(await response.arrayBuffer()); } }) },
      fetch: async () => ({ ok: true, headers: { get: (key) => key === 'content-length' ? length : encoding },
        body: { getReader: () => ({ read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true }, releaseLock() { unlocked = true; } }) } }),
    });
    const bytes = await vm.runInContext("fetchFile('weights')", context);
    assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...cached], [...bytes]);
    assert.equal(unlocked, true);
    assert.equal(messages.length, 2);
  });
}

test('cache hits avoid network and unavailable storage still permits downloads', async () => {
  const { context } = workerContext({ caches: { open: async () => ({ match: async () => new Response(new Uint8Array([7])) }) },
    fetch: () => { throw new Error('Unexpected network'); } });
  assert.deepEqual([...await vm.runInContext("fetchFile('weights')", context)], [7]);
  const fallback = workerContext({ caches: { open: async () => { throw new Error('Unavailable'); } },
    fetch: async () => new Response(new Uint8Array([8, 9])) });
  assert.deepEqual([...await vm.runInContext("fetchFile('weights')", fallback.context)], [8, 9]);
});

for (const failure of [null, 'vision', 'text', 'decision']) {
  test(`inference releases resources at stage boundaries: ${failure || 'success'}`, async () => {
    const live = new Set();
    let earlyReleasedBytes = 0;
    class Tensor {
      constructor(type, data, dims) { Object.assign(this, { type, data, dims }); live.add(this); }
      dispose() { assert.ok(live.delete(this), 'tensor disposed exactly once'); }
    }
    const output = () => ({ embeddings: new Tensor('float32', new Float32Array(2048), [1, 2, 1024]) });
    const run = async (stage) => {
      if (stage === failure) throw new Error(`Failed ${stage}`);
      return output();
    };
    const { context, messages } = workerContext({ Tensor,
      processorMock: async () => ({ pixel_values: { type: 'float32', data: new Float32Array(10000), dims: [1, 10000] },
        pixel_attention_mask: { type: 'int64', data: new BigInt64Array(10), dims: [1, 10] },
        spatial_shapes: { type: 'int64', data: new BigInt64Array(2), dims: [1, 2] } }),
      RawImageMock: { read: async () => ({}) },
      fakeSessions: [
        { run: async () => { assert.equal(live.size, 2, 'only vision output and token IDs survive to text stage'); return run('text'); }, release() {} },
        { run: async () => { earlyReleasedBytes = [...live].reduce((sum, tensor) => sum + tensor.data.byteLength, 0); return run('vision'); }, release() {} },
        { run: async () => {
          assert.equal(live.size, 6, 'only decision feeds survive to decision stage');
          if (failure === 'decision') throw new Error('Failed decision');
          return { logits: new Tensor('float32', new Float32Array([2, 1]), [1, 2]) };
        }, release() {} },
      ],
    });
    vm.runInContext('ort = { Tensor }; processor = processorMock; RawImage = RawImageMock; sessions = fakeSessions; question = {ids:[1,2], markers:[0,1]};', context);
    await vm.runInContext("classify('photo', 1)", context);
    assert.equal(live.size, 0);
    assert.equal(messages.at(-1).type, failure ? 'error' : 'result');
    assert.equal(vm.runInContext('running', context), false);
    assert.equal(earlyReleasedBytes, 40096);
  });
}
