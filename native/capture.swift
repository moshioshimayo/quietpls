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
import Darwin

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
var approvedOnly = false
var approveBundles = Set<String>()
var neverBundles = Set<String>()
var sourcesFixture: String?
var revokeFixture = false
var buffersFixture: String?
var sourcesOnly = false
var voiceProcessing = false  // off: with Apple voice processing on, the system-audio tap goes silent (macOS 26)
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--approved-only": approvedOnly = true
  case "--approve-bundle": if let id = args.next() { approveBundles.insert(id) }
  case "--never-bundle": if let id = args.next() { neverBundles.insert(id) }
  case "--sources-fixture": sourcesFixture = args.next()
  case "--revoke-fixture": outPath = args.next() ?? ""; revokeFixture = true
  case "--buffers-fixture": buffersFixture = args.next()
  case "--sources": sourcesOnly = true
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


// Identity snapshots are deliberately plain data: the fixture and live path use
// the same resolver, and only the live reader calls CoreAudio/libproc.
struct Source: Codable {
  var object: UInt32 = 0
  var pid: Int32
  var bundle: String = ""
  var path: String = ""
  var start: Int64 = 0
  var parent: Int32 = 0
  var responsible: Int32? = nil
  var responsibleStart: Int64? = nil
  var runningOutput: Bool = false
  var vanished: Bool? = nil
  var error: String? = nil
}
struct SourceFixture: Decodable {
  var processes: [Source]
  var approved: [String]
  var never: [String]
  var excludePids: [Int32]?
  var timeline: [Step]?
  struct Step: Decodable { var at: Double; var processes: [Source] }
}
struct Decision {
  var included: [Source]
  var micOnly: Bool
  var unattributed: Bool
  var ownOutput = false
}
// A2.4(ii): latch mic-only after 3 s of unattributed sound, but only while no
// approved process has played yet; approved audio already captured is kept.
struct Attribution {
  var heard = false
  var since: Double?
  mutating func latch(_ d: Decision, at t: Double) -> Bool {
    if d.ownOutput { heard = true }
    guard d.unattributed && !heard else { since = nil; return false }
    if since == nil { since = t }
    return t - since! >= 3
  }
}
struct SourceFailure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}
let sharedCallApps: Set<String> = ["com.apple.FaceTime", "com.apple.MobileSMS", "com.apple.mobilephone"]
func appRoot(_ path: String) -> String? {
  let parts = path.split(separator: "/")
  guard let index = parts.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
  return "/" + parts[...index].joined(separator: "/")
}
func inside(_ path: String, _ root: String) -> Bool { path.hasPrefix(root + "/") }

