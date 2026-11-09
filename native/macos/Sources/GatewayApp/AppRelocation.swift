import AppKit
import Foundation

/// Renames an app that an older updater left at `Harness Gateway.app` to `GateFox.app` beside it, then relaunches it
/// from there, leaving `Harness Gateway.app` as a link to it. At the next launch the app rebinds the service plist and the app-runtime link to the new path; the
/// backend accepts the old sibling path, and only it, as their previous owner. Skipped while an update is unfinished,
/// because its journal records the old path.
enum AppRelocation {
    static let legacyName = "Harness Gateway.app"
    static let currentName = "GateFox.app"

    static func destination(bundleURL: URL, homeDirectory: URL, exists: (String) -> Bool, pendingUpdate: (URL) -> Bool) -> URL? {
        guard bundleURL.lastPathComponent == legacyName else { return nil }
        let target = bundleURL.deletingLastPathComponent().appending(path: currentName)
        guard !exists(target.path) else { return nil }
        for name in ["gatefox", "subscription-gateway"] {
            let root = homeDirectory.appending(path: ".local/share/\(name)")
            if exists(root.appending(path: "app-update-transaction.json").path) || pendingUpdate(root.appending(path: "app-update.json")) {
                return nil
            }
        }
        return target
    }

    /// Whether the updater's state file records a staged update.
    static func recordsPendingUpdate(_ url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url) else { return false }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
        if let pending = object["pending"], !(pending is NSNull) { return true }
        return false
    }

    /// Moves the app and relaunches it from the new path; `relaunched` is true once the new instance started, and the
    /// caller then terminates. If the relaunch fails, the app moves back and keeps running where it was.
    @MainActor
    static func relocateIfNeeded(homeDirectory: URL, relaunched: @escaping @MainActor (Bool) -> Void) {
        let fileManager = FileManager.default
        let source = Bundle.main.bundleURL
        guard let target = destination(
            bundleURL: source,
            homeDirectory: homeDirectory,
            exists: { fileManager.fileExists(atPath: $0) },
            pendingUpdate: recordsPendingUpdate
        ) else { return relaunched(false) }
        do { try fileManager.moveItem(at: source, to: target) } catch { return relaunched(false) }
        // launchd keeps the loaded job's old program path until the next login, and the service plan stores the old
        // app's Node path for supervised components, so the old name stays as a link to the renamed app.
        try? fileManager.createSymbolicLink(atPath: source.path, withDestinationPath: currentName)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: target, configuration: configuration) { application, _ in
            Task { @MainActor in
                if application == nil {
                    try? FileManager.default.removeItem(at: source)
                    try? FileManager.default.moveItem(at: target, to: source)
                }
                relaunched(application != nil)
            }
        }
    }
}
