"use strict";

// The capture helper writes one 16 kHz 16-bit stereo WAV per call.
// Channel 0 (left) is you (microphone); channel 1 (right) is them (system audio).
const CHANNELS = { you: 0, them: 1 };

function header(sampleRate, channels, dataBytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Build a 16-bit PCM WAV from one Int16Array per channel (equal lengths). */
function encode(channels, sampleRate = 16000) {
  const frames = channels[0].length;
  const data = Buffer.alloc(frames * channels.length * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++)
      data.writeInt16LE(channels[c][i], (i * channels.length + c) * 2);
  }
  return Buffer.concat([
    header(sampleRate, channels.length, data.length),
    data,
  ]);
}

/** Parse a 16-bit PCM WAV into { sampleRate, channels: Int16Array[] }. */
function decode(buf) {
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("not a WAV file");
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt || fmt.bits !== 16)
        throw new Error("only 16-bit PCM is supported");
      const frames = Math.floor(
        Math.min(size, buf.length - body) / (2 * fmt.channels),
      );
      const channels = Array.from(
        { length: fmt.channels },
        () => new Int16Array(frames),
      );
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++)
          channels[c][i] = buf.readInt16LE(body + (i * fmt.channels + c) * 2);
      }
      return { sampleRate: fmt.sampleRate, channels };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV has no audio data");
}

/** Split a call recording into { you, them } mono WAV buffers. */
function splitCall(buf) {
  const { sampleRate, channels } = decode(buf);
  if (channels.length < 2)
    throw new Error("expected a stereo recording (you + them)");
  return {
    sampleRate,
    you: {
      wav: encode([channels[CHANNELS.you]], sampleRate),
      peak: peak(channels[CHANNELS.you]),
      samples: channels[CHANNELS.you],
    },
    them: {
      wav: encode([channels[CHANNELS.them]], sampleRate),
      peak: peak(channels[CHANNELS.them]),
      samples: channels[CHANNELS.them],
    },
    seconds: channels[0].length / sampleRate,
  };
}

/** Loudest sample, 0..1. */
function peak(samples) {
  let m = 0;
  for (const s of samples) m = Math.max(m, Math.abs(s));
  return m / 32768;
}

module.exports = { CHANNELS, encode, decode, splitCall, peak };
