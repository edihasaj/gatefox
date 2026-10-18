@preconcurrency import Foundation
import Darwin

/// A deliberately separate runner for the bundled app-management backend. It
/// never falls back to the installed CLI because management protocol versions
/// are bundled with this app.
actor GatewayManagementCommand: GatewayManagementRunning {
    private static let maximumInputBytes = 128 * 1_024
    private static let maximumOutputBytes = 2 * 1_024 * 1_024
    private static let drainGraceNanoseconds: UInt64 = 250_000_000

    private let homeDirectory: URL
    private let resourceDirectory: URL?
    private var current: RunningManagementProcess?
    private var currentTask: Task<ManagementResponse, Never>?
    private var currentID: UUID?

    init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser, resourceDirectory: URL? = Bundle.main.resourceURL) {
        self.homeDirectory = homeDirectory
        self.resourceDirectory = resourceDirectory
    }

    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        guard !Task.isCancelled, current == nil, let command = resolvedCommand,
              let input = try? JSONEncoder().encode(request), input.count <= Self.maximumInputBytes else {
            return Self.failure(Task.isCancelled ? "cancelled" : "management_unavailable")
        }

        let control = RunningManagementProcess()
        let id = UUID()
        let homeDirectory = self.homeDirectory
        let task = Task.detached(priority: .userInitiated) {
            Self.execute(executable: command.executable, arguments: command.arguments, input: input,
                         homeDirectory: homeDirectory, timeoutSeconds: timeoutSeconds, control: control)
        }
        current = control
        currentTask = task
        currentID = id

        let result = await withTaskCancellationHandler(operation: { await task.value }, onCancel: { control.cancel() })
        clear(control, id: id)
        return Task.isCancelled ? Self.failure("cancelled") : result
    }

    func cancel() async {
        guard let control = current, let task = currentTask else { return }
        control.cancel()
        _ = await task.value
        if current === control, currentTask != nil { current = nil; currentTask = nil; currentID = nil }
    }

    private func clear(_ control: RunningManagementProcess, id: UUID) {
        guard current === control, currentID == id else { return }
        current = nil
        currentTask = nil
        currentID = nil
    }

    private var resolvedCommand: (executable: String, arguments: [String])? {
        guard let resourceDirectory else { return nil }
        let node = resourceDirectory.appending(path: "backend/runtime/bin/node").path
        let script = resourceDirectory.appending(path: "management/dist/app-management.js").path
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.isReadableFile(atPath: script) else { return nil }
        return (node, [script])
    }

    private static func execute(executable: String, arguments: [String], input: Data, homeDirectory: URL,
                                timeoutSeconds: Double, control: RunningManagementProcess) -> ManagementResponse {
        // This timestamp deliberately predates launch and all pipe I/O.
        let deadline = deadline(after: max(0.01, timeoutSeconds))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = homeDirectory
        process.environment = safeEnvironment(homeDirectory: homeDirectory)
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        guard (try? process.run()) != nil else { return failure("management_unavailable") }

        let pid = process.processIdentifier
        control.install(process, ownsGroup: establishOwnedProcessGroup(pid))
        closeChildPipeEnds(stdin: stdin, stdout: stdout, stderr: stderr)
        let inputHandle = stdin.fileHandleForWriting
        let inputDescriptor = inputHandle.fileDescriptor
        let outputDescriptor = stdout.fileHandleForReading.fileDescriptor
        let errorDescriptor = stderr.fileHandleForReading.fileDescriptor
        setNonBlocking(inputDescriptor)
        setNoSigPipe(inputDescriptor)
        setNonBlocking(outputDescriptor)
        setNonBlocking(errorDescriptor)
        defer {
            control.clear(process)
            closeAllPipeEnds(stdin: stdin, stdout: stdout, stderr: stderr)
        }

        guard !control.isCancelled else {
            stopAndReap(process, control: control)
            return failure("cancelled")
        }

        var inputOffset = 0
        var inputClosed = false
        var output: Data? = Data()
        var discardedError: Data?
        var outputExceeded = false
        var outputClosed = false
        var errorClosed = false
        var drainDeadline: UInt64?
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            if control.isCancelled {
                stopAndReap(process, control: control)
                return failure("cancelled")
            }
            if now >= deadline {
                stopAndReap(process, control: control)
                return failure("timed_out")
            }

            // Four chunks per descriptor prevents output from starving stdin.
            let outputRead = drain(outputDescriptor, into: &output, captureLimit: maximumOutputBytes)
            outputExceeded = outputExceeded || outputRead.exceededCaptureLimit
            outputClosed = outputClosed || outputRead.reachedEnd
            let errorRead = drain(errorDescriptor, into: &discardedError, captureLimit: 0)
            errorClosed = errorClosed || errorRead.reachedEnd
            if outputExceeded {
                stopAndReap(process, control: control)
                return failure("invalid_response")
            }

            if !inputClosed {
                let writeResult = writeInput(inputDescriptor, input: input, offset: &inputOffset)
                if writeResult.shouldClose || inputOffset == input.count {
                    try? inputHandle.close()
                    inputClosed = true
                }
            }

            let afterIO = DispatchTime.now().uptimeNanoseconds
            if !process.isRunning {
                if drainDeadline == nil { drainDeadline = min(deadline, afterIO &+ drainGraceNanoseconds) }
                if (outputClosed && errorClosed) || afterIO >= drainDeadline! {
                    guard process.terminationStatus == 0,
                          let decoded = try? JSONDecoder().decode(ManagementResponse.self, from: output ?? Data()),
                          let safe = validated(decoded) else { return failure("invalid_response") }
                    return safe
                }
            }
            waitForIO(inputDescriptor: inputClosed ? nil : inputDescriptor,
                      outputDescriptor: outputClosed ? nil : outputDescriptor,
                      errorDescriptor: errorClosed ? nil : errorDescriptor,
                      deadline: drainDeadline ?? deadline)
        }
    }

    private static func validated(_ response: ManagementResponse) -> ManagementResponse? {
        if response.ok { return response.result == nil || response.error != nil ? nil : response }
        guard let error = response.error, response.result == nil else { return nil }
        return ManagementResponse.failure(error.code, message: safeMessage(for: error.code))
    }

    private static func failure(_ code: String) -> ManagementResponse {
        ManagementResponse.failure(code, message: safeMessage(for: code))
    }

    static func safeMessage(for code: String) -> String {
        switch code {
        case "cancelled": return "The connection operation was cancelled."
        case "timed_out": return "The connection operation took too long. Try again."
        case "configuration_changed": return "Gateway settings changed. Refresh and try again."
        case "auth_failed": return "Sign-in did not complete. Try again."
        case "discovery_failed": return "Models could not be discovered. Check the connection and try again."
        case "missing_cli": return "A required provider command is unavailable."
        case "external_credential": return "This connection uses externally managed credentials."
        case "management_unavailable": return "Connection management is unavailable in this app bundle."
        default: return "The gateway could not complete that connection change."
        }
    }

    private static func safeEnvironment(homeDirectory: URL) -> [String: String] {
        let user = NSUserName()
        return ["HOME": homeDirectory.path, "LOGNAME": user,
                "PATH": "\(homeDirectory.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": "/tmp", "USER": user]
    }

    private static func deadline(after seconds: Double) -> UInt64 {
        DispatchTime.now().uptimeNanoseconds &+ UInt64((seconds * 1_000_000_000).rounded(.up))
    }

    private static func establishOwnedProcessGroup(_ pid: pid_t) -> Bool {
        guard pid > 0, pid != getpgrp() else { return false }
        _ = setpgid(pid, pid)
        return getpgid(pid) == pid
    }

    private static func closeChildPipeEnds(stdin: Pipe, stdout: Pipe, stderr: Pipe) {
        try? stdin.fileHandleForReading.close()
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
    }

    private static func closeAllPipeEnds(stdin: Pipe, stdout: Pipe, stderr: Pipe) {
        try? stdin.fileHandleForReading.close()
        try? stdin.fileHandleForWriting.close()
        try? stdout.fileHandleForReading.close()
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForReading.close()
        try? stderr.fileHandleForWriting.close()
    }

    private static func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0 else { return }
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    }

    private static func setNoSigPipe(_ descriptor: Int32) {
        var enabled: Int32 = 1
        _ = fcntl(descriptor, F_SETNOSIGPIPE, &enabled)
    }

    private struct DrainResult { var reachedEnd = false; var exceededCaptureLimit = false }
    private struct WriteResult { var shouldClose = false }

    private static func drain(_ descriptor: Int32, into captured: inout Data?, captureLimit: Int) -> DrainResult {
        var result = DrainResult()
        var buffer = [UInt8](repeating: 0, count: 16 * 1_024)
        for _ in 0..<4 {
            let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
            if count > 0 {
                guard captureLimit > 0 else { continue }
                let bytes = buffer.prefix(Int(count))
                let remaining = max(0, captureLimit - (captured?.count ?? 0))
                if bytes.count > remaining { result.exceededCaptureLimit = true }
                if remaining > 0 { captured?.append(contentsOf: bytes.prefix(remaining)) }
                continue
            }
            if count == 0 { result.reachedEnd = true }
            if count < 0 && errno == EINTR { continue }
            return result
        }
        return result
    }

    private static func writeInput(_ descriptor: Int32, input: Data, offset: inout Int) -> WriteResult {
        guard offset < input.count else { return WriteResult(shouldClose: true) }
        let count = min(16 * 1_024, input.count - offset)
        let written = input.withUnsafeBytes { bytes in write(descriptor, bytes.baseAddress!.advanced(by: offset), count) }
        if written > 0 {
            offset += Int(written)
            return WriteResult(shouldClose: offset == input.count)
        }
        if written < 0 && errno == EINTR { return WriteResult() }
        return WriteResult(shouldClose: written < 0 && (errno == EPIPE || (errno != EAGAIN && errno != EWOULDBLOCK)))
    }

    private static func waitForIO(inputDescriptor: Int32?, outputDescriptor: Int32?, errorDescriptor: Int32?, deadline: UInt64) {
        var descriptors = [pollfd]()
        if let inputDescriptor { descriptors.append(pollfd(fd: inputDescriptor, events: Int16(POLLOUT), revents: 0)) }
        if let outputDescriptor { descriptors.append(pollfd(fd: outputDescriptor, events: Int16(POLLIN), revents: 0)) }
        if let errorDescriptor { descriptors.append(pollfd(fd: errorDescriptor, events: Int16(POLLIN), revents: 0)) }
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline else { return }
        let milliseconds = Int32(min(10, max(1, (deadline - now + 999_999) / 1_000_000)))
        _ = poll(&descriptors, nfds_t(descriptors.count), milliseconds)
    }

    private static func stopAndReap(_ process: Process, control: RunningManagementProcess) {
        guard process.isRunning else { return }
        control.stop()
        if process.isRunning { process.waitUntilExit() }
    }
}

