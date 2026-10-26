// mic-users — prints one line per process currently capturing audio input:
//   <pid>\t<bundle id>
// Read by meeting-detector.js to notice a call (another app took the mic).
// Uses CoreAudio process objects (macOS 14+); needs no mic permission.
import CoreAudio
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
}

func readValue<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = address(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

var listAddr = address(kAudioHardwarePropertyProcessObjectList)
var size: UInt32 = 0
let system = AudioObjectID(kAudioObjectSystemObject)
guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &size) == noErr else { exit(1) }
var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
guard AudioObjectGetPropertyData(system, &listAddr, 0, nil, &size, &processes) == noErr else { exit(1) }

var out = ""
for process in processes {
  guard readValue(process, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1,
    let pid = readValue(process, kAudioProcessPropertyPID, pid_t(0))
  else { continue }
  let ref = readValue(process, kAudioProcessPropertyBundleID, Unmanaged<CFString>?.none) ?? nil
  let bundle = ref.map { $0.takeRetainedValue() as String } ?? ""
  out += "\(pid)\t\(bundle)\n"
}
FileHandle.standardOutput.write(out.data(using: .utf8)!)
