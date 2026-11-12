@preconcurrency import Foundation
import Darwin

struct GatewayUpdateRequest: Codable, Sendable, Equatable {
    let operation: String
    let configPath: String
    let automatic: Bool?
}
struct GatewayUpdateResult: Codable, Sendable, Equatable {
    let automatic: Bool
    let currentVersion: String
    let latestVersion: String?
    let available: Bool
    let phase: String
    let message: String
    let lastChecked: String?
}

struct GatewayUpdateError: Codable, Sendable, Equatable {
    let code: String
    let message: String
}

struct GatewayUpdateResponse: Codable, Sendable, Equatable {
    let ok: Bool
    let result: GatewayUpdateResult?
    let error: GatewayUpdateError?

    static func failure(_ code: String) -> Self {
        .init(ok: false, result: nil, error: .init(code: code, message: ""))
    }
}

protocol GatewayUpdateRunning: Sendable {
    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse
    func cancel() async
}

/// The app's bounded bridge to the bundled update backend. It does not inherit
/// environment credentials, invoke a shell, or reveal child output.
actor GatewayUpdatesCommand: GatewayUpdateRunning {
    private static let maximumInputBytes = 16 * 1_024
    private static let maximumOutputBytes = 64 * 1_024

    private let resourceDirectory: URL?
    private var current: UpdateProcessControl?
    private var currentTask: Task<GatewayUpdateResponse, Never>?

    init(resourceDirectory: URL? = Bundle.main.resourceURL) {
        self.resourceDirectory = resourceDirectory
    }

    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse {
        guard current == nil, request.configPath.hasPrefix("/"),
              URL(fileURLWithPath: request.configPath).pathExtension.lowercased() == "json",
              let input = try? JSONEncoder().encode(request), input.count <= Self.maximumInputBytes,
              let command = resolvedCommand else {
            return .failure("updates_unavailable")
        }
        let control = UpdateProcessControl()
        let task = Task.detached(priority: .userInitiated) {
            Self.execute(command: command, input: input, timeout: timeout, control: control)
        }
        current = control
        currentTask = task
        let response = await withTaskCancellationHandler(
            operation: { await task.value },
            onCancel: { control.cancel() }
        )
        if current === control {
            current = nil
            currentTask = nil
        }
        return Task.isCancelled ? .failure("cancelled") : response
    }

    func cancel() async {
        guard let control = current, let task = currentTask else { return }
        control.cancel()
        _ = await task.value
        if current === control {
            current = nil
            currentTask = nil
        }
    }

    private var resolvedCommand: (node: String, script: String)? {
        guard let resourceDirectory else { return nil }
        let node = resourceDirectory.appending(path: "backend/runtime/bin/node").path
        let script = resourceDirectory.appending(path: "management/dist/app-updates.js").path
        guard FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.isReadableFile(atPath: script) else { return nil }
        return (node, script)
    }

    private static func execute(
        command: (node: String, script: String),
        input: Data,
        timeout: Duration,
        control: UpdateProcessControl
    ) -> GatewayUpdateResponse {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.node)
        process.arguments = [command.script]
        process.environment = safeEnvironment()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        guard (try? process.run()) != nil else { return .failure("updates_unavailable") }

        control.install(process, ownsGroup: establishOwnedProcessGroup(process.processIdentifier))
        try? stdin.fileHandleForReading.close()
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
        defer {
            control.clear(process)
            try? stdin.fileHandleForWriting.close()
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
        }

        let inputDescriptor = stdin.fileHandleForWriting.fileDescriptor
        let outputDescriptor = stdout.fileHandleForReading.fileDescriptor
        let errorDescriptor = stderr.fileHandleForReading.fileDescriptor
        setNonBlocking(inputDescriptor)
        setNonBlocking(outputDescriptor)
        setNonBlocking(errorDescriptor)
        setNoSigPipe(inputDescriptor)

        let deadline = deadline(after: timeout)
        var inputOffset = 0
        var inputClosed = false
        var output = Data()
        var outputClosed = false
        var errorClosed = false
        while true {
            if control.isCancelled {
                stopAndReap(process, control: control)
                return .failure("cancelled")
            }
            if DispatchTime.now().uptimeNanoseconds >= deadline {
                stopAndReap(process, control: control)
                return .failure("timed_out")
            }
            let read = drain(outputDescriptor, into: &output, limit: maximumOutputBytes)
            outputClosed = outputClosed || read.closed
            if read.exceeded {
                stopAndReap(process, control: control)
                return .failure("invalid_response")
            }
            errorClosed = errorClosed || discard(errorDescriptor)
            if !inputClosed {
                inputClosed = writeInput(inputDescriptor, input: input, offset: &inputOffset)
                if inputClosed { try? stdin.fileHandleForWriting.close() }
            }
            if !process.isRunning {
                let drainDeadline = min(deadline, DispatchTime.now().uptimeNanoseconds + 250_000_000)
                while !outputClosed || !errorClosed {
                    let final = drain(outputDescriptor, into: &output, limit: maximumOutputBytes)
                    if final.exceeded { return .failure("invalid_response") }
                    outputClosed = outputClosed || final.closed
                    errorClosed = errorClosed || discard(errorDescriptor)
                    if outputClosed && errorClosed { break }
                    if DispatchTime.now().uptimeNanoseconds >= drainDeadline {
                        control.stop()
                        break
                    }
                    waitForIO(outputClosed ? nil : outputDescriptor, errorClosed ? nil : errorDescriptor, nil)
                }
                guard process.terminationStatus == 0,
                      let response = try? JSONDecoder().decode(GatewayUpdateResponse.self, from: output) else {
                    return .failure("invalid_response")
                }
                return validated(response)
            }
            waitForIO(inputClosed ? nil : inputDescriptor, outputClosed ? nil : outputDescriptor, errorClosed ? nil : errorDescriptor)
        }
    }

    private static func validated(_ response: GatewayUpdateResponse) -> GatewayUpdateResponse {
        if response.ok {
            guard let result = response.result, response.error == nil,
                  !result.currentVersion.isEmpty, !result.phase.isEmpty else { return .failure("invalid_response") }
            return response
        }
        guard response.result == nil, let error = response.error, !error.code.isEmpty else {
            return .failure("invalid_response")
        }
        return .failure(error.code)
    }

    private static func safeEnvironment() -> [String: String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "HOME": home, "LOGNAME": NSUserName(), "USER": NSUserName(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": "/tmp"
        ]
    }

    private static func establishOwnedProcessGroup(_ pid: pid_t) -> Bool {
        guard pid > 0, pid != getpgrp() else { return false }
        _ = setpgid(pid, pid)
        return getpgid(pid) == pid
    }

    private static func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL)
        if flags >= 0 { _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) }
    }

    private static func setNoSigPipe(_ descriptor: Int32) {
        var enabled: Int32 = 1
        _ = fcntl(descriptor, F_SETNOSIGPIPE, &enabled)
    }

    private static func drain(_ descriptor: Int32, into data: inout Data, limit: Int) -> (closed: Bool, exceeded: Bool) {
        var buffer = [UInt8](repeating: 0, count: 8 * 1_024)
        var closed = false
        for _ in 0..<4 {
            let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
            if count > 0 {
                let bytes = buffer.prefix(Int(count))
                guard data.count + bytes.count <= limit else { return (closed, true) }
                data.append(contentsOf: bytes)
            } else if count == 0 {
                closed = true
                break
            } else if errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK {
                closed = true
                break
            }
        }
        return (closed, false)
    }

    private static func discard(_ descriptor: Int32) -> Bool {
        var sink = Data()
        return drain(descriptor, into: &sink, limit: Int.max).closed
    }

    private static func writeInput(_ descriptor: Int32, input: Data, offset: inout Int) -> Bool {
        guard offset < input.count else { return true }
        let written = input.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), input.count - offset) }
        if written > 0 { offset += Int(written); return offset == input.count }
        return written < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK
    }

    private static func deadline(after timeout: Duration) -> UInt64 {
        let components = timeout.components
        let seconds = max(0.01, Double(components.seconds) + Double(components.attoseconds) / 1_000_000_000_000_000_000)
        return DispatchTime.now().uptimeNanoseconds + UInt64(seconds * 1_000_000_000)
    }

    private static func waitForIO(_ input: Int32?, _ output: Int32?, _ error: Int32?) {
        var descriptors = [pollfd]()
        if let input { descriptors.append(pollfd(fd: input, events: Int16(POLLOUT), revents: 0)) }
        if let output { descriptors.append(pollfd(fd: output, events: Int16(POLLIN), revents: 0)) }
        if let error { descriptors.append(pollfd(fd: error, events: Int16(POLLIN), revents: 0)) }
        _ = poll(&descriptors, nfds_t(descriptors.count), 10)
    }

    private static func stopAndReap(_ process: Process, control: UpdateProcessControl) {
        control.stop()
        if process.isRunning { process.waitUntilExit() }
    }
}

private final class UpdateProcessControl: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var ownsGroup = false
    private var cancelled = false

    var isCancelled: Bool { lock.withLock { cancelled } }

    func install(_ process: Process, ownsGroup: Bool) {
        let stop = lock.withLock {
            self.process = process
            self.ownsGroup = ownsGroup
            return cancelled
        }
        if stop { self.stop() }
    }

    func clear(_ process: Process) {
        lock.withLock {
            if self.process === process {
                self.process = nil
                ownsGroup = false
            }
        }
    }

    func cancel() {
        let stop = lock.withLock { cancelled = true; return process != nil }
        if stop { self.stop() }
    }

    func stop() {
        guard let target = lock.withLock({ () -> pid_t? in
            guard let process else { return nil }
            return ownsGroup ? -process.processIdentifier : process.processIdentifier
        }), target != 0 else { return }
        _ = kill(target, SIGTERM)
        usleep(100_000)
        if kill(target, 0) == 0 { _ = kill(target, SIGKILL) }
    }
}