private final class RunningManagementProcess: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var ownsGroup = false
    private var cancelled = false
    private var stopping = false

    var isCancelled: Bool { lock.withLock { cancelled } }

    func install(_ process: Process, ownsGroup: Bool) {
        let shouldStop = lock.withLock { () -> Bool in
            self.process = process
            self.ownsGroup = ownsGroup
            return cancelled
        }
        if shouldStop { stop() }
    }

    func clear(_ process: Process) {
        lock.withLock {
            guard self.process === process else { return }
            self.process = nil
            ownsGroup = false
        }
    }

    func cancel() {
        let shouldStop = lock.withLock { () -> Bool in
            cancelled = true
            return process != nil
        }
        if shouldStop { stop() }
    }

    func stop() {
        let target = lock.withLock { () -> pid_t? in
            guard let process, !stopping else { return nil }
            stopping = true
            return ownsGroup ? -process.processIdentifier : process.processIdentifier
        }
        guard let target else { return }
        defer { lock.withLock { stopping = false } }
        _ = kill(target, SIGTERM)
        let until = DispatchTime.now().uptimeNanoseconds &+ 150_000_000
        while DispatchTime.now().uptimeNanoseconds < until {
            if kill(target, 0) != 0 && errno == ESRCH { return }
            usleep(10_000)
        }
        _ = kill(target, SIGKILL)
    }
}
