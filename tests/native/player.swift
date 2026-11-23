// Development-only players for the native source-tap gate. Never packaged.
import AVFoundation
import Foundation

let args = CommandLine.arguments
func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
var children: [Process] = []
func launch(_ executable: String, _ arguments: [String]) {
  let child = Process()
  child.executableURL = URL(fileURLWithPath: executable)
  child.arguments = arguments
  try! child.run()
  children.append(child)
}
// The approved anchor opens a silent output stream so CoreAudio exposes it;
// only its differently identified helper produces marker A.
if let helper = option("--helper") {
  launch(helper, ["--frequency", "440", "--speech", option("--alpha")!])
}
if let unknown = option("--unknown"), let speech = option("--charlie") {
  let delay = Double(option("--delay") ?? "0")!
  DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
    launch(unknown, ["--frequency", "1600", "--speech", speech])
  }
}
let rate = 48000.0
let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
let count = Int(rate * 4)
let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
buffer.frameLength = buffer.frameCapacity
let frequency = Double(option("--frequency") ?? "0")!
for i in 0..<count { buffer.floatChannelData![0][i] = Float(sin(2 * .pi * frequency * Double(i) / rate)) * 0.12 }
if let speech = option("--speech") {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: speech))
  let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
  try file.read(into: input)
  let converter = AVAudioConverter(from: file.processingFormat, to: format)!
  let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(file.length) * rate / file.processingFormat.sampleRate + 64))!
  var sent = false
  var error: NSError?
  converter.convert(to: output, error: &error) { _, status in
    if sent { status.pointee = .endOfStream; return nil }
    sent = true; status.pointee = .haveData; return input
  }
  // Speech is broadband: notch it at the B/C markers so their per-window energy measures only marker tones.
  let speech = output.floatChannelData![0]
  for f0 in [1000.0, 1600.0] {
    let w = 2 * Double.pi * f0 / rate, alpha = sin(w) / 4, b0 = 1 / (1 + alpha), b1 = -2 * cos(w) * b0, a2 = (1 - alpha) * b0
    for _ in 0..<2 {
      var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
      for i in 0..<Int(output.frameLength) {
        let x = Double(speech[i]), y = b0 * x + b1 * x1 + b0 * x2 - b1 * y1 - a2 * y2
        x2 = x1; x1 = x; y2 = y1; y1 = y; speech[i] = Float(y)
      }
    }
  }
  for i in 0..<min(count, Int(output.frameLength)) { buffer.floatChannelData![0][i] += speech[i] * 0.6 }
}
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
player.scheduleBuffer(buffer, at: nil, options: .loops)
try engine.start(); player.play()
print("ready \(getpid()) \(Bundle.main.bundleIdentifier ?? "bundle-less")")
fflush(stdout)
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler {
  for child in children where child.isRunning { child.terminate() }
  player.stop(); engine.stop(); exit(0)
}
term.resume()
dispatchMain()