func resolve(_ table: [Source], approved: Set<String>, never: Set<String>, excluded: Set<Int32>) throws -> Decision {
  let live = table.filter { $0.vanished != true }
  for s in live { if let error = s.error { throw SourceFailure(error) } }
  let byPid = Dictionary(live.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
  let neverRoots = live.filter { s in never.contains(s.bundle) }.compactMap { appRoot($0.path) }
  func veto(_ s: Source) -> Bool {
    excluded.contains(s.pid) || never.contains(where: { s.bundle == $0 || s.bundle.hasPrefix($0 + ".") }) || neverRoots.contains(where: { inside(s.path, $0) })
  }
  let anchors = live.filter { approved.contains($0.bundle) && !sharedCallApps.contains($0.bundle) && appRoot($0.path) != nil && !veto($0) }
  let roots = anchors.compactMap { appRoot($0.path) }
  func attributed(_ s: Source) -> Bool {
    if anchors.contains(where: { $0.pid == s.pid && $0.start == s.start }) { return true }
    guard roots.contains(where: { inside(s.path, $0) }) else { return false }
    if let pid = s.responsible, let identity = s.responsibleStart,
       anchors.contains(where: { $0.pid == pid && $0.start == identity && $0.start <= s.start }) { return true }
    var child = s
    var seen = Set<Int32>()
    while child.parent > 1, seen.insert(child.pid).inserted, let parent = byPid[child.parent], parent.start <= child.start {
      if anchors.contains(where: { $0.pid == parent.pid && $0.start == parent.start }) { return true }
      child = parent
    }
    return false
  }
  let included = live.filter { $0.object != 0 && !veto($0) && attributed($0) }
  let includedIds = Set(included.map { $0.object })
  let ownOutput = included.contains(where: { $0.runningOutput })
  let otherOutput = live.contains { $0.object != 0 && !includedIds.contains($0.object) && !excluded.contains($0.pid) && $0.runningOutput }
  return Decision(included: included.sorted { $0.object < $1.object }, micOnly: anchors.isEmpty, unattributed: !ownOutput && otherOutput, ownOutput: ownOutput)
}

let fault = ProcessInfo.processInfo.environment["QUIETPLS_CAPTURE_FAULT"] ?? ""
var faultArmed = false
func checkFault(_ step: String) throws {
  if fault == step || (faultArmed && fault == "after-start:" + step) { throw SourceFailure("injected \(step)") }
}
typealias ResponsibleFunction = @convention(c) (pid_t) -> pid_t
let responsibleFunction: ResponsibleFunction? = {
  guard let handle = dlopen(nil, RTLD_LAZY), let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else { return nil }
  return unsafeBitCast(symbol, to: ResponsibleFunction.self)
}()
func identity(_ pid: pid_t) throws -> (Int64, pid_t) {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
    throw SourceFailure("identity pid \(pid): \(errno)")
  }
  return (Int64(info.pbi_start_tvsec) * 1_000_000 + Int64(info.pbi_start_tvusec), pid_t(info.pbi_ppid))
}
func executable(_ pid: pid_t) throws -> String {
  var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { throw SourceFailure("path pid \(pid): \(errno)") }
  return String(cString: bytes)
}
func processList() throws -> [AudioObjectID] {
  try checkFault("list")
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { throw SourceFailure("process list size") }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &objects) == noErr else { throw SourceFailure("process list") }
  return Array(objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}
