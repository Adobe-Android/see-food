import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQuestion, decodeDecision, joinEmbeddings, checkWebGPUSupport, executionProvidersFor, MODEL_BASE, GRAPH_FILES } from '../browser-core.js';

function tokenizer() {
  const special = new Map(['<|reserved_7|>', '<|reserved_8|>', '<|reserved_9|>', '<|reserved_10|>', '<|reserved_11|>', '<|mask|>'].map((value, index) => [value, index + 10]));
  return { bos_token_id: 1, convert_tokens_to_ids: (value) => special.get(value), encode: (text) => Array.from(text, (char) => char.charCodeAt(0) + 100) };
}

test('image choice encoding keeps both markers relative to text and preserves model order', () => {
  const { ids, markers } = encodeQuestion(tokenizer());
  assert.equal(ids[0], 1);
  assert.equal(ids[1], 10);
  assert.equal(markers.length, 2);
  for (const marker of markers) { assert.equal(ids[marker], 15); assert.equal(ids[marker - 1], 12); }
  assert.equal(ids.at(-1), 14);
  assert.ok(ids.length <= 896);
  assert.ok(markers[1] > markers[0]);
});

test('missing special tokens fail rather than silently running a different prompt', () => {
  const tok = tokenizer();
  tok.convert_tokens_to_ids = () => undefined;
  assert.throws(() => encodeQuestion(tok), /missing/);
});

test('stable softmax returns strict positive and negative decisions, without text temperature', () => {
  assert.deepEqual(decodeDecision([10000, -10000]).label, 'hotdog');
  assert.equal(decodeDecision([-10000, 10000]).label, 'not_hotdog');
  assert.equal(decodeDecision([0, 0]).probability, 0.5);
  assert.ok(Math.abs(decodeDecision([2, 0]).probability - 0.8807970779778823) < 1e-10);
  for (const values of [[], [1], [NaN, 1], [Infinity, 0], [1, 2, 3]]) assert.throws(() => decodeDecision(values), /invalid verdict/);
});

test('vision prefix precedes text embeddings and is counted in tokens not floats', () => {
  const vision = { type: 'float32', data: new Float32Array(2048).fill(3), dims: [2, 1024] };
  const text = { type: 'float32', data: new Float32Array(3072).fill(4), dims: [1, 3, 1024] };
  const result = joinEmbeddings(vision, text);
  assert.equal(result.prefixLength, 2);
  assert.equal(result.length, 5);
  assert.equal(result.data[2047], 3);
  assert.equal(result.data[2048], 4);
  assert.throws(() => joinEmbeddings({ ...vision, type: 'float16' }, text), /dimensions/);
});

test('WebGPU preflight distinguishes insecure context, missing API, adapter, FP16, and device failure', async () => {
  await assert.rejects(checkWebGPUSupport({ isSecureContext: false }), /HTTPS/);
  await assert.rejects(checkWebGPUSupport({ isSecureContext: true, navigator: {} }), /not available/);
  const context = (requestAdapter) => ({ isSecureContext: true, navigator: { gpu: { requestAdapter } } });
  await assert.rejects(checkWebGPUSupport(context(async () => null)), /No WebGPU adapter/);
  await assert.rejects(checkWebGPUSupport(context(async () => { throw new Error(); })), /could not access/);
  await assert.rejects(checkWebGPUSupport(context(async () => ({ features: new Set() }))), /shader-f16/);
  await assert.rejects(checkWebGPUSupport(context(async () => ({ features: new Set(['shader-f16']), requestDevice: async () => { throw new Error(); } }))), /could not create/);
  let destroyed = false;
  await checkWebGPUSupport(context(async () => ({
    features: new Set(['shader-f16']),
    requestDevice: async (options) => {
      assert.deepEqual(options, { requiredFeatures: ['shader-f16'] });
      return { destroy() { destroyed = true; } };
    },
  })));
  assert.equal(destroyed, true);
});

test('only vision positional Clip nodes bypass the deferred GPU pipeline cache', () => {
  assert.deepEqual(executionProvidersFor('vision_encoder_fp16'), [{ name: 'webgpu', forceCpuNodeNames: [
    '/model/embeddings/pos_embed/clip_ys',
    '/model/embeddings/pos_embed/clip_xs',
    '/model/embeddings/pos_embed/clamp_weights',
  ] }]);
  for (const graph of ['embed_tokens_quantized', 'decision_quantized']) {
    assert.deepEqual(executionProvidersFor(graph), ['webgpu']);
  }
});

test('model assets use a pinned revision and only the image graphs', () => {
  assert.match(MODEL_BASE, /resolve\/[a-f0-9]{40}\/$/);
  assert.deepEqual(GRAPH_FILES, ['embed_tokens_quantized', 'vision_encoder_fp16', 'decision_quantized']);
});
