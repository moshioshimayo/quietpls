// capture — records one call as a stereo 16 kHz WAV:
//   left  = you  (default microphone, raw)
//   right = them (system audio, via a CoreAudio process tap; macOS 14.4+)
// Usage: capture --out <file.wav> [--exclude-pid <pid>]... [--echo-cancel]
//        capture --check        (prints microphone permission state)
// Talks to the app with one JSON object per stdout line. Stop with SIGINT/SIGTERM
// or by closing stdin; the WAV is written on stop.
import AVFoundation
import CoreAudio
import Foundation

let sampleRate = 16000.0
setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
  }
}

func fail(_ code: String, _ detail: String) -> Never {
  emit(["type": "error", "code": code, "detail": detail])
  exit(2)
}

// MARK: arguments

var outPath = ""
var excludePids: [pid_t] = []
var voiceProcessing = false  // off: with Apple voice processing on, the system-audio tap goes silent (macOS 26)
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--out": outPath = args.next() ?? ""
  case "--exclude-pid": if let p = args.next().flatMap({ pid_t($0) }) { excludePids.append(p) }
  case "--echo-cancel": voiceProcessing = true
  case "--check":
    let s = AVCaptureDevice.authorizationStatus(for: .audio)
    let state = s == .authorized ? "granted" : s == .notDetermined ? "undetermined" : "denied"
    emit(["type": "check", "mic": state])
    exit(0)
  default: fail("bad-args", "unknown argument \(arg)")
  }
}
if outPath.isEmpty { fail("bad-args", "--out is required") }

// MARK: one side of the call, resampled to 16 kHz mono

final class Track {
  let lock = NSLock()
  var samples: [Float] = []
  var startOffset: Double? = nil  // seconds after recording start when first audio arrived
  var level: Float = 0
  var converter: AVAudioConverter?
  var converterRate = 0.0
  let mono16k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

  /// channel: nil = average all channels, otherwise use that channel only.
  func append(_ buf: AVAudioPCMBuffer, channel: Int?, since start: Date) {
    guard let data = buf.floatChannelData, buf.frameLength > 0 else { return }
    let n = Int(buf.frameLength)
    let channels = Int(buf.format.channelCount)
    let rate = buf.format.sampleRate
    guard let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
      let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: AVAudioFrameCount(n))
    else { return }
    mono.frameLength = AVAudioFrameCount(n)
    let dst = mono.floatChannelData![0]
    let stride = buf.format.isInterleaved ? channels : 1
    var sumSq: Float = 0
    for i in 0..<n {
      var v: Float = 0
      if buf.format.isInterleaved {
        let base = data[0]
        if let c = channel { v = base[i * stride + min(c, channels - 1)] } else {
          for c in 0..<channels { v += base[i * stride + c] }
          v /= Float(channels)
        }
      } else if let c = channel {
        v = data[min(c, channels - 1)][i]
      } else {
        for c in 0..<channels { v += data[c][i] }
        v /= Float(channels)
      }
      dst[i] = v
      sumSq += v * v
    }
    if converter == nil || converterRate != rate {
      converter = AVAudioConverter(from: monoFmt, to: mono16k)
      converterRate = rate
    }
    let outCap = AVAudioFrameCount(Double(n) * sampleRate / rate + 64)
    guard let conv = converter, let out = AVAudioPCMBuffer(pcmFormat: mono16k, frameCapacity: outCap) else { return }
    var fed = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return mono
    }
    let got = Int(out.frameLength)
    lock.lock()
    if startOffset == nil { startOffset = max(0, Date().timeIntervalSince(start) - Double(n) / rate) }
    samples.append(contentsOf: UnsafeBufferPointer(start: out.floatChannelData![0], count: got))
    level = max(level * 0.6, (sumSq / Float(n)).squareRoot())
    lock.unlock()
  }

  func takeLevel() -> Float {
    lock.lock(); defer { lock.unlock() }
    let l = level
    level *= 0.5
    return l
  }
}

let start = Date()
let you = Track()
let them = Track()

// MARK: you — microphone

let mic = AVCaptureDevice.authorizationStatus(for: .audio)
if mic == .notDetermined {
  let sem = DispatchSemaphore(value: 0)
  AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }
  sem.wait()
}
if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
  fail("mic-denied", "Microphone access is off for this app")
}

// MARK: them — system audio process tap

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processObject(for pid: pid_t) -> AudioObjectID? {
  var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
  var qualifier = pid
  var object = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
  return status == noErr && object != kAudioObjectUnknown ? object : nil
}

func defaultOutputUID() -> String? {
  var addr = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr else { return nil }
  var uidAddr = address(kAudioDevicePropertyDeviceUID)
  var uid: Unmanaged<CFString>?
  size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(device, &uidAddr, 0, nil, &size, &uid) == noErr, let u = uid else { return nil }
  return u.takeRetainedValue() as String
}

let excluded = excludePids.compactMap(processObject(for:))
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
tapDesc.uuid = UUID()
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tapDesc, &tapID)
if status != noErr { fail("system-audio-unavailable", "Could not tap system audio (\(status))") }

var tapFormatAddr = address(kAudioTapPropertyFormat)
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
status = AudioObjectGetPropertyData(tapID, &tapFormatAddr, 0, nil, &asbdSize, &asbd)
guard status == noErr, let tapFormat = AVAudioFormat(streamDescription: &asbd) else {
  fail("system-audio-unavailable", "Could not read system audio format (\(status))")
}
guard let outputUID = defaultOutputUID() else { fail("system-audio-unavailable", "No output device") }