func sourceValue<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) throws -> T {
  var addr = address(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
  guard status == noErr else { throw SourceFailure("property \(selector) object \(object): \(status)") }
  return value
}
func readSources() throws -> [Source] {
  var table: [Source] = []
  for object in try processList() {
    do {
      try checkFault("pid")
      let pid = try sourceValue(object, kAudioProcessPropertyPID, pid_t(0))
      let firstIdentity = try? identity(pid)
      try checkFault("bundle")
      let ref = try sourceValue(object, kAudioProcessPropertyBundleID, Unmanaged<CFString>?.none)
      let bundle = ref.map { $0.takeRetainedValue() as String } ?? ""
      try checkFault("path")
      let path = try executable(pid)
      let output = try sourceValue(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) == 1
      var s = Source(object: object, pid: pid, bundle: bundle, path: path, runningOutput: output)
      // Metadata errors outside approved roots do not widen inclusion.
      if let first = firstIdentity, let last = try? identity(pid) {
        guard first.0 == last.0 else { throw SourceFailure("identity changed while reading pid \(pid)") }
        s.start = first.0; s.parent = first.1
      }
      table.append(s)
    } catch {
      // A disappearing process/object is normal; a failed read of a live one isn't.
      if !(try processList()).contains(object) { continue }
      if let pid = try? sourceValue(object, kAudioProcessPropertyPID, pid_t(0)), kill(pid, 0) != 0 && errno == ESRCH { continue }
      throw error
    }
  }
  let roots = table.filter { approveBundles.contains($0.bundle) || neverBundles.contains($0.bundle) }.compactMap { appRoot($0.path) }
  var ancestors: [pid_t: Source] = [:]
  for index in table.indices {
    let s = table[index]
    guard approveBundles.contains(s.bundle) || roots.contains(where: { inside(s.path, $0) }) else { continue }
    do {
      try checkFault("start")
      let value = try identity(s.pid)
      try checkFault("parent")
      guard s.start == value.0 else { throw SourceFailure("identity changed before attribution pid \(s.pid)") }
      table[index].parent = value.1
      if let responsible = responsibleFunction {
        try checkFault("responsible")
        errno = 0
        let pid = responsible(s.pid)
        if pid < 0 { throw SourceFailure("responsible pid \(s.pid): \(errno)") }
        if pid > 0 {
          let id = try identity(pid)
          table[index].responsible = pid
          table[index].responsibleStart = id.0
        }
      }
      var child = table[index]
      var visited = Set<pid_t>()
      while child.parent > 1 && visited.insert(child.pid).inserted {
        let value = try identity(child.parent)
        let parent = Source(pid: child.parent, start: value.0, parent: value.1)
        if parent.start > child.start { break }
        // Don't replace the full audio-process entry with an ancestry-only entry.
        if !table.contains(where: { $0.pid == parent.pid }) { ancestors[parent.pid] = parent }
        child = parent
      }
    } catch {
      if kill(s.pid, 0) != 0 && errno == ESRCH { table[index].vanished = true; continue }
      throw error
    }
  }
  return table + Array(ancestors.values)
}

if let file = sourcesFixture {
  do {
    let fixture = try JSONDecoder().decode(SourceFixture.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
    let resolveFixture = { try resolve($0, approved: Set(fixture.approved), never: Set(fixture.never), excluded: Set(fixture.excludePids ?? [])) }
    var result = try resolveFixture(fixture.processes)
    var attribution = Attribution()
    var latched = false
    for step in fixture.timeline ?? [] {
      result = try resolveFixture(step.processes)
      latched = latched || attribution.latch(result, at: step.at)
    }
    emit(["type": "sources", "included": result.included.map { $0.object }, "micOnly": result.micOnly, "unattributed": result.unattributed, "latched": latched])
    exit(0)
  } catch { fail("source-check-failed", "\(error)") }
}
if sourcesOnly {
  do {
    for s in try readSources() {
      emit(["type": "source", "object": s.object, "pid": s.pid, "bundle": s.bundle, "path": s.path, "start": s.start, "output": s.runningOutput])
    }
    exit(0)
  } catch { fail("source-check-failed", "\(error)") }
}
if outPath.isEmpty { fail("bad-args", "--out is required") }

// MARK: one side of the call, resampled to 16 kHz mono

final class Track {
  let lock = NSLock()
  var samples: [Float] = []
  var discarded = false
  func discard() {
    lock.lock(); defer { lock.unlock() }
    discarded = true; samples.removeAll(); level = 0; startOffset = nil
  }
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
    defer { lock.unlock() }
    guard !discarded else { return }
    if startOffset == nil { startOffset = max(0, Date().timeIntervalSince(start) - Double(n) / rate) }
    samples.append(contentsOf: UnsafeBufferPointer(start: out.floatChannelData![0], count: got))
    level = max(level * 0.6, (sumSq / Float(n)).squareRoot())
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

// The tap's stream is the IOProc's last input stream (any sub-device streams come first): one
// buffer when interleaved, one per channel otherwise. nil when the layout doesn't match the tap.
func tapBuffer(_ inData: UnsafePointer<AudioBufferList>, _ format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let all = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
  let need = format.isInterleaved ? 1 : Int(format.channelCount)
  let perBuffer = format.isInterleaved ? format.channelCount : 1
  guard all.count >= need else { return nil }
  let picked = all.suffix(need)
  guard picked.allSatisfy({ $0.mData != nil && $0.mNumberChannels == perBuffer }) else { return nil }
  let list = AudioBufferList.allocate(maximumBuffers: need)
  for (i, b) in picked.enumerated() { list[i] = b }
  return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer) { _ in free(list.unsafeMutablePointer) }
}
var tapUnreadable = false  // ioQueue only
func tapIO(_ inData: UnsafePointer<AudioBufferList>, _ format: AVAudioFormat) {
  guard !tapUnreadable else { return }
  guard let buf = tapBuffer(inData, format) else {
    // Never drop system audio silently: fail once through the A2.5 stop path.
    tapUnreadable = true
    let n = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData)).map { $0.mNumberChannels }
    DispatchQueue.main.async { sourceFailure(SourceFailure("unreadable tap buffers \(n) for \(format)")) }
    return
  }
  them.append(buf, channel: nil, since: start)
}

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

