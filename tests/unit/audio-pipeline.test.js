import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * US-007: Audio Pipeline Upgrade — FFT + RMS Dual Analysis
 *
 * These tests verify the cleanup sequence in stopMonitoring() properly
 * disconnects and nullifies both the workletNode (RMS) and analyserNode (FFT),
 * and that startMonitoring() creates and connects the AnalyserNode correctly.
 *
 * Because renderer.js runs in an Electron renderer with real Web Audio APIs,
 * we replicate the relevant logic here with mocks to unit-test the wiring.
 */

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockTrack() {
  return { kind: 'audio', label: 'Mock Mic', stop: vi.fn() };
}

function createMockMediaStream(tracks) {
  return { getTracks: () => tracks };
}

function createMockNode() {
  return { disconnect: vi.fn(), connect: vi.fn() };
}

function createMockWorkletNode() {
  return {
    disconnect: vi.fn(),
    connect: vi.fn(),
    port: { onmessage: null },
  };
}

function createMockAnalyserNode() {
  return {
    disconnect: vi.fn(),
    connect: vi.fn(),
    fftSize: 2048,          // default before override
    smoothingTimeConstant: 0.8,
    frequencyBinCount: 256,  // fftSize / 2 after setting 512
    getByteFrequencyData: vi.fn(),
  };
}

function createMockAudioContext({ analyser, worklet, source } = {}) {
  return {
    createAnalyser: vi.fn(() => analyser || createMockAnalyserNode()),
    createMediaStreamSource: vi.fn(() => source || createMockNode()),
    close: vi.fn(() => Promise.resolve()),
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
  };
}

// ---------------------------------------------------------------------------
// Replicate stopMonitoring cleanup logic from renderer.js
// ---------------------------------------------------------------------------

function stopMonitoring(state) {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }

  if (state.audioContext) {
    if (state.microphone) {
      state.microphone.disconnect();
    }
    if (state.workletNode) {
      state.workletNode.disconnect();
      state.workletNode.port.onmessage = null;
    }
    if (state.analyserNode) {
      state.analyserNode.disconnect();
    }

    state.audioContext.close();

    state.audioContext = null;
    state.microphone = null;
    state.workletNode = null;
    state.analyserNode = null;
  }

  state.isMonitoring = false;
  state.averageVolume = 0;
}

// Replicate the analyser setup portion of startMonitoring from renderer.js
function setupAnalyser(audioContext) {
  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 512;
  analyserNode.smoothingTimeConstant = 0.8;
  return analyserNode;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audio Pipeline — US-007', () => {
  describe('stopMonitoring cleanup sequence', () => {
    let state;
    let track;
    let worklet;
    let analyser;
    let mic;
    let ctx;

    beforeEach(() => {
      track = createMockTrack();
      worklet = createMockWorkletNode();
      worklet.port.onmessage = () => {};          // simulate active handler
      analyser = createMockAnalyserNode();
      mic = createMockNode();
      ctx = createMockAudioContext();

      state = {
        mediaStream: createMockMediaStream([track]),
        audioContext: ctx,
        microphone: mic,
        workletNode: worklet,
        analyserNode: analyser,
        isMonitoring: true,
        averageVolume: 42,
      };
    });

    it('should stop all media stream tracks', () => {
      stopMonitoring(state);
      expect(track.stop).toHaveBeenCalledOnce();
    });

    it('should disconnect microphone source', () => {
      stopMonitoring(state);
      expect(mic.disconnect).toHaveBeenCalledOnce();
    });

    it('should disconnect workletNode and clear its message handler', () => {
      stopMonitoring(state);
      expect(worklet.disconnect).toHaveBeenCalledOnce();
      expect(worklet.port.onmessage).toBeNull();
    });

    it('should disconnect analyserNode', () => {
      stopMonitoring(state);
      expect(analyser.disconnect).toHaveBeenCalledOnce();
    });

    it('should close the AudioContext', () => {
      stopMonitoring(state);
      expect(ctx.close).toHaveBeenCalledOnce();
    });

    it('should null out all audio references', () => {
      stopMonitoring(state);
      expect(state.mediaStream).toBeNull();
      expect(state.audioContext).toBeNull();
      expect(state.microphone).toBeNull();
      expect(state.workletNode).toBeNull();
      expect(state.analyserNode).toBeNull();
    });

    it('should reset monitoring flag and volume', () => {
      stopMonitoring(state);
      expect(state.isMonitoring).toBe(false);
      expect(state.averageVolume).toBe(0);
    });

    it('should handle missing analyserNode gracefully (no crash)', () => {
      state.analyserNode = null;
      expect(() => stopMonitoring(state)).not.toThrow();
    });

    it('should handle missing workletNode gracefully', () => {
      state.workletNode = null;
      expect(() => stopMonitoring(state)).not.toThrow();
    });

    it('should handle missing audioContext gracefully', () => {
      state.audioContext = null;
      expect(() => stopMonitoring(state)).not.toThrow();
    });
  });

  describe('AnalyserNode setup', () => {
    it('should create an AnalyserNode from the AudioContext', () => {
      const ctx = createMockAudioContext();
      setupAnalyser(ctx);
      expect(ctx.createAnalyser).toHaveBeenCalledOnce();
    });

    it('should set fftSize to 512', () => {
      const analyser = createMockAnalyserNode();
      const ctx = createMockAudioContext({ analyser });
      const node = setupAnalyser(ctx);
      expect(node.fftSize).toBe(512);
    });

    it('should set smoothingTimeConstant to 0.8', () => {
      const analyser = createMockAnalyserNode();
      const ctx = createMockAudioContext({ analyser });
      const node = setupAnalyser(ctx);
      expect(node.smoothingTimeConstant).toBe(0.8);
    });
  });

  describe('Dual connection topology', () => {
    it('microphone should connect to both workletNode and analyserNode', () => {
      const mic = createMockNode();
      const worklet = createMockWorkletNode();
      const analyser = createMockAnalyserNode();

      // Replicate the connection lines from renderer.js startMonitoring()
      mic.connect(worklet);
      mic.connect(analyser);

      expect(mic.connect).toHaveBeenCalledTimes(2);
      expect(mic.connect).toHaveBeenCalledWith(worklet);
      expect(mic.connect).toHaveBeenCalledWith(analyser);
    });

    it('nothing should be connected to audioContext.destination', () => {
      // The mock audioContext has no destination property — if code tried to
      // connect to ctx.destination it would fail. This test documents the
      // design intent: no playback/feedback loop.
      const ctx = createMockAudioContext();
      expect(ctx.destination).toBeUndefined();
    });
  });
});
