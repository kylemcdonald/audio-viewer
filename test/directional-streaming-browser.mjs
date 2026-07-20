import assert from 'node:assert/strict';

const webdriver = 'http://127.0.0.1:4444';

async function command(path, method = 'GET', body) {
  const response = await fetch(`${webdriver}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value));
  return result.value;
}

const session = await command('/session', 'POST', {
  capabilities: {
    alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless', '--width=1440', '--height=900'] },
    },
  },
});
const endpoint = `/session/${session.sessionId}`;

async function execute(script) {
  return command(`${endpoint}/execute/sync`, 'POST', { script, args: [] });
}

async function waitFor(script, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await execute(script);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${script}`);
}

try {
  await command(`${endpoint}/url`, 'POST', { url: 'http://vibecheck.local:5173/' });
  await waitFor("return document.readyState === 'complete'");
  await execute(`
    const mixMode = document.querySelector('#mono-mix-select');
    mixMode.value = 'directional';
    mixMode.dispatchEvent(new Event('change', { bubbles: true }));
    const format = document.querySelector('#ambisonic-format-select');
    format.value = 'a-format';
    format.dispatchEvent(new Event('change', { bubbles: true }));

    const spectralCanvas = document.querySelector('#spectral-canvas');
    window.__directionalSpectralHistory = [];
    const recordSpectralState = () => {
      const state = {
        generation: Number(spectralCanvas.dataset.directionalGeneration || -1),
        columns: Number(spectralCanvas.dataset.timeColumns || 0),
        secondsPerColumn: Number(spectralCanvas.dataset.secondsPerColumn || 0),
        coverageEnd: Number(spectralCanvas.dataset.coverageEnd || 0),
      };
      const previous = window.__directionalSpectralHistory.at(-1);
      if (
        state.generation >= 0 && state.columns > 0 && state.secondsPerColumn > 0 &&
        (!previous || previous.generation !== state.generation ||
          previous.columns !== state.columns || previous.coverageEnd !== state.coverageEnd)
      ) window.__directionalSpectralHistory.push(state);
    };
    new MutationObserver(recordSpectralState).observe(spectralCanvas, {
      attributes: true,
      attributeFilter: [
        'data-directional-generation', 'data-time-columns',
        'data-seconds-per-column', 'data-coverage-end'
      ],
    });
    window.__directionalStableHashes = [];
    const stableProbe = document.createElement('canvas');
    stableProbe.width = 24;
    stableProbe.height = 96;
    let monitoredCoverage = -1;
    let settledFrames = 0;
    const monitorStableLeftEdge = () => {
      const coverage = Number(spectralCanvas.dataset.coverageEnd || 0);
      const step = Number(spectralCanvas.dataset.secondsPerColumn || 0);
      if (coverage !== monitoredCoverage) {
        monitoredCoverage = coverage;
        settledFrames = 0;
      } else {
        settledFrames += 1;
      }
      if (settledFrames === 2 && coverage >= 30 && step > 0 && step <= 0.1280001) {
        const context = stableProbe.getContext('2d');
        const bounds = spectralCanvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        context.drawImage(
          spectralCanvas,
          0, 25 * dpr, 24 * dpr, Math.max(1, spectralCanvas.height - 25 * dpr),
          0, 0, stableProbe.width, stableProbe.height,
        );
        const values = context.getImageData(0, 0, stableProbe.width, stableProbe.height).data;
        let hash = 2166136261;
        for (let index = 0; index < values.length; index += 4) {
          hash = Math.imul(hash ^ values[index], 16777619);
          hash = Math.imul(hash ^ values[index + 1], 16777619);
          hash = Math.imul(hash ^ values[index + 2], 16777619);
        }
        window.__directionalStableHashes.push({ coverage, hash: hash >>> 0, width: bounds.width });
      }
      requestAnimationFrame(monitorStableLeftEdge);
    };
    requestAnimationFrame(monitorStableLeftEdge);

    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function delayedArrayBuffer() {
      const blob = this;
      return new Promise((resolve) => setTimeout(resolve, 250))
        .then(() => originalArrayBuffer.call(blob));
    };

    const sampleRate = 8000;
    const seconds = 300;
    const channels = 4;
    const frames = sampleRate * seconds;
    const dataBytes = frames * channels * 4;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const text = (offset, value) => [...value].forEach((character, index) =>
      view.setUint8(offset + index, character.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 4, true);
    view.setUint16(32, channels * 4, true);
    view.setUint16(34, 32, true);
    text(36, 'data');
    view.setUint32(40, dataBytes, true);

    // Build one reusable 2 MiB block. Blob concatenation retains the shared
    // backing store, so this represents a long file without a huge test heap.
    const blockFrames = 131072;
    const block = new ArrayBuffer(blockFrames * channels * 4);
    const blockView = new DataView(block);
    for (let frame = 0; frame < blockFrames; frame += 1) {
      const phase = frame / sampleRate;
      for (let channel = 0; channel < channels; channel += 1) {
        const carrier = Math.sin(2 * Math.PI * (90 + channel * 73) * phase);
        const envelope = 0.2 + 0.8 * ((frame >>> 13) % 5) / 4;
        blockView.setFloat32((frame * channels + channel) * 4, carrier * envelope * 0.5, true);
      }
    }
    const blockBlob = new Blob([block]);
    const parts = [header];
    let remaining = dataBytes;
    while (remaining > 0) {
      const size = Math.min(remaining, blockBlob.size);
      parts.push(size === blockBlob.size ? blockBlob : blockBlob.slice(0, size));
      remaining -= size;
    }
    const file = new File(parts, 'five-minute-tetra-a-format.wav', { type: 'audio/wav' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    window.dispatchEvent(event);
  `);

  await waitFor("return document.querySelector('#file-name')?.textContent === 'five-minute-tetra-a-format.wav'");
  let loadingPreview = null;
  const previewStarted = Date.now();
  while (Date.now() - previewStarted < 20_000) {
    const state = await execute(`
      const canvas = document.querySelector('#spectral-canvas');
      const fileState = document.querySelector('#file-size')?.textContent || '';
      return {
        loading: fileState.includes('%') || fileState.includes('Parsing'),
        fileState,
        columns: Number(canvas.dataset.timeColumns || 0),
        coverageEnd: Number(canvas.dataset.coverageEnd || 0),
        generation: Number(canvas.dataset.directionalGeneration || -1),
      };
    `);
    if (state.loading && state.columns > 0 && state.coverageEnd > 0) {
      loadingPreview = state;
      break;
    }
    if (!state.loading) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(loadingPreview, 'Expected a partial spectrogram before WAV loading completed');
  assert.ok(loadingPreview.coverageEnd < 300, JSON.stringify(loadingPreview));

  await waitFor(`
    const text = document.querySelector('#file-size')?.textContent || '';
    return !text.includes('%') && !text.includes('Parsing');
  `, 30_000);
  try {
    await waitFor("return document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready')", 30_000);
  } catch (error) {
    const diagnostic = await execute(`
      const canvas = document.querySelector('#spectral-canvas');
      return {
        status: document.querySelector('#mono-mix-status')?.value,
        columns: canvas.dataset.timeColumns,
        generation: canvas.dataset.directionalGeneration,
        tier: canvas.dataset.directionalTier,
        computed: canvas.dataset.generationComputedFrames,
        reused: canvas.dataset.generationReusedFrames,
        cached: canvas.dataset.cachedFrames,
      };
    `);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
  const finalState = await execute(`
    const canvas = document.querySelector('#spectral-canvas');
    return {
      columns: Number(canvas.dataset.timeColumns || 0),
      plotPixels: Math.round(
        Math.max(1, canvas.getBoundingClientRect().width - 38) * (window.devicePixelRatio || 1)
      ),
      generationComputedFrames: Number(canvas.dataset.generationComputedFrames || 0),
      generationReusedFrames: Number(canvas.dataset.generationReusedFrames || 0),
      cachedFrames: Number(canvas.dataset.cachedFrames || 0),
      coverageEnd: Number(canvas.dataset.coverageEnd || 0),
      history: window.__directionalSpectralHistory,
      stableHashes: window.__directionalStableHashes,
    };
  `);
  assert.ok(finalState.columns >= finalState.plotPixels * 0.95, JSON.stringify(finalState));
  assert.ok(finalState.generationReusedFrames > 0, JSON.stringify(finalState));
  assert.ok(finalState.coverageEnd >= 299, JSON.stringify(finalState));
  assert.ok(finalState.history.length >= 3, JSON.stringify(finalState));
  for (let index = 1; index < finalState.history.length; index += 1) {
    const previous = finalState.history[index - 1];
    const current = finalState.history[index];
    assert.ok(
      current.secondsPerColumn <= previous.secondsPerColumn * (1 + 1e-6),
      `Spectrogram resolution regressed while loading: ${JSON.stringify({ previous, current })}`,
    );
  }
  assert.ok(finalState.stableHashes.length >= 5, JSON.stringify(finalState));
  assert.equal(
    new Set(finalState.stableHashes.map((entry) => entry.hash)).size,
    1,
    `Previously rendered spectrogram pixels changed during append: ${JSON.stringify(finalState.stableHashes)}`,
  );
  console.log(JSON.stringify({ loadingPreview, finalState }, null, 2));
} finally {
  await command(endpoint, 'DELETE').catch(() => {});
}
