// AudioWorklet processor for real-time volume level computation.
//
// Uses a 400ms sliding-window RMS — the same integration time as ITU-R BS.1770
// "Momentary" loudness. This inherently smooths out inter-syllable and inter-word
// gaps (typically 50-200ms) because the window is wider than any natural speech pause.
// The result is a stable, non-jumpy level that tracks perceived speech loudness.

class VolumeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 400ms ring buffer for sliding-window RMS (matches LUFS Momentary)
    const WINDOW_MS = 400;
    this._bufferSize = Math.round(sampleRate * WINDOW_MS / 1000);
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;
    this._sumSquares = 0;
    this._samplesFilled = 0; // track how many samples we've written (for startup)

    // Report at ~60 fps
    this._frameCount = 0;
    this._reportInterval = Math.round(sampleRate / 60);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const samples = input[0];

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const squared = sample * sample;

      // Subtract the oldest sample's squared value from the running sum
      this._sumSquares -= this._buffer[this._writeIndex];
      // Write the new squared value
      this._buffer[this._writeIndex] = squared;
      // Add the new squared value to the running sum
      this._sumSquares += squared;

      // Prevent negative drift from floating point
      if (this._sumSquares < 0) this._sumSquares = 0;

      this._writeIndex = (this._writeIndex + 1) % this._bufferSize;
      if (this._samplesFilled < this._bufferSize) this._samplesFilled++;
    }

    this._frameCount += samples.length;
    if (this._frameCount >= this._reportInterval) {
      this._frameCount = 0;

      // RMS over the filled portion of the window, scaled to 0-100
      const count = this._samplesFilled || 1;
      const rms = Math.sqrt(this._sumSquares / count) * 100;

      // Piecewise linear mapping calibrated to real mic output.
      // With 400ms window RMS, speech values are more compressed/stable
      // than instantaneous RMS. Typical ranges observed:
      //   Silence: 0-0.1, Whisper: 0.5-2, Normal speech: 3-12, Loud: 15-30+
      let volume;
      if (rms < 0.2) {
        volume = rms * 25;
      } else if (rms < 1.5) {
        // Whisper / quiet ambient (5-22%)
        volume = 5 + ((rms - 0.2) / 1.3) * 17;
      } else if (rms < 5) {
        // Quiet to normal speaking (22-45%)
        volume = 22 + ((rms - 1.5) / 3.5) * 23;
      } else if (rms < 12) {
        // Normal conversation (45-65%)
        volume = 45 + ((rms - 5) / 7) * 20;
      } else if (rms < 25) {
        // Raised voice (65-82%)
        volume = 65 + ((rms - 12) / 13) * 17;
      } else {
        // Shouting (82-100%)
        volume = 82 + Math.min((rms - 25) * 0.7, 18);
      }

      volume = Math.min(100, Math.max(0, volume));

      this.port.postMessage({ volume });
    }

    return true;
  }
}

registerProcessor('volume-processor', VolumeProcessor);
