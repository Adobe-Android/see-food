import { MODEL_ID, MODEL_REVISION, MODEL_BASE, RUNTIME_VERSION, GRAPH_FILES, checkWebGPUSupport, executionProvidersFor, encodeQuestion, decodeDecision, joinEmbeddings } from './browser-core.js';

let ort;
let processor;
let question;
let sessions = [];
let RawImage;
let loading = false;
let running = false;
const send = (type, data = {}) => self.postMessage({ type, ...data });

async function fetchFile(file) {
  const url = MODEL_BASE + file;
  let cache;
  try {
    cache = await caches.open('see-food-d1-v1');
    const hit = await cache.match(url);
    if (hit) {
      send('progress', { message: `Read ${file} from cache.` });
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch { /* Storage can be unavailable or evicted; network loading still works. */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}). Please retry.`);
  const length = Number(response.headers.get('content-length'));
  const total = Number.isSafeInteger(length) && length > 0 ? length : 0;
  const reader = response.body.getReader();
  const chunks = [];
  // Content-Length can describe compressed bytes, so retain a streaming fallback.
  let bytes = total && !response.headers.get('content-encoding') ? new Uint8Array(total) : null;
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes && loaded + value.length > bytes.length) {
        chunks.push(bytes.subarray(0, loaded));
        bytes = null;
      }
      if (bytes) bytes.set(value, loaded);
      else chunks.push(value);
      loaded += value.length;
      send('progress', { message: `${file}: ${(loaded / 1e6).toFixed(1)} MB${total ? ` / ${(total / 1e6).toFixed(1)} MB` : ''}` });
    }
  } finally { reader.releaseLock(); }
  if (bytes) bytes = bytes.subarray(0, loaded);
  else {
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    chunks.length = 0;
  }
  if (cache) {
    try { await cache.put(url, new Response(bytes)); } catch { /* Cache quota does not prevent inference. */ }
  }
  return bytes;
}

async function release() {
  for (const session of sessions) {
    try { await session.release(); } catch { /* A lost GPU may already have released resources. */ }
  }
  sessions = [];
}

async function load() {
  if (loading || running) return;
  if (sessions.length === 3) { send('ready'); return; }
  loading = true;
  try {
    await checkWebGPUSupport();
    send('progress', { message: 'Loading the browser runtime…' });
    const transformers = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js');
    ort = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort.webgpu.min.mjs');
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${RUNTIME_VERSION}/dist/`;
    ort.env.wasm.numThreads = 1;
    RawImage = transformers.RawImage;
    const options = { revision: MODEL_REVISION, progress_callback: (info) => {
      if (info.status === 'progress') send('progress', { message: `Tokenizer / processor: ${Math.round(info.progress || 0)}%` });
    } };
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID, options);
    processor = await transformers.AutoImageProcessor.from_pretrained(MODEL_ID, options);
    question = encodeQuestion(tokenizer);
    for (const graph of GRAPH_FILES) {
      const file = `onnx/${graph}.onnx`;
      const model = await fetchFile(file);
      const weights = await fetchFile(`${file}_data`);
      send('progress', { message: `Preparing ${graph} on WebGPU…` });
      sessions.push(await ort.InferenceSession.create(model, {
        executionProviders: executionProvidersFor(graph),
        externalData: [{ path: `${graph}.onnx_data`, data: weights }],
      }));
    }
    send('ready');
  } catch (error) {
    await release();
    send('error', { phase: 'load', message: error.message || 'Could not load the browser model.' });
  } finally { loading = false; }
}

const int64 = (values, dims) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);

function disposeTensors(tensors) {
  for (const tensor of new Set(tensors)) tensor.dispose();
}

async function visionEmbeddings(image) {
  const inputs = await processor(await RawImage.read(image));
  const feeds = {};
  try {
    for (const key of ['pixel_values', 'pixel_attention_mask', 'spatial_shapes']) {
      const input = inputs[key];
      feeds[key] = new ort.Tensor(input.type, input.data, input.dims);
    }
    return await sessions[1].run(feeds);
  } finally { disposeTensors(Object.values(feeds)); }
}

async function imageQuestionEmbeddings(image) {
  const vision = await visionEmbeddings(image);
  let ids;
  let text;
  try {
    ids = int64(question.ids, [1, question.ids.length]);
    text = await sessions[0].run({ input_ids: ids });
    return joinEmbeddings(Object.values(vision)[0], Object.values(text)[0]);
  } finally {
    disposeTensors([...Object.values(vision), ...Object.values(text || {}), ...(ids ? [ids] : [])]);
  }
}

async function classify(image, id) {
  if (loading || running || sessions.length !== 3) {
    send('error', { id, phase: 'classify', message: 'The browser model is not ready.' });
    return;
  }
  running = true;
  const tensors = [];
  try {
    const joined = await imageQuestionEmbeddings(image);
    image = null;
    const feeds = {
      inputs_embeds: new ort.Tensor('float32', joined.data, [1, joined.length, 1024]),
      attention_mask: int64(Array(joined.length).fill(1), [1, joined.length]),
      prefix_len: int64([joined.prefixLength], [1]),
      marker_pos: int64(question.markers, [1, 2]),
      marker_mask: int64([1, 1], [1, 2]),
      qtype: int64([0], [1]),
    };
    tensors.push(...Object.values(feeds));
    const output = await sessions[2].run(feeds);
    tensors.push(...Object.values(output));
    const result = decodeDecision(output.logits.data);
    disposeTensors(tensors);
    tensors.length = 0;
    send('result', { id, result });
  } catch (error) {
    await release();
    send('error', { id, phase: 'classify', message: `Browser inference failed. Reload the model and retry. ${error.message || ''}` });
  } finally {
    for (const tensor of tensors) tensor.dispose();
    running = false;
  }
}

self.addEventListener('message', ({ data }) => {
  if (data.type === 'load') load();
  else if (data.type === 'classify') classify(data.image, data.id);
});