// MARK: lifecycle — all control transitions run on the main queue.
let engine = AVAudioEngine()
let ioQueue = DispatchQueue(label: "capture.tap")
var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)
var ioProc: AudioDeviceIOProcID?
var tapDesc: CATapDescription?
var tapFormat: AVAudioFormat?
var started = false
var stopping = false
var micInstalled = false
var micOnly = false
var attribution = Attribution()
var watched = Set<AudioObjectID>()
var listWatched = false
var levelTimer: DispatchSourceTimer?
let listListener: AudioObjectPropertyListenerBlock = { _, _ in refreshSources() }
let outputListener: AudioObjectPropertyListenerBlock = { _, _ in refreshSources() }

func removeSourceListeners() {
  var addr = address(kAudioProcessPropertyIsRunningOutput)
  for object in watched { AudioObjectRemovePropertyListenerBlock(object, &addr, .main, outputListener) }
  watched.removeAll()
  if listWatched {
    var list = address(kAudioHardwarePropertyProcessObjectList)
    AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &list, .main, listListener)
    listWatched = false
  }
}
func teardownTap() {
  if let p = ioProc {
    AudioDeviceStop(aggregateID, p)
    AudioDeviceDestroyIOProcID(aggregateID, p)
    ioProc = nil
  }
  if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID); aggregateID = AudioObjectID(kAudioObjectUnknown) }
  if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = AudioObjectID(kAudioObjectUnknown) }
}
func discardThem() {
  // Set under the same lock as the final append. An in-flight conversion cannot
  // append after discard, even if it finishes after device teardown.
  them.discard()
  teardownTap()
  removeSourceListeners()
}
func latchMicOnly() {
  guard !micOnly else { return }
  micOnly = true
  discardThem()
  emit(["type": "notice", "code": "mic-only"])
}
func sourceFailure(_ error: Error) {
  guard !stopping else { return }
  discardThem()
  emit(["type": "error", "code": "source-check-failed", "detail": "\(error)"])
  if started { stop() } else { exit(2) }
}
func registerOutputs(_ table: [Source]) throws {
  let objects = Set(table.filter { $0.object != 0 && $0.vanished != true }.map { $0.object })
  var addr = address(kAudioProcessPropertyIsRunningOutput)
  for object in watched.subtracting(objects) { AudioObjectRemovePropertyListenerBlock(object, &addr, .main, outputListener) }
  watched.formIntersection(objects)
  for object in objects.subtracting(watched) {
    try checkFault("output-listener")
    let status = AudioObjectAddPropertyListenerBlock(object, &addr, .main, outputListener)
    if status != noErr {
      if !(try processList()).contains(object) { continue }
      throw SourceFailure("output listener: \(status)")
    }
    watched.insert(object)
  }
}
func setApprovedDescription(initial: Bool) throws -> Decision {
  for attempt in 0..<2 {
    let table = try readSources()
    let decision = try resolve(table, approved: approveBundles, never: neverBundles, excluded: Set(excludePids + [getpid()]))
    if initial && decision.micOnly { return decision }
    try registerOutputs(table)
    let description = CATapDescription(stereoMixdownOfProcesses: decision.included.map { $0.object })
    description.uuid = tapDesc?.uuid ?? UUID()
    description.isPrivate = true
    description.muteBehavior = .unmuted
    if initial && tapID == kAudioObjectUnknown {
      try checkFault("tap")
      let status = AudioHardwareCreateProcessTap(description, &tapID)
      if status != noErr { throw SourceFailure("create tap: \(status)") }
    }
    try checkFault("description")
    var addr = address(kAudioTapPropertyDescription)
    var ref = Unmanaged.passUnretained(description)
    let status = AudioObjectSetPropertyData(tapID, &addr, 0, nil, UInt32(MemoryLayout<Unmanaged<CATapDescription>>.size), &ref)
    if status != noErr { throw SourceFailure("tap description: \(status)") }
    tapDesc = description
    try checkFault("identity")
    let stable = decision.included.allSatisfy { s in
      guard let pid = try? sourceValue(s.object, kAudioProcessPropertyPID, pid_t(0)), pid == s.pid,
            let id = try? identity(pid) else { return false }
      return id.0 == s.start
    }
    if stable { return decision }
    if attempt == 1 { throw SourceFailure("source identity changed twice") }
  }
  throw SourceFailure("source identity")
}
func observeAttribution(_ decision: Decision) {
  if attribution.latch(decision, at: Date().timeIntervalSinceReferenceDate) { latchMicOnly() }
}
func refreshSources() {
  guard approvedOnly && !micOnly && !stopping else { return }
  do { observeAttribution(try setApprovedDescription(initial: false)) }
  catch { sourceFailure(error) }
}
func startSystemAudio() throws {
  if approvedOnly {
    // No process can qualify for these approvals; avoid touching system audio.
    if approveBundles.subtracting(sharedCallApps).isEmpty { latchMicOnly(); return }
    try checkFault("process-list-listener")
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, .main, listListener)
    if status != noErr { throw SourceFailure("process-list listener: \(status)") }
    listWatched = true
    let decision = try setApprovedDescription(initial: true)
    if decision.micOnly { latchMicOnly(); return }
    observeAttribution(decision)
  } else {
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludePids.compactMap(processObject(for:)))
    description.uuid = UUID(); description.isPrivate = true; description.muteBehavior = .unmuted
    tapDesc = description
    let status = AudioHardwareCreateProcessTap(description, &tapID)
    if status != noErr { throw SourceFailure("Could not tap system audio (\(status))") }
  }
  var formatAddr = address(kAudioTapPropertyFormat)
  var asbd = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  let formatStatus = AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &size, &asbd)
  guard formatStatus == noErr, let format = AVAudioFormat(streamDescription: &asbd), let description = tapDesc else { throw SourceFailure("tap format") }
  tapFormat = format
  // Tap only: an output sub-device that also has inputs (headsets, BlackHole, meeting devices)
  // would add its own input streams to every IOProc call.
  let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "quietpls-capture tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
  ]
  if approvedOnly { try checkFault("aggregate") }
  var status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
  if status != noErr { throw SourceFailure("create aggregate: \(status)") }
  status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, ioQueue) { _, inData, _, _, _ in tapIO(inData, format) }
  if status != noErr { throw SourceFailure("tap IO: \(status)") }
  // No first sample until the include-list identity has been checked.
  if approvedOnly { _ = try setApprovedDescription(initial: false) }
  status = AudioDeviceStart(aggregateID, ioProc)
  if status != noErr { throw SourceFailure("start tap: \(status)") }
}
func stop() {
  if stopping { return }
  stopping = true
  levelTimer?.cancel()
  removeSourceListeners()
  if micInstalled { engine.inputNode.removeTap(onBus: 0); micInstalled = false }
  engine.stop()
  teardownTap()
  do {
    let r = try writeWav()
    emit(["type": "saved", "path": outPath, "seconds": Double(r.frames) / sampleRate,
          "youPeak": Double(r.youPeak), "themPeak": Double(r.themPeak), "themDiscarded": them.discarded])
    exit(0)
  } catch { fail("write-failed", "\(error)") }
}
func revoke() { discardThem(); stop() }

signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGUSR1, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let sigrevoke = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
sigint.setEventHandler(handler: stop); sigterm.setEventHandler(handler: stop)
sigrevoke.setEventHandler {
  if revokeFixture {
    discardThem()
    appendFixture(seconds: 1) // callbacks still in flight after the discard
    stop()
  } else { revoke() }
}
sigint.resume(); sigterm.resume(); sigrevoke.resume()

func appendFixture(seconds: Int) {
  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
  let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * Int(sampleRate)))!
  buf.frameLength = buf.frameCapacity
  for i in 0..<Int(buf.frameLength) { buf.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / sampleRate)) * 0.3 }
  you.append(buf, channel: 0, since: start)
  them.append(buf, channel: 0, since: start)
}
if revokeFixture {
  appendFixture(seconds: 2)
  kill(getpid(), SIGUSR1)
  dispatchMain()
}
if let mode = buffersFixture {
  // 1 s of IOProc calls as an aggregate with an in/out sub-device delivers them: the sub-device's
  // input stream (1000 Hz, 0.9) ahead of the tap's (440 Hz, 0.3). "bad" gives the tap's stream 1 channel.
  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true)!
  let frames = 480
  let other = UnsafeMutablePointer<Float>.allocate(capacity: frames * 2)
  let tap = UnsafeMutablePointer<Float>.allocate(capacity: frames * 2)
  let list = AudioBufferList.allocate(maximumBuffers: 2)
  list[0] = AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(frames * 8), mData: other)
  list[1] = AudioBuffer(mNumberChannels: mode == "bad" ? 1 : 2, mDataByteSize: UInt32(frames * 8), mData: tap)
  for call in 0..<100 {
    for i in 0..<frames {
      let t = Double(call * frames + i) / 48000
      other[2 * i] = Float(0.9 * sin(2 * .pi * 1000 * t)); other[2 * i + 1] = other[2 * i]
      tap[2 * i] = Float(0.3 * sin(2 * .pi * 440 * t)); tap[2 * i + 1] = tap[2 * i]
    }
    ioQueue.sync { tapIO(list.unsafePointer, format) }
  }
  started = true
  DispatchQueue.main.async { stop() }  // after any failure tapIO queued
  dispatchMain()
}

