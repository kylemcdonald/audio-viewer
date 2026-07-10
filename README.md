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
- Choose centered, right-edge, or paged playback scrolling in the gear menu.
- Blend continuously between linear and logarithmic frequency scales.
- Select 256–4,096 FFT bins to trade time resolution for frequency resolution.
- Set the spectrogram dynamic range from 60–140 dB in the gear menu.
- Switch among the Viridis, Magma, and Inferno palettes without recomputing the FFT.

The pane split, frequency scale, palette, playback scrolling, and analysis settings persist in local storage. Spectral analysis uses a persistent, time-aligned multiresolution cache: a coarse full-width pass appears first, midpoint passes double the temporal detail, zoom levels reuse their shared columns, and pans compute only newly exposed time ranges. During playback, analysis windows extend ahead of the visible pane so upcoming FFT columns are cached before the playhead reaches them. Finer cached levels are prepared in the background down to 1 ms spacing when memory permits. The canvases automatically use the current device pixel ratio. FFT analysis uses batched WebGPU compute shaders when WebGPU is available, with a CPU compatibility path for browsers that do not expose it. Palette tables come from the MIT-licensed [viridisLite project](https://github.com/sjmgarnier/viridisLite).

Uncompressed PCM and IEEE-float WAV files use a header-first streaming path. The filename and read progress appear on the first frame, duration and format follow as soon as the RIFF header is parsed, and both the waveform and cached spectrogram fill progressively in 2 MiB chunks. Other browser-decodable formats show streamed read progress before the browser's whole-file audio decoder runs.

## License

MIT © Kyle McDonald
