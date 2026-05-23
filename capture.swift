import Foundation
import ScreenCaptureKit
import AVFoundation

enum CaptureError: Error, LocalizedError {
    case appNotFound(String)
    case noAudioContent

    var errorDescription: String? {
        switch self {
        case .appNotFound(let name): return "App not found: \(name)"
        case .noAudioContent: return "No audio content available"
        }
    }
}

class AudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private let sampleRate: Double = 16000
    private let outputHandle = FileHandle.standardOutput

    func listSources() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let apps = content.applications
            .filter { !$0.applicationName.isEmpty }
            .sorted { $0.applicationName.localizedCaseInsensitiveCompare($1.applicationName) == .orderedAscending }

        for app in apps {
            let json: [String: Any] = [
                "name": app.applicationName,
                "bundleID": app.bundleIdentifier,
                "pid": app.processID
            ]
            if let data = try? JSONSerialization.data(withJSONObject: json),
               let str = String(data: data, encoding: .utf8) {
                FileHandle.standardError.write(Data((str + "\n").utf8))
            }
        }
    }

    func startCapture(appName: String) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let app = content.applications.first(where: {
            $0.applicationName.localizedCaseInsensitiveCompare(appName) == .orderedSame
        }) else {
            throw CaptureError.appNotFound(appName)
        }

        let filter = SCContentFilter(desktopIndependentWindow: content.windows.first(where: {
            $0.owningApplication?.processID == app.processID
        }) ?? content.windows[0])

        // Use app-level filter: capture only this app's audio
        let appFilter = SCContentFilter(
            display: content.displays[0],
            including: [app],
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = Int(sampleRate)
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true

        // We don't need video
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        stream = SCStream(filter: appFilter, configuration: config, delegate: self)
        try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
        try await stream?.startCapture()

        // Log to stderr so stdout stays clean for PCM data
        FileHandle.standardError.write(Data("Capturing audio from: \(app.applicationName)\n".utf8))

        // Keep running
        await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in
            // Never resumes — runs until process is killed
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var data = Data(count: length)
        data.withUnsafeMutableBytes { ptr in
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: ptr.baseAddress!)
        }

        // ScreenCaptureKit outputs Float32 — convert to Int16 for Whisper
        let floatCount = length / MemoryLayout<Float32>.size
        let int16Data = data.withUnsafeBytes { rawPtr -> Data in
            let floats = rawPtr.bindMemory(to: Float32.self)
            var int16s = [Int16](repeating: 0, count: floatCount)
            for i in 0..<floatCount {
                let clamped = max(-1.0, min(1.0, floats[i]))
                int16s[i] = Int16(clamped * Float32(Int16.max))
            }
            return Data(bytes: &int16s, count: int16s.count * MemoryLayout<Int16>.size)
        }

        outputHandle.write(int16Data)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("Stream stopped: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

// MARK: - Main

let capture = AudioCapture()
let args = CommandLine.arguments

if args.contains("--list") {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        do {
            try await capture.listSources()
        } catch {
            FileHandle.standardError.write(Data("Error: \(error.localizedDescription)\n".utf8))
        }
        semaphore.signal()
    }
    semaphore.wait()
} else if args.count >= 2 {
    let appName = args[1]
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        do {
            try await capture.startCapture(appName: appName)
        } catch {
            FileHandle.standardError.write(Data("Error: \(error.localizedDescription)\n".utf8))
            semaphore.signal()
        }
    }
    semaphore.wait()
} else {
    FileHandle.standardError.write(Data("Usage: capture <app-name> | capture --list\n".utf8))
    exit(1)
}