let mic = AVCaptureDevice.authorizationStatus(for: .audio)
if mic == .notDetermined {
  let sem = DispatchSemaphore(value: 0)
  AVCaptureDevice.requestAccess(for: .audio) { _ in sem.signal() }; sem.wait()
}
if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { fail("mic-denied", "Microphone access is off for this app") }
do { try startSystemAudio() } catch {
  if approvedOnly { sourceFailure(error) }
  teardownTap(); fail("system-audio-unavailable", "\(error)")
}
let input = engine.inputNode
if voiceProcessing {
  do {
    try input.setVoiceProcessingEnabled(true)
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
  } catch { emit(["type": "warning", "code": "no-echo-cancel", "detail": "\(error)"]) }
}
let micFormat = input.outputFormat(forBus: 0)
if micFormat.channelCount == 0 { teardownTap(); fail("mic-unavailable", "No microphone input found") }
input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buf, _ in you.append(buf, channel: 0, since: start) }
micInstalled = true
do { try engine.start() } catch { teardownTap(); fail("mic-unavailable", "Could not start the microphone: \(error)") }
started = true
faultArmed = true
emit(["type": "started", "micRate": micFormat.sampleRate, "micChannels": micFormat.channelCount,
      "tapRate": tapFormat?.sampleRate ?? 0, "tapChannels": tapFormat?.channelCount ?? 0, "echoCancel": input.isVoiceProcessingEnabled])
let timer = DispatchSource.makeTimerSource(queue: .main)
levelTimer = timer
timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
timer.setEventHandler {
  // Recheck the debounce even if the running-output property hasn't changed.
  // Source-list listeners do the immediate resolution; this also catches read failures.
  refreshSources()
  emit(["type": "level", "you": Double(you.takeLevel()), "them": Double(them.takeLevel()), "seconds": Date().timeIntervalSince(start)])
}
timer.resume()
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
  var byte: UInt8 = 0
  if read(STDIN_FILENO, &byte, 1) <= 0 { stdinSource.cancel(); stop() }
}
stdinSource.resume()
dispatchMain()
