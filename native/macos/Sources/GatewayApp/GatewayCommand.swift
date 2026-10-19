@preconcurrency import Foundation
import Darwin

enum GatewayCommandOutcome: Sendable, Equatable {
    case success
    case failed
    case timedOut
}

struct GatewayCommandResult: Sendable, Equatable {
    let outcome: GatewayCommandOutcome
    let stdout: String

    static let failed = GatewayCommandResult(outcome: .failed, stdout: "")
}

protocol GatewayCommandRunning: Sendable {
    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult
    func hasTrustedCLI() async -> Bool
    func install(configPath: String) async -> GatewayCommandResult
    func associateBackgroundItem(configPath: String) async -> GatewayCommandResult
}

extension GatewayCommandRunning {
    func associateBackgroundItem(configPath: String) async -> GatewayCommandResult { .failed }
}

/// Runs only the gateway's fixed command surface. It deliberately does not inherit
/// a caller environment, use a shell for gateway commands, or retain stderr.
struct GatewayCommand: GatewayCommandRunning, Sendable {
    private static let trustedCLIMarker = "# Managed by subscription-gateway installer"
    private static let maximumScriptBytes = 64 * 1_024
    private static let maximumStdoutBytes = 1_024 * 1_024
    private static let pipeDrainGraceNanoseconds: UInt64 = 250_000_000

    private let homeDirectory: URL
    private let resourceDirectory: URL?
    private let timeoutSeconds: TimeInterval