let aggregate: [String: Any] = [
  kAudioAggregateDeviceNameKey: "quietpls-capture tap",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDesc.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
if status != noErr { fail("system-audio-unavailable", "Could not create tap device (\(status))") }

var ioProc: AudioDeviceIOProcID?
let ioQueue = DispatchQueue(label: "capture.tap")
status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, ioQueue) { _, inData, _, _, _ in
  guard let buf = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inData, deallocator: nil) else { return }
  them.append(buf, channel: nil, since: start)
}
if status != noErr { fail("system-audio-unavailable", "Could not read tap (\(status))") }

func teardownTap() {
  if let p = ioProc {
    AudioDeviceStop(aggregateID, p)
    AudioDeviceDestroyIOProcID(aggregateID, p)
    ioProc = nil
  }
  AudioHardwareDestroyAggregateDevice(aggregateID)
  AudioHardwareDestroyProcessTap(tapID)
}

status = AudioDeviceStart(aggregateID, ioProc)
if status != noErr {
  teardownTap()
  fail("system-audio-unavailable", "Could not start system audio (\(status))")
}

// Mic starts after the tap: enabling voice processing first leaves the tap silent.
let engine = AVAudioEngine()
let input = engine.inputNode
if voiceProcessing {
  do {
    try input.setVoiceProcessingEnabled(true)
    // Voice processing ducks other audio by default, which would quiet the call itself.
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
  } catch {
    emit(["type": "warning", "code": "no-echo-cancel", "detail": "\(error)"])
  }
}
let micFormat = input.outputFormat(forBus: 0)
if micFormat.channelCount == 0 { teardownTap(); fail("mic-unavailable", "No microphone input found") }
input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buf, _ in
  you.append(buf, channel: 0, since: start)
}
do { try engine.start() } catch {
  teardownTap()
  fail("mic-unavailable", "Could not start the microphone: \(error)")
}
emit(["type": "started", "micRate": micFormat.sampleRate, "micChannels": micFormat.channelCount,
      "tapRate": tapFormat.sampleRate, "tapChannels": tapFormat.channelCount, "echoCancel": input.isVoiceProcessingEnabled])

// MARK: levels + stop

let levelTimer = DispatchSource.makeTimerSource(queue: .main)
levelTimer.schedule(deadline: .now() + 0.25, repeating: 0.25)
levelTimer.setEventHandler {
  emit(["type": "level", "you": Double(you.takeLevel()), "them": Double(them.takeLevel()),
        "seconds": Date().timeIntervalSince(start)])
}
levelTimer.resume()

func writeWav() throws -> (frames: Int, youPeak: Float, themPeak: Float) {
  you.lock.lock(); them.lock.lock()
  defer { you.lock.unlock(); them.lock.unlock() }
  // Place each side at the moment its audio started so both stay aligned.
  let youAt = Int(((you.startOffset ?? 0) * sampleRate).rounded())
  let themAt = Int(((them.startOffset ?? 0) * sampleRate).rounded())
  let frames = max(youAt + you.samples.count, themAt + them.samples.count)
  var pcm = [Int16](repeating: 0, count: frames * 2)
  var youPeak: Float = 0
  var themPeak: Float = 0
  for (i, v) in you.samples.enumerated() {
    pcm[(youAt + i) * 2] = Int16(max(-1, min(1, v)) * 32767)
    youPeak = max(youPeak, abs(v))
  }
  for (i, v) in them.samples.enumerated() {
    pcm[(themAt + i) * 2 + 1] = Int16(max(-1, min(1, v)) * 32767)
    themPeak = max(themPeak, abs(v))
  }
  var header = Data()
  func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
  let dataBytes = UInt32(frames * 4)
  header.append("RIFF".data(using: .ascii)!); u32(36 + dataBytes)
  header.append("WAVEfmt ".data(using: .ascii)!); u32(16); u16(1); u16(2)
  u32(UInt32(sampleRate)); u32(UInt32(sampleRate) * 4); u16(4); u16(16)
  header.append("data".data(using: .ascii)!); u32(dataBytes)
  var file = header
  pcm.withUnsafeBytes { file.append(contentsOf: $0) }
  try file.write(to: URL(fileURLWithPath: outPath))
  return (frames, youPeak, themPeak)
}

var stopping = false
func stop() {
  if stopping { return }
  stopping = true
  levelTimer.cancel()
  engine.inputNode.removeTap(onBus: 0)
  engine.stop()
  teardownTap()
  do {
    let r = try writeWav()
    emit(["type": "saved", "path": outPath, "seconds": Double(r.frames) / sampleRate,
          "youPeak": Double(r.youPeak), "themPeak": Double(r.themPeak)])
    exit(0)
  } catch {
    fail("write-failed", "\(error)")
  }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigint.setEventHandler(handler: stop)
sigterm.setEventHandler(handler: stop)
sigint.resume()
sigterm.resume()
// Parent went away (stdin closed) → stop and save rather than record forever.
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
  var byte: UInt8 = 0
  if read(STDIN_FILENO, &byte, 1) <= 0 { stdinSource.cancel(); stop() }
}
stdinSource.resume()
dispatchMain()
