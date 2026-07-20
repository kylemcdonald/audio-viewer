# Audio Viewer

A full-page waveform and spectral-frequency editor built with TypeScript, Canvas, Web Audio, and an off-main-thread WebGPU FFT pipeline.

Live app: [kylemcdonald.github.io/audio-viewer](https://kylemcdonald.github.io/audio-viewer/)

## Run locally

```bash
npm install
npm run dev
```

Open [http://vibecheck.local:5173/](http://vibecheck.local:5173/).

## Controls

- Drop an audio file anywhere in the editor, or use the folder button.
- Click or drag to place and scrub the playback head.
- Press **Space** to play or pause.
- Pinch to zoom and two-finger drag to pan. Trackpad pinch and scrolling are supported too.
- Double-click the editor to restore the full-file view.
- Drag the divider between the waveform and spectrogram to resize the panels.
- Toggle the resizable cursor spectrum from the analyzer button; its pixel-sharp trace runs a fresh cursor-centered FFT every playback frame, even when the playhead is offscreen. Four-channel virtual-microphone steering mixes only that cursor window from the source channels, so the trace follows direction-pad drags immediately without waiting for the full audio remix.
- Download the visible spectrogram canvas as a full-resolution PNG from the header.
- Choose centered, right-edge, or paged playback scrolling in the gear menu.
- Blend continuously between linear and logarithmic frequency scales.
- Switch the spectrogram between FFT analysis (linear bins) and constant-Q analysis (log-spaced bands, 24-48 per octave following the resolution slider) in the gear menu; CQT mode resolves low frequencies far more sharply and pairs naturally with the logarithmic scale.
- Select 256–4,096 FFT bins to trade time resolution for frequency resolution.
- Set the spectrogram dynamic range from 60–140 dB in the gear menu.
- Switch among the Viridis, Magma, and Inferno palettes without recomputing the FFT.
- For supported four-channel files, choose a normalized channel sum, channel 1, or a steerable maximum-directivity virtual microphone. The 2:1 direction pad covers ±180° azimuth and ±90° elevation, with AmbiX (`W Y Z X`), FuMa (`W X Y Z`), and canonical tetrahedral A-format (`FLU FRD BLD BRU`) layouts.

The pane split, frequency scale, palette, playback scrolling, and analysis settings persist in local storage. Spectral analysis uses a persistent, time-aligned multiresolution cache: a coarse full-width pass appears first, midpoint passes double the temporal detail, zoom levels reuse their shared columns, and pans compute only newly exposed time ranges. During playback, analysis windows extend ahead of the visible pane so upcoming FFT columns are cached before the playhead reaches them. Finer cached levels are prepared in the background down to 1 ms spacing normally and 0.25 ms for tightly zoomed directional views when memory permits. The canvases automatically use the current device pixel ratio. FFT analysis uses batched WebGPU compute shaders when WebGPU is available, with a CPU compatibility path for browsers that do not expose it. Palette tables come from the MIT-licensed [viridisLite project](https://github.com/sjmgarnier/viridisLite).

Uncompressed PCM and IEEE-float WAV files use a header-first streaming path. The filename and read progress appear on the first frame, duration and format follow as soon as the RIFF header is parsed, and both the waveform and cached spectrogram fill progressively in 2 MiB chunks. Completed spectral columns stay fixed while each newly available region is appended at the right edge; recursive finer-level prefetch resumes after the file finishes loading.

Four-channel WAVs also use their BWF/iXML track labels, when available, to identify AmbiX, FuMa, or tetrahedral A-format automatically. Direction changes update the live playback matrix without restarting transport. A bounded covariance pyramid supplies zoomed-out waveform envelopes, raw visible samples supply exact zoomed-in peaks, and a 256 MiB LRU spectral cache retains compact, direction-independent channel coefficients across load, zoom, and pan requests. Every drag recombines the full physical-canvas time grid in a parallel CPU worker pool, raced by WebGPU when available; rapid pointer events are coalesced without starving completed frames. Initial time resolution grows through 4-, 16-, 64-, and 256-column subdivisions, then keeps doubling to canvas density, while later loads, pans, and zooms start above the resolution already visible and request only missing aligned columns. Stale pixels remain visible until replacements are ready, and the full mono sequence rebuilds separately in the background without a blocking analysis overlay.

MP4 files use a lazy, audio-only demuxing path powered by [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0). The primary audio track is progressively decoded into the waveform and FFT pipeline with WebCodecs while an offscreen media element provides memory-efficient playback; video tracks are ignored. Browsers without the required codec or WebCodecs support fall back to their whole-file audio decoder. Other browser-decodable formats show streamed read progress before the whole-file decoder runs.

## License

MIT © Kyle McDonald
