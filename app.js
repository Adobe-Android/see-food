'use strict';

const byId = (id) => document.getElementById(id);
const fileInput = byId('file-input');
const cameraInput = byId('camera-input');
const preview = byId('preview');
const dropZone = byId('drop-zone');
const classifyButton = byId('classify-button');
const maxFileSize = 15 * 1024 * 1024;
let photoUrl = null;
let selectedImage = null;
let selectionVersion = 0;
let activeRequest = null;
let busy = false;
let statusRequest = null;
let statusTimer = null;
let modelState = 'checking';

function syncAvailability() {
  const available = modelState === 'ready' && !busy;
  for (const id of ['upload-button', 'camera-button', 'replace-button', 'file-input', 'camera-input']) {
    byId(id).disabled = !available;
  }
  classifyButton.disabled = !available || !selectedImage;
  dropZone.classList.toggle('unavailable', !available);
  if (!available) dropZone.classList.remove('dragging');
  const notice = byId('availability-message');
  notice.hidden = available || busy;
  const messages = {
    checking: 'Checking Local AI before you add a photo…',
    offline: 'Local AI is off air. Start LM Studio and load the vision model to add or analyze a photo. We’ll reconnect automatically.',
    busy: 'Local AI is analyzing another photo. Please wait before adding yours.',
  };
  notice.textContent = messages[modelState] || '';
}

function renderModelStatus(state, message) {
  modelState = state;
  const sign = byId('ai-sign');
  sign.dataset.state = state;
  sign.title = message;
  const labels = { checking: 'CHECKING', ready: 'ON AIR · READY', busy: 'ANALYZING', offline: 'OFF AIR' };
  const label = labels[state];
  if (byId('ai-status').textContent !== label) byId('ai-status').textContent = label;
  syncAvailability();
}

async function refreshModelStatus() {
  clearTimeout(statusTimer);
  if (document.hidden || statusRequest) return;
  const controller = new AbortController();
  statusRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('/api/status', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Status unavailable');
    const result = await response.json();
    if (!['ready', 'busy', 'offline'].includes(result.state) || typeof result.message !== 'string') throw new Error('Invalid status');
    renderModelStatus(busy && result.state === 'ready' ? 'busy' : result.state, result.message);
  } catch {
    renderModelStatus('offline', 'Cannot verify the model. Check the app server and LM Studio.');
  } finally {
    clearTimeout(timeout);
    statusRequest = null;
    if (!document.hidden) statusTimer = setTimeout(refreshModelStatus, 10000);
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(statusTimer);
  if (document.hidden) {
    renderModelStatus('checking', 'Model status will refresh when you return.');
    if (statusRequest) statusRequest.abort();
  } else {
    refreshModelStatus();
  }
});
syncAvailability();
refreshModelStatus();

function announce(message) {
  byId('status-message').textContent = message;
}

function showState(state) {
  for (const name of ['ready', 'loading', 'result']) {
    byId(`${name}-state`).hidden = name !== state;
  }
  classifyButton.hidden = state === 'result';
  byId('reset-button').hidden = state !== 'result';
}

function updateReadyCopy() {
  byId('ready-title').textContent = selectedImage ? 'Photo ready. Let’s settle this.' : 'Add a photo to get started.';
  byId('ready-description').textContent = selectedImage ? 'Hit the button. We’ll take a closer look.' : 'One photo. One very important answer.';
}

function setClassifyLabel(label, arrow = true) {
  classifyButton.textContent = label;
  if (arrow) {
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '↗';
    classifyButton.append(icon);
  }
}

function cancelVerdict() {
  if (activeRequest) activeRequest.abort();
  activeRequest = null;
  busy = false;
  dropZone.classList.remove('scanning');
  setClassifyLabel('Is it a hotdog?');
}

function showError(message) {
  byId('error-message').textContent = message;
  byId('error-message').hidden = false;
}

