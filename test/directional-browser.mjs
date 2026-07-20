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
const sessionId = session.sessionId;
const endpoint = `/session/${sessionId}`;

async function execute(script, args = []) {
  return command(`${endpoint}/execute/sync`, 'POST', { script, args });
}

async function executeAsync(script, args = []) {
  return command(`${endpoint}/execute/async`, 'POST', { script, args });
}

async function waitFor(script, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await execute(script);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${script}`);
}

try {
  await command(`${endpoint}/url`, 'POST', { url: 'http://vibecheck.local:5173/' });
  await waitFor("return document.readyState === 'complete'");

  await execute(`
    const sampleRate = 48000;
    const seconds = 6;
    const channels = 4;
    const frames = sampleRate * seconds;
    const bytes = new ArrayBuffer(44 + frames * channels * 4);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((character, index) =>
      view.setUint8(offset + index, character.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
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
    view.setUint32(40, frames * channels * 4, true);
    const frequencies = [180, 311, 523, 877];
    for (let frame = 0; frame < frames; frame += 1) {
      const time = frame / sampleRate;
      const section = 0.25 + 0.75 * ((Math.floor(time * 8) % 4) + 1) / 4;
      for (let channel = 0; channel < channels; channel += 1) {
        const carrier = Math.sin(2 * Math.PI * frequencies[channel] * time);
        const pulse = Math.sin(2 * Math.PI * (3 + channel) * time) > 0.55 ? 1 : 0.15;
        view.setFloat32(44 + (frame * channels + channel) * 4,
          carrier * pulse * section * (0.42 + channel * 0.08), true);
      }
    }
    const file = new File([bytes], 'browser-tetra-a-format.wav', { type: 'audio/wav' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    window.dispatchEvent(event);
  `);

  await waitFor("return document.querySelector('#file-name')?.textContent === 'browser-tetra-a-format.wav' && !document.querySelector('#ambisonic-mix-section')?.hidden");
  await waitFor("return !document.querySelector('#file-size')?.textContent.includes('%') && !document.querySelector('#file-size')?.textContent.includes('Parsing')");

  await execute(`
    document.querySelector('#settings-button').click();
    if (document.querySelector('#spectrum-button').getAttribute('aria-expanded') !== 'true') {
      document.querySelector('#spectrum-button').click();
    }
    const format = document.querySelector('#ambisonic-format-select');
    format.value = 'a-format';
    format.dispatchEvent(new Event('change', { bubbles: true }));
    const mode = document.querySelector('#mono-mix-select');
    mode.value = 'directional';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await waitFor("return document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready')", 60_000);
  await waitFor("return !document.querySelector('#spectrum-analyzer')?.hidden && document.querySelector('#spectrum-canvas')?.width > 1");

  const spectralSnapshot = async () => execute(`
    const canvas = document.querySelector('#spectral-canvas');
    const plotPixels = Math.round(
      Math.max(1, canvas.getBoundingClientRect().width - 38) * (window.devicePixelRatio || 1)
    );
    return {
      columns: Number(canvas.dataset.timeColumns || 0),
      plotPixels,
      generation: Number(canvas.dataset.directionalGeneration || -1),
      tier: Number(canvas.dataset.directionalTier || -1),
      computedFrames: Number(canvas.dataset.computedFrames || 0),
      reusedFrames: Number(canvas.dataset.reusedFrames || 0),
      generationComputedFrames: Number(canvas.dataset.generationComputedFrames || 0),
      generationReusedFrames: Number(canvas.dataset.generationReusedFrames || 0),
      cachedFrames: Number(canvas.dataset.cachedFrames || 0),
    };
  `);
  const initialResolution = await spectralSnapshot();
  assert.ok(
    initialResolution.columns >= initialResolution.plotPixels * 0.95,
    JSON.stringify(initialResolution),
  );

  const benchmarkScript = `
    const done = arguments[arguments.length - 1];
    const wave = document.querySelector('#wave-canvas');
    const spectral = document.querySelector('#spectral-canvas');
    const spectrum = document.querySelector('#spectrum-canvas');
    const pad = document.querySelector('#virtual-mic-pad');
    const overlay = document.querySelector('#analysis-overlay');
    const waveProbe = document.createElement('canvas');
    waveProbe.width = 256;
    waveProbe.height = 64;
    const spectralProbe = document.createElement('canvas');
    spectralProbe.width = 128;
    spectralProbe.height = 64;
    const spectrumProbe = document.createElement('canvas');
    spectrumProbe.width = 128;
    spectrumProbe.height = 256;
    const sample = (canvas, probe) => {
      const context = probe.getContext('2d');
      context.drawImage(canvas, 0, 0, probe.width, probe.height);
      return context.getImageData(0, 0, probe.width, probe.height).data;
    };
    const hash = (values) => {
      let result = 2166136261;
      for (let index = 0; index < values.length; index += 4) {
        result = Math.imul(result ^ values[index], 16777619);
        result = Math.imul(result ^ values[index + 1], 16777619);
        result = Math.imul(result ^ values[index + 2], 16777619);
      }
      return result >>> 0;
    };
    const greenPixels = (values) => {
      let count = 0;
      for (let index = 0; index < values.length; index += 4) {
        if (values[index + 1] > values[index] * 1.25 && values[index + 1] > values[index + 2] * 1.1) count += 1;
      }
      return count;
    };
    const initialWavePixels = sample(wave, waveProbe);
    const beforeWave = hash(initialWavePixels);
    const beforeSpectral = hash(sample(spectral, spectralProbe));
    const beforeSpectrum = hash(sample(spectrum, spectrumProbe));
    const beforeGreen = greenPixels(initialWavePixels);
    const rect = pad.getBoundingClientRect();
    const pointerId = 41;
    const capturePointer = pad.setPointerCapture;
    pad.setPointerCapture = () => {};
    pad.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId,
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
    }));
    pad.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, button: 0, pointerId,
      clientX: rect.left + rect.width * 0.86,
      clientY: rect.top + rect.height * 0.22,
    }));
    pad.setPointerCapture = capturePointer;
    const immediateWave = hash(sample(wave, waveProbe));
    const immediateSpectral = hash(sample(spectral, spectralProbe));
    const immediateSpectrum = hash(sample(spectrum, spectrumProbe));
    const started = performance.now();
    let frames = 0;
    let waveMs = null;
    let spectralMs = null;
    let spectrumMs = null;
    let overlayShown = false;
    let minimumGreen = beforeGreen;
    const check = () => {
      frames += 1;
      overlayShown ||= overlay.classList.contains('is-active');
      const wavePixels = sample(wave, waveProbe);
      minimumGreen = Math.min(minimumGreen, greenPixels(wavePixels));
      if (waveMs === null && hash(wavePixels) !== beforeWave) waveMs = performance.now() - started;
      if (spectralMs === null && hash(sample(spectral, spectralProbe)) !== beforeSpectral) spectralMs = performance.now() - started;
      if (spectrumMs === null && hash(sample(spectrum, spectrumProbe)) !== beforeSpectrum) spectrumMs = performance.now() - started;
      if ((waveMs !== null && spectralMs !== null && spectrumMs !== null) || performance.now() - started > 3000) {
        pad.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId }));
        done({
          waveMs, spectralMs, spectrumMs, frames, overlayShown, beforeGreen, minimumGreen,
          staleWavePreserved: immediateWave === beforeWave,
          staleSpectralPreserved: immediateSpectral === beforeSpectral,
          staleSpectrumPreserved: immediateSpectrum === beforeSpectrum,
          composeMs: Number(spectral.dataset.directionComposeMs || 0),
          directionColumns: Number(spectral.dataset.directionColumns || 0),
          backend: spectral.dataset.directionBackend,
          direction: document.querySelector('#virtual-mic-direction-output')?.value,
          spectrumState: spectrum.dataset.analysisState,
          spectrumSource: spectrum.dataset.analysisSource,
          spectrumCursorTime: spectrum.dataset.analysisCursorTime,
        });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  `;

  const zoomedOut = await executeAsync(benchmarkScript);
  assert.equal(zoomedOut.overlayShown, false);
  assert.equal(zoomedOut.staleWavePreserved, true);
  assert.equal(zoomedOut.staleSpectralPreserved, true);
  assert.equal(zoomedOut.staleSpectrumPreserved, true);
  assert.ok(zoomedOut.waveMs !== null, JSON.stringify(zoomedOut));
  assert.ok(zoomedOut.spectralMs !== null, JSON.stringify(zoomedOut));
  assert.ok(zoomedOut.spectrumMs !== null, JSON.stringify(zoomedOut));
  assert.ok(zoomedOut.directionColumns >= initialResolution.plotPixels * 0.95, JSON.stringify(zoomedOut));
  assert.ok(zoomedOut.composeMs < 25, JSON.stringify(zoomedOut));
  assert.ok(zoomedOut.minimumGreen >= zoomedOut.beforeGreen * 0.7, JSON.stringify(zoomedOut));

  const sustainedDrag = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const pad = document.querySelector('#virtual-mic-pad');
    const spectral = document.querySelector('#spectral-canvas');
    const spectrum = document.querySelector('#spectrum-canvas');
    const overlay = document.querySelector('#analysis-overlay');
    const spectralProbe = document.createElement('canvas');
    spectralProbe.width = 128;
    spectralProbe.height = 64;
    const spectrumProbe = document.createElement('canvas');
    spectrumProbe.width = 128;
    spectrumProbe.height = 256;
    const hash = (canvas, probe) => {
      const context = probe.getContext('2d');
      context.drawImage(canvas, 0, 0, probe.width, probe.height);
      const values = context.getImageData(0, 0, probe.width, probe.height).data;
      let result = 2166136261;
      for (let index = 0; index < values.length; index += 4) {
        result = Math.imul(result ^ values[index], 16777619);
        result = Math.imul(result ^ values[index + 1], 16777619);
        result = Math.imul(result ^ values[index + 2], 16777619);
      }
      return result >>> 0;
    };
    const rect = pad.getBoundingClientRect();
    const pointerId = 73;
    const capturePointer = pad.setPointerCapture;
    pad.setPointerCapture = () => {};
    pad.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId,
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
    }));
    const started = performance.now();
    let lastSpectralHash = hash(spectral, spectralProbe);
    let lastSpectrumHash = hash(spectrum, spectrumProbe);
    let updates = 0;
    let spectrumUpdates = 0;
    let frames = 0;
    let overlayShown = false;
    const animate = (now) => {
      frames += 1;
      overlayShown ||= overlay.classList.contains('is-active');
      const nextSpectralHash = hash(spectral, spectralProbe);
      const nextSpectrumHash = hash(spectrum, spectrumProbe);
      if (nextSpectralHash !== lastSpectralHash) updates += 1;
      if (nextSpectrumHash !== lastSpectrumHash) spectrumUpdates += 1;
      lastSpectralHash = nextSpectralHash;
      lastSpectrumHash = nextSpectrumHash;
      const elapsed = now - started;
      if (elapsed < 1000) {
        const phase = elapsed / 1000 * Math.PI * 4;
        pad.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, button: 0, pointerId,
          clientX: rect.left + rect.width * (0.5 + 0.42 * Math.sin(phase)),
          clientY: rect.top + rect.height * (0.5 + 0.38 * Math.cos(phase * 0.73)),
        }));
        requestAnimationFrame(animate);
        return;
      }
      pad.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId }));
      pad.setPointerCapture = capturePointer;
      done({
        updates,
        spectrumUpdates,
        frames,
        updateRate: updates / Math.max(0.001, elapsed / 1000),
        spectrumUpdateRate: spectrumUpdates / Math.max(0.001, elapsed / 1000),
        composeMs: Number(spectral.dataset.directionComposeMs || 0),
        directionColumns: Number(spectral.dataset.directionColumns || 0),
        overlayShown,
      });
    };
    requestAnimationFrame(animate);
  `);
  assert.equal(sustainedDrag.overlayShown, false, JSON.stringify(sustainedDrag));
  assert.ok(sustainedDrag.directionColumns >= initialResolution.plotPixels * 0.95, JSON.stringify(sustainedDrag));
  assert.ok(sustainedDrag.updateRate >= 30, JSON.stringify(sustainedDrag));
  assert.ok(sustainedDrag.spectrumUpdateRate >= 30, JSON.stringify(sustainedDrag));

  await execute(`
    const editor = document.querySelector('#editor');
    const rect = editor.getBoundingClientRect();
    editor.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -240,
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
    }));
  `);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitFor("return document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready')", 60_000);
  const zoomedResolution = await spectralSnapshot();
  assert.ok(
    zoomedResolution.columns >= zoomedResolution.plotPixels * 0.95,
    JSON.stringify(zoomedResolution),
  );
  await execute(`
    const pad = document.querySelector('#virtual-mic-pad');
    pad.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const zoomedIn = await executeAsync(benchmarkScript);
  assert.equal(zoomedIn.overlayShown, false);
  assert.equal(zoomedIn.staleWavePreserved, true);
  assert.equal(zoomedIn.staleSpectralPreserved, true);
  assert.equal(zoomedIn.staleSpectrumPreserved, true);
  assert.ok(zoomedIn.waveMs !== null, JSON.stringify(zoomedIn));
  assert.ok(zoomedIn.spectralMs !== null, JSON.stringify(zoomedIn));
  assert.ok(zoomedIn.spectrumMs !== null, JSON.stringify(zoomedIn));
  assert.ok(zoomedIn.directionColumns >= zoomedResolution.plotPixels * 0.95, JSON.stringify(zoomedIn));
  assert.ok(zoomedIn.composeMs < 25, JSON.stringify(zoomedIn));
  assert.ok(zoomedIn.minimumGreen >= zoomedIn.beforeGreen * 0.7, JSON.stringify(zoomedIn));

  const generationBeforePan = zoomedResolution.generation;
  await execute(`
    const editor = document.querySelector('#editor');
    const rect = editor.getBoundingClientRect();
    editor.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: 190,
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
    }));
  `);
  await waitFor(`
    const canvas = document.querySelector('#spectral-canvas');
    return Number(canvas.dataset.directionalGeneration || -1) > ${generationBeforePan} &&
      document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready');
  `, 60_000);
  const pannedResolution = await spectralSnapshot();
  assert.ok(pannedResolution.columns >= pannedResolution.plotPixels * 0.95, JSON.stringify(pannedResolution));
  assert.ok(pannedResolution.reusedFrames > pannedResolution.computedFrames, JSON.stringify(pannedResolution));
  assert.ok(
    pannedResolution.generationComputedFrames < pannedResolution.columns * 0.35,
    JSON.stringify(pannedResolution),
  );

  const generationBeforeReturn = pannedResolution.generation;
  await execute(`
    const editor = document.querySelector('#editor');
    editor.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      clientX: editor.getBoundingClientRect().left + editor.getBoundingClientRect().width * 0.5,
      clientY: editor.getBoundingClientRect().top + editor.getBoundingClientRect().height * 0.5,
    }));
  `);
  await waitFor(`
    const canvas = document.querySelector('#spectral-canvas');
    return Number(canvas.dataset.directionalGeneration || -1) > ${generationBeforeReturn} &&
      document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready');
  `, 60_000);
  const returnedResolution = await spectralSnapshot();
  assert.ok(returnedResolution.columns >= returnedResolution.plotPixels * 0.95, JSON.stringify(returnedResolution));
  assert.equal(returnedResolution.generationComputedFrames, 0, JSON.stringify(returnedResolution));
  assert.ok(returnedResolution.generationReusedFrames >= returnedResolution.columns, JSON.stringify(returnedResolution));

  const refinementWaveform = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const wave = document.querySelector('#wave-canvas');
    const spectral = document.querySelector('#spectral-canvas');
    const overlay = document.querySelector('#analysis-overlay');
    const probe = document.createElement('canvas');
    probe.width = 256;
    probe.height = 64;
    const hash = () => {
      const context = probe.getContext('2d');
      context.drawImage(wave, 0, 0, probe.width, probe.height);
      const values = context.getImageData(0, 0, probe.width, probe.height).data;
      let result = 2166136261;
      for (let index = 0; index < values.length; index += 4) {
        result = Math.imul(result ^ values[index], 16777619);
        result = Math.imul(result ^ values[index + 1], 16777619);
        result = Math.imul(result ^ values[index + 2], 16777619);
      }
      return result >>> 0;
    };
    const before = hash();
    const previousGeneration = Number(spectral.dataset.directionalGeneration || -1);
    const mode = document.querySelector('#analysis-mode-select');
    mode.value = 'fft';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const resolution = document.querySelector('#fft-slider');
    resolution.value = resolution.max;
    resolution.dispatchEvent(new Event('input', { bubbles: true }));
    const started = performance.now();
    let frames = 0;
    let changed = false;
    let overlayShown = false;
    const check = () => {
      frames += 1;
      changed ||= hash() !== before;
      overlayShown ||= overlay.classList.contains('is-active');
      const complete = Number(spectral.dataset.directionalGeneration || -1) > previousGeneration &&
        document.querySelector('#mono-mix-status')?.value?.startsWith('Viewport ready');
      if (complete || performance.now() - started > 90_000) {
        done({ changed, overlayShown, frames, timedOut: !complete });
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  `);
  assert.equal(refinementWaveform.timedOut, false, JSON.stringify(refinementWaveform));
  assert.equal(refinementWaveform.changed, false, JSON.stringify(refinementWaveform));
  assert.equal(refinementWaveform.overlayShown, false, JSON.stringify(refinementWaveform));
  await execute(`
    const pad = document.querySelector('#virtual-mic-pad');
    pad.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const maximumFft = await executeAsync(benchmarkScript);
  assert.equal(maximumFft.overlayShown, false);
  assert.equal(maximumFft.staleWavePreserved, true);
  assert.equal(maximumFft.staleSpectralPreserved, true);
  assert.equal(maximumFft.staleSpectrumPreserved, true);
  assert.ok(maximumFft.waveMs !== null, JSON.stringify(maximumFft));
  assert.ok(maximumFft.spectralMs !== null, JSON.stringify(maximumFft));
  assert.ok(maximumFft.spectrumMs !== null, JSON.stringify(maximumFft));
  assert.ok(maximumFft.directionColumns >= pannedResolution.plotPixels * 0.95, JSON.stringify(maximumFft));
  assert.ok(maximumFft.composeMs < 30, JSON.stringify(maximumFft));

  await execute(`
    // Headless Firefox has no audio device. Let the transport exercise its
    // playing-state display path even though the context cannot really run.
    window.AudioContext.prototype.resume = async function resume() {};
    document.querySelector('#play-button').click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const canPlay = await execute("return document.querySelector('#play-button').classList.contains('is-playing')");
  let playing = 'Audio output unavailable in this headless browser';
  if (canPlay) {
    await execute(`
      const pad = document.querySelector('#virtual-mic-pad');
      pad.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
    `);
    await new Promise((resolve) => setTimeout(resolve, 150));
    playing = await executeAsync(benchmarkScript);
    assert.equal(playing.overlayShown, false);
    assert.equal(playing.staleWavePreserved, true);
    assert.equal(playing.staleSpectralPreserved, true);
    assert.equal(playing.staleSpectrumPreserved, true);
    assert.ok(playing.waveMs !== null, JSON.stringify(playing));
    assert.ok(playing.spectralMs !== null, JSON.stringify(playing));
    assert.ok(playing.spectrumMs !== null, JSON.stringify(playing));
    assert.ok(playing.minimumGreen >= playing.beforeGreen * 0.7, JSON.stringify(playing));
  }

  console.log(JSON.stringify({
    initialResolution,
    zoomedOut,
    sustainedDrag,
    zoomedResolution,
    zoomedIn,
    pannedResolution,
    returnedResolution,
    refinementWaveform,
    maximumFft,
    playing,
  }, null, 2));
} finally {
  await command(`${endpoint}`, 'DELETE').catch(() => {});
}