    init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        resourceDirectory: URL? = Bundle.main.resourceURL,
        timeoutSeconds: TimeInterval = 30
    ) {
        self.homeDirectory = homeDirectory
        self.resourceDirectory = resourceDirectory
        self.timeoutSeconds = max(0.01, timeoutSeconds)
    }

    func hasTrustedCLI() async -> Bool {
        trustedCLI != nil
    }

    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        guard let command = resolvedCommand else { return .failed }
        return await Self.execute(
            executable: command.executable,
            arguments: command.prefix + arguments + ["--config", configPath],
            homeDirectory: homeDirectory,
            timeoutSeconds: timeoutSeconds
        )
    }

    func install(configPath: String) async -> GatewayCommandResult {
        _ = configPath // Kept for the model protocol; install.sh discovers its own config.
        guard let installer = resourceDirectory?.appending(path: "backend/install").path,
              FileManager.default.isExecutableFile(atPath: installer) else { return .failed }
        return await Self.execute(
            executable: "/bin/sh",
            arguments: [installer],
            homeDirectory: homeDirectory,
            timeoutSeconds: timeoutSeconds
        )
    }

    func associateBackgroundItem(configPath: String) async -> GatewayCommandResult {
        guard let resourceDirectory else { return .failed }
        let node = resourceDirectory.appending(path: "backend/runtime/bin/node").path
        let tool = resourceDirectory.appending(path: "management/dist/app-background.js").path
        guard FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: tool) else { return .failed }
        return await Self.execute(
            executable: node,
            arguments: [tool, "--config", configPath, "--apply"],
            homeDirectory: homeDirectory,
            timeoutSeconds: timeoutSeconds
        )
    }

    private var trustedCLI: String? {
        let path = homeDirectory.appending(path: ".local/bin/gateway").path
        guard let script = trustedScript(at: path) else { return nil }
        let hasMarker = script.split(whereSeparator: \Character.isNewline)
            .contains { String($0) == Self.trustedCLIMarker }
        return hasMarker ? path : nil
    }

    private var resolvedCommand: (executable: String, prefix: [String])? {
        if let trustedCLI { return (trustedCLI, []) }
        guard let resourceDirectory else { return nil }
        let node = resourceDirectory.appending(path: "backend/runtime/bin/node").path
        let cli = resourceDirectory.appending(path: "backend/package/dist/cli.js").path
        guard FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: cli) else { return nil }
        return (node, [cli])
    }

    private func trustedScript(at path: String) -> String? {
        guard let data = readScript(at: path),
              let script = String(data: data, encoding: .utf8) else { return nil }
        return script
    }

    private func readScript(at path: String) -> Data? {
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }

        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              metadata.st_size > 0,
              metadata.st_size <= off_t(Self.maximumScriptBytes),
              (metadata.st_mode & (S_IXUSR | S_IXGRP | S_IXOTH)) != 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: Self.maximumScriptBytes + 1)
        let count = bytes.withUnsafeMutableBytes { buffer in
            read(descriptor, buffer.baseAddress, buffer.count)
        }
        guard count > 0, count <= Self.maximumScriptBytes else { return nil }
        return Data(bytes.prefix(Int(count)))
    }

    private static func execute(
        executable: String,
        arguments: [String],
        homeDirectory: URL,
        timeoutSeconds: TimeInterval
    ) async -> GatewayCommandResult {
        await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.currentDirectoryURL = homeDirectory
            process.environment = safeEnvironment(homeDirectory: homeDirectory)

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr
            guard (try? process.run()) != nil else { return .failed }
            // Foundation creates a separate group on macOS. Check that identity
            // before using it so timeout cleanup cannot reach the app's group.
            let childPID = process.processIdentifier
            let ownsProcessGroup = getpgid(childPID) == childPID && childPID != getpgrp()

            let stdoutDescriptor = stdout.fileHandleForReading.fileDescriptor
            let stderrDescriptor = stderr.fileHandleForReading.fileDescriptor
            setNonBlocking(stdoutDescriptor)
            setNonBlocking(stderrDescriptor)
            defer {
                try? stdout.fileHandleForReading.close()
                try? stderr.fileHandleForReading.close()
            }

            let deadline = deadline(after: timeoutSeconds)
            var drainDeadline: UInt64?
            var captured: Data? = Data()
            var stdoutExceededLimit = false
            var stdoutClosed = false
            var stderrClosed = false
            var discardedStderr: Data?

            while true {
                let stdoutRead = drain(
                    stdoutDescriptor,
                    into: &captured,
                    captureLimit: maximumStdoutBytes
                )
                stdoutExceededLimit = stdoutExceededLimit || stdoutRead.exceededCaptureLimit
                stdoutClosed = stdoutClosed || stdoutRead.reachedEnd
                let stderrRead = drain(stderrDescriptor, into: &discardedStderr, captureLimit: 0)
                stderrClosed = stderrClosed || stderrRead.reachedEnd

                let now = DispatchTime.now().uptimeNanoseconds
                if process.isRunning {
                    if now >= deadline {
                        stopOwnedProcess(process, ownsGroup: ownsProcessGroup)
                        return GatewayCommandResult(outcome: .timedOut, stdout: "")
                    }
                } else {
                    if drainDeadline == nil {
                        drainDeadline = min(deadline, now &+ pipeDrainGraceNanoseconds)
                    }
                    if (stdoutClosed && stderrClosed) || now >= drainDeadline! {
                        guard !stdoutExceededLimit, process.terminationStatus == 0 else { return .failed }
                        return GatewayCommandResult(
                            outcome: .success,
                            stdout: String(decoding: captured ?? Data(), as: UTF8.self)
                        )
                    }
                }
                usleep(10_000)
            }
        }.value
    }

    private static func safeEnvironment(homeDirectory: URL) -> [String: String] {
        let user = NSUserName()
        return [
            "HOME": homeDirectory.path,
            "LOGNAME": user,
            "PATH": "\(homeDirectory.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "TMPDIR": "/tmp",
            "USER": user,
        ]
    }

    private static func stopOwnedProcess(_ process: Process, ownsGroup: Bool) {
        let target = ownsGroup ? -process.processIdentifier : process.processIdentifier
        _ = kill(target, SIGTERM)
        let grace = deadline(after: 0.15)
        while DispatchTime.now().uptimeNanoseconds < grace {
            if kill(target, 0) != 0 && errno == ESRCH { return }
            usleep(10_000)
        }
        // LaunchAgents started by launchd have their own ownership and group.
        // Only this invocation and its still-attached helpers are stopped here.
        _ = kill(target, SIGKILL)
    }

    private static func deadline(after seconds: TimeInterval) -> UInt64 {
        let duration = UInt64((seconds * 1_000_000_000).rounded(.up))
        return DispatchTime.now().uptimeNanoseconds &+ duration
    }

    private static func setNonBlocking(_ descriptor: Int32) {
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0 else { return }
        _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
    }

    private struct DrainResult {
        var reachedEnd = false
        var exceededCaptureLimit = false
    }

    private static func drain(
        _ descriptor: Int32,
        into captured: inout Data?,
        captureLimit: Int
    ) -> DrainResult {
        var result = DrainResult()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        // Yield to the outer deadline even when a producer never stops writing.
        for _ in 0..<16 {
            let count = buffer.withUnsafeMutableBytes { buffer in
                read(descriptor, buffer.baseAddress, buffer.count)
            }
            if count > 0 {
                guard captureLimit > 0 else { continue }
                let bytes = buffer.prefix(Int(count))
                let capturedCount = captured?.count ?? 0
                let remaining = max(0, captureLimit - capturedCount)
                if bytes.count > remaining { result.exceededCaptureLimit = true }
                if remaining > 0 {
                    captured?.append(contentsOf: bytes.prefix(remaining))
                }
                continue
            }
            if count == 0 {
                result.reachedEnd = true
            } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                result.reachedEnd = true
            }
            return result
        }
        return result
    }
}
