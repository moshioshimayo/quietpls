// AudioWorklet processor: filtered level in dBFS plus a simple speech gate.
//
// Signal path (first input channel):
//   x → 2× biquad high-pass at 80 Hz (4th order; removes DC, hum and rumble) → y
//   y → 400 ms sliding RMS → dBFS (20·log10 rms, full scale = 1.0)
//   y → biquad high-pass 300 Hz + low-pass 4 kHz → speech-band energy, gate only
//
// The speech gate works on 20 ms frames:
//   - noise floor = 5th percentile (at least the 5th-quietest frame) of the
//     speech-band level over the last 3 s; a few odd frames, such as a mic's
//     start-up ramp, cannot define it
//   - a frame is speech-like when it is ≥ 12 dB above that floor, above an
//     absolute minimum, and a fair share of its energy is in 300 Hz–4 kHz
//     (hum, rumble and hiss are mostly outside that band)
//   - speech starts after 100 ms of consecutive speech-like frames (clicks,
//     taps and other short transients never get there) and holds for 300 ms
//     after the last one so word gaps do not flicker.
// It detects voice-like sound, not *whose* voice it is.
//
// One message per 20 ms frame:
//   { dbfs, speech, clip, floorDb, frameMs, seq }  or  { noInput: true, frameMs, seq }
// The same message feeds calibration and monitoring, so both use one definition.

const HPF_HZ = 80;
const BAND_LO_HZ = 300;
const LPF_HZ = 4000;
const WINDOW_MS = 400;
const FRAME_MS = 20;
const FLOOR_WINDOW_MS = 3000;
const FLOOR_PERCENTILE = 0.05;
const FLOOR_MIN_RANK = 5;
const SNR_DB = 12;
const ABS_MIN_DB = -70;
const MIN_BAND_RATIO = 0.3;
const MIN_SPEECH_MS = 100;
const HANGOVER_MS = 300;
const CLIP_LEVEL = 0.99;
const SILENT_DB = -120;
// Below this a frame is digital silence (stream start, hardware mute), not a
// room: it must never become the noise floor or every sound looks like speech.
const DIGITAL_SILENCE_DB = -100;

function toDb(meanSquare) {
  return meanSquare > 1e-12 ? 10 * Math.log10(meanSquare) : SILENT_DB;
}

// RBJ audio-EQ-cookbook biquad, Q = 1/√2 (Butterworth section).
function makeBiquad(type, freq, fs) {
  const w0 = (2 * Math.PI * freq) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = type === "highpass" ? -(1 + cos) : 1 - cos;
  const b0 = type === "highpass" ? (1 + cos) / 2 : (1 - cos) / 2;
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b0 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function runBiquad(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

class VolumeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this._hp1 = makeBiquad("highpass", HPF_HZ, fs);
    this._hp2 = makeBiquad("highpass", HPF_HZ, fs);
    this._bandHp = makeBiquad("highpass", BAND_LO_HZ, fs);
    // Below 9 kHz sample rate a 4 kHz low-pass is meaningless; skip it.
    this._lp = LPF_HZ < fs * 0.45 ? makeBiquad("lowpass", LPF_HZ, fs) : null;

    this._win = new Float64Array(Math.round((fs * WINDOW_MS) / 1000));
    this._winIdx = 0;
    this._winFilled = 0;
    this._sumSquares = 0;

    this._frameLen = Math.max(1, Math.round((fs * FRAME_MS) / 1000));
    this._frameMs = (this._frameLen / fs) * 1000;
    this._frameN = 0;
    this._frameE = 0;
    this._frameBandE = 0;
    this._frameClip = false;

    this._floorRing = new Float32Array(
      Math.round(FLOOR_WINDOW_MS / FRAME_MS),
    ).fill(Infinity);
    this._floorSorted = new Float32Array(this._floorRing.length);
    this._floorIdx = 0;

    this._candidateMs = 0;
    this._hangMs = 0;
    this._speech = false;
    this._seq = 0;
    this._noInputN = 0;
  }

  _endFrame() {
    const n = this._frameN;
    const bandDb = toDb(this._frameBandE / n);
    const bandRatio = this._frameE > 0 ? this._frameBandE / this._frameE : 0;

    this._floorRing[this._floorIdx] =
      bandDb > DIGITAL_SILENCE_DB ? bandDb : Infinity;
    this._floorIdx = (this._floorIdx + 1) % this._floorRing.length;
    // Infinity (unfilled / digital silence) sorts last, so with fewer than
    // FLOOR_MIN_RANK real frames the floor stays Infinity and nothing is speech.
    this._floorSorted.set(this._floorRing);
    this._floorSorted.sort();
    let real = 0;
    while (
      real < this._floorSorted.length &&
      this._floorSorted[real] !== Infinity
    )
      real++;
    const rank =
      Math.max(FLOOR_MIN_RANK, Math.ceil(real * FLOOR_PERCENTILE)) - 1;
    const floorDb = this._floorSorted[rank];

    const candidate =
      bandDb >= floorDb + SNR_DB &&
      bandDb > ABS_MIN_DB &&
      bandRatio >= MIN_BAND_RATIO;
    this._candidateMs = candidate ? this._candidateMs + this._frameMs : 0;
    if (candidate && (this._speech || this._candidateMs >= MIN_SPEECH_MS)) {
      this._speech = true;
      this._hangMs = HANGOVER_MS;
    } else if (!candidate && this._speech) {
      this._hangMs -= this._frameMs;
      if (this._hangMs <= 0) this._speech = false;
    }

    const filled = this._winFilled || 1;
    this.port.postMessage({
      dbfs: toDb(this._sumSquares / filled),
      speech: this._speech,
      // This frame itself passed the gate (false for hangover frames).
      voiced: this._speech && candidate,
      clip: this._frameClip,
      floorDb,
      bandDb,
      frameMs: this._frameMs,
      seq: this._seq++,
    });

    this._frameN = 0;
    this._frameE = 0;
    this._frameBandE = 0;
    this._frameClip = false;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      // Report missing input instead of going quiet, so the app can tell
      // "no signal path" apart from "silence".
      this._noInputN += 128;
      if (this._noInputN >= this._frameLen) {
        this._noInputN = 0;
        this.port.postMessage({
          noInput: true,
          frameMs: this._frameMs,
          seq: this._seq++,
        });
      }
      return true;
    }

    const samples = input[0];
    const win = this._win;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      if (x >= CLIP_LEVEL || x <= -CLIP_LEVEL) this._frameClip = true;
      const y = runBiquad(this._hp2, runBiquad(this._hp1, x));
      const sq = y * y;

      this._sumSquares += sq - win[this._winIdx];
      if (this._sumSquares < 0) this._sumSquares = 0;
      win[this._winIdx] = sq;
      this._winIdx = (this._winIdx + 1) % win.length;
      if (this._winFilled < win.length) this._winFilled++;

      this._frameE += sq;
      let b = runBiquad(this._bandHp, y);
      if (this._lp) b = runBiquad(this._lp, b);
      this._frameBandE += b * b;
      if (++this._frameN >= this._frameLen) this._endFrame();
    }
    return true;
  }
}

registerProcessor("volume-processor", VolumeProcessor);