async function selectPhoto(file) {
  if (!file || modelState !== 'ready' || busy) return;
  const version = ++selectionVersion;
  byId('error-message').hidden = true;
  if (!file.type.startsWith('image/')) {
    showError('Please choose an image file, such as a JPG, PNG, or WEBP.');
    return;
  }
  if (file.size > maxFileSize) {
    showError('That photo is a little too big. Please choose an image under 15 MB.');
    return;
  }

  const nextUrl = URL.createObjectURL(file);
  const candidate = new Image();
  candidate.src = nextUrl;
  try {
    await candidate.decode();
  } catch {
    URL.revokeObjectURL(nextUrl);
    if (version === selectionVersion) {
      showError('This image could not be opened. Try a JPG, PNG, or WEBP instead.');
    }
    return;
  }
  if (version !== selectionVersion || modelState !== 'ready' || busy) {
    URL.revokeObjectURL(nextUrl);
    return;
  }

  cancelVerdict();
  const previousUrl = photoUrl;
  photoUrl = nextUrl;
  selectedImage = candidate;
  updateReadyCopy();
  preview.src = photoUrl;
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  byId('file-name').textContent = file.name;
  byId('empty-state').hidden = true;
  byId('preview-state').hidden = false;
  syncAvailability();
  showState('ready');
  announce('Photo ready. Select "Is it a hotdog?" to ask your local model.');
}

byId('upload-button').addEventListener('click', () => fileInput.click());
byId('replace-button').addEventListener('click', () => fileInput.click());
byId('camera-button').addEventListener('click', () => cameraInput.click());
for (const input of [fileInput, cameraInput]) {
  input.addEventListener('change', () => {
    selectPhoto(input.files[0]);
    input.value = '';
  });
}

let dragDepth = 0;
dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (modelState !== 'ready' || busy) return;
  dragDepth += 1;
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragover', (event) => event.preventDefault());
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropZone.classList.remove('dragging');
});
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('dragging');
  if (modelState !== 'ready' || busy) return;
  const files = event.dataTransfer.files;
  if (files.length > 1) {
    showError('One at a time. Please drop just one photo.');
    return;
  }
  selectPhoto(files[0]);
});

function prepareImage(image) {
  const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the photo.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

classifyButton.addEventListener('click', async () => {
  if (!selectedImage || busy || modelState !== 'ready') return;
  if (location.protocol === 'file:') {
    showError('Start the Python server and open http://localhost:8000 to use the local model.');
    return;
  }
  busy = true;
  if (modelState === 'ready') renderModelStatus('busy', 'Local model is analyzing your photo.');
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 130000);
  classifyButton.disabled = true;
  setClassifyLabel('Considering the evidence…', false);
  byId('error-message').hidden = true;
  dropZone.classList.add('scanning');
  showState('loading');
  announce('Your local model is analyzing the photo.');
  try {
    const response = await fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: prepareImage(selectedImage) }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (activeRequest !== controller) return;
    if (!response.ok) throw new Error(result.error || 'Classification failed. Please retry.');
    if (!['hotdog', 'not_hotdog'].includes(result.label)) throw new Error('The model returned an invalid verdict.');
    const isHotdog = result.label === 'hotdog';
    byId('result-state').classList.toggle('not-hotdog', !isHotdog);
    byId('result-icon').classList.toggle('not-hotdog-mark', !isHotdog);
    byId('result-title').textContent = isHotdog ? 'Hotdog.' : 'Not hotdog.';
    byId('result-description').textContent = isHotdog ? 'A bun-believable discovery.' : 'A lot of things are not hotdogs. This is one.';
    showState('result');
    byId('result-title').focus({ preventScroll: true });
    announce(`Model result: ${isHotdog ? 'Hotdog' : 'Not hotdog'}. AI predictions can be wrong.`);
  } catch (error) {
    if (activeRequest !== controller) return;
    showState('ready');
    byId('ready-title').textContent = 'The verdict will have to wait.';
    byId('ready-description').textContent = 'Something interrupted the analysis. Give it another try.';
    showError(error.name === 'AbortError' ? 'The request timed out. Check LM Studio and try again.' : error.message === 'Failed to fetch' ? 'Cannot reach the app server. Make sure the Python server is running.' : error.message);
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      activeRequest = null;
      busy = false;
      dropZone.classList.remove('scanning');
      setClassifyLabel(byId('error-message').hidden ? 'Is it a hotdog?' : 'Retry');
      renderModelStatus('checking', 'Refreshing model readiness after analysis.');
      refreshModelStatus();
    }
  }
});

byId('reset-button').addEventListener('click', () => {
  ++selectionVersion;
  cancelVerdict();
  preview.removeAttribute('src');
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  selectedImage = null;
  updateReadyCopy();
  byId('file-name').textContent = '';
  byId('empty-state').hidden = false;
  byId('preview-state').hidden = true;
  byId('error-message').hidden = true;
  syncAvailability();
  showState('ready');
  announce('Ready for another photo.');
  if (!byId('upload-button').disabled) byId('upload-button').focus();
});
