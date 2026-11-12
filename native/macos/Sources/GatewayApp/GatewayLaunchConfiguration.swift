import CryptoKit
import Darwin
import Foundation

/// Explicit configuration launches keep their preferences separate from the
/// normal app. This also lets desktop verification use a private, isolated home.
struct GatewayLaunchConfiguration {
    enum LaunchError: Error { case invalidOptions }
    let homeDirectory: URL
    let configPath: String?
    let defaults: UserDefaults

    static func read(arguments: [String] = CommandLine.arguments) throws -> GatewayLaunchConfiguration {
        let actualHome = FileManager.default.homeDirectoryForCurrentUser
        let options = try parsedOptions(arguments)
        guard let config = options["--config"] else {
            guard options["--data-home"] == nil else { throw LaunchError.invalidOptions }
            return GatewayLaunchConfiguration(homeDirectory: actualHome, configPath: nil, defaults: .standard)
        }
        guard config.hasPrefix("/") else {
            throw LaunchError.invalidOptions
        }
        let selected = URL(fileURLWithPath: config).standardizedFileURL
        var selectedHome = actualHome
        if let value = options["--data-home"] {
            guard value.hasPrefix("/") else {
                throw LaunchError.invalidOptions
            }
            let candidate = URL(fileURLWithPath: value).standardizedFileURL.resolvingSymlinksInPath()
            let configLocation = selected.resolvingSymlinksInPath().path
            var info = stat()
            if lstat(candidate.path, &info) == 0,
               (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
               info.st_mode & 0o022 == 0,
               configLocation.hasPrefix(candidate.path + "/") {
                selectedHome = candidate
            } else {
                // A malformed isolation request must never fall back to the
                // user's real home while retaining its requested config path.
                throw LaunchError.invalidOptions
            }
        }
        let identityPath = identityConfigPath(selected.path, homeDirectory: selectedHome)
        let identity = selectedHome.path + "\n" + identityPath
        let hash = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        guard let preferences = UserDefaults(suiteName: "com.edihasaj.harness-gateway.configuration.\(hash)") else {
            throw LaunchError.invalidOptions
        }
        return GatewayLaunchConfiguration(homeDirectory: selectedHome, configPath: identityPath, defaults: preferences)
    }

    /// A verified GateFox rename alias keeps the original preferences and executor ownership identity.
    static func identityConfigPath(_ path: String, homeDirectory: URL) -> String {
        let parent = homeDirectory.appending(path: "Library/Application Support")
        let canonical = parent.appending(path: "GateFox")
        let legacy = parent.appending(path: "Subscription Gateway")
        guard path == canonical.appending(path: "gateway.json").path else { return path }
        var aliasInfo = stat(), backingInfo = stat()
        guard lstat(canonical.path, &aliasInfo) == 0, aliasInfo.st_mode & S_IFMT == S_IFLNK,
              aliasInfo.st_uid == getuid(), lstat(legacy.path, &backingInfo) == 0,
              backingInfo.st_mode & S_IFMT == S_IFDIR, backingInfo.st_uid == getuid(),
              backingInfo.st_mode & 0o022 == 0,
              let target = try? FileManager.default.destinationOfSymbolicLink(atPath: canonical.path),
              (target.hasPrefix("/") ? URL(fileURLWithPath: target) : parent.appending(path: target)).standardizedFileURL.path == legacy.path else { return path }
        return legacy.appending(path: "gateway.json").path
    }

    private static func parsedOptions(_ arguments: [String]) throws -> [String: String] {
        var result: [String: String] = [:]
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            guard argument.hasPrefix("--") else { index += 1; continue }
            let parts = argument.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let name = String(parts[0])
            guard ["--config", "--data-home"].contains(name), result[name] == nil else {
                throw LaunchError.invalidOptions
            }
            let value: String
            if parts.count == 2 {
                value = String(parts[1])
            } else {
                index += 1
                guard arguments.indices.contains(index), !arguments[index].hasPrefix("--") else {
                    throw LaunchError.invalidOptions
                }
                value = arguments[index]
            }
            guard !value.isEmpty else { throw LaunchError.invalidOptions }
            result[name] = value
            index += 1
        }
        return result
    }
}
