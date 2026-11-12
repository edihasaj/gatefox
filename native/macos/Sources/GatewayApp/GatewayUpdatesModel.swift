import Combine
import Foundation

@MainActor
final class GatewayUpdatesModel: ObservableObject {
    @Published private(set) var automatic = false
    @Published private(set) var currentVersion: String
    @Published private(set) var latestVersion: String?
    @Published private(set) var available = false
    @Published private(set) var phase = "idle"
    @Published private(set) var message = "Check for a newer GateFox app."
    @Published private(set) var lastChecked: Date?
    @Published private(set) var isBusy = false
    @Published private(set) var isCancelling = false

    private let runner: any GatewayUpdateRunning
    private var configPath = ""
    private var operationID: UUID?
    private var activeOperation: String?
    private var queuedCheck = false
    private var configurationGeneration = 0
    private var cancellationID: UUID?
    private var cancellationTask: Task<Void, Never>?
    private var lastForegroundCheck: Date?

    init(runner: any GatewayUpdateRunning = GatewayUpdatesCommand(), bundle: Bundle = .main) {
        self.runner = runner
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        currentVersion = version?.isEmpty == false ? version! : "Current app"
    }

    var hasPendingWork: Bool { isBusy || isCancelling || cancellationTask != nil }

    func configure(configPath: String) async {
        configurationGeneration &+= 1
        let generation = configurationGeneration
        guard configPath.hasPrefix("/"), URL(fileURLWithPath: configPath).pathExtension.lowercased() == "json" else {
            await cancelActiveOperation()
            guard generation == configurationGeneration else { return }
            self.configPath = ""
            unavailable("Choose a gateway JSON configuration before checking for updates.")
            return
        }
        guard self.configPath != configPath else { return }
        await cancelActiveOperation()
        guard generation == configurationGeneration else { return }
        self.configPath = configPath
        lastForegroundCheck = nil
        await status()
    }

    /// Discover updates outside Settings, while coalescing frequent app activations.
    func refreshForForeground(configPath: String, now: Date = Date()) async {
        if self.configPath != configPath { await configure(configPath: configPath) }
        guard self.configPath == configPath, !self.configPath.isEmpty, !hasPendingWork,
              phase != "waiting_for_app_exit" else { return }
        if let lastForegroundCheck, now.timeIntervalSince(lastForegroundCheck) >= 0,
           now.timeIntervalSince(lastForegroundCheck) < 300 { return }
        lastForegroundCheck = now
        await check()
    }

    var showsUpdateNotice: Bool { available || phase == "waiting_for_app_exit" || phase == "unavailable" }

    func status() async { _ = await perform(operation: "status", timeout: .seconds(30)) }
    func check() async { _ = await perform(operation: "check", timeout: .seconds(60)) }
    func install() async { _ = await perform(operation: "install", timeout: .seconds(900)) }

    func requestCheck() async {
        if activeOperation == "status" {
            queuedCheck = true
            return
        }
        await check()
    }

    func setAutomatic(_ value: Bool) async {
        _ = await perform(operation: "preferences", automatic: value, timeout: .seconds(30))
    }

    func cancel() async {
        guard isBusy, !isCancelling else { return }
        let generation = configurationGeneration
        phase = "cancelling"
        message = "Cancelling update request…"
        await cancelActiveOperation()
        guard generation == configurationGeneration else { return }
        phase = "idle"
        message = "Update check cancelled."
    }

    func cancelAndWait() async {
        if isBusy { await cancel() }
        if let cancellationTask { await cancellationTask.value }
    }

    private func perform(operation: String, automatic: Bool? = nil, timeout: Duration) async -> Bool {
        guard !isBusy else { return false }
        guard !configPath.isEmpty else {
            unavailable("Updates need a selected gateway JSON configuration.")
            return false
        }
        let id = UUID()
        operationID = id
        activeOperation = operation
        isBusy = true
        let response = await runner.request(
            GatewayUpdateRequest(operation: operation, configPath: configPath, automatic: automatic),
            timeout: timeout
        )
        guard operationID == id else { return false }
        operationID = nil
        activeOperation = nil
        isBusy = false
        let shouldCheckAfterStatus = operation == "status" && queuedCheck
        queuedCheck = false
        guard response.ok, let result = response.result else {
            unavailable(Self.safeMessage(for: response.error?.code))
            if shouldCheckAfterStatus { await check() }
            return false
        }
        apply(result)
        if shouldCheckAfterStatus { await check() }
        return true
    }

    private func apply(_ result: GatewayUpdateResult) {
        automatic = result.automatic
        currentVersion = result.currentVersion
        latestVersion = result.latestVersion
        available = result.available
        phase = result.phase
        message = Self.displayMessage(for: result)
        if let lastChecked = result.lastChecked {
            self.lastChecked = ISO8601DateFormatter().date(from: lastChecked)
        }
    }

    private func unavailable(_ text: String) {
        available = false
        latestVersion = nil
        phase = "unavailable"
        message = text
    }

    private func cancelActiveOperation() async {
        if let cancellationTask {
            await cancellationTask.value
            return
        }
        guard isBusy else { return }
        let id = UUID()
        operationID = nil
        activeOperation = nil
        queuedCheck = false
        isCancelling = true
        cancellationID = id
        let runner = runner
        let task = Task { await runner.cancel() }
        cancellationTask = task
        await task.value
        guard cancellationID == id else { return }
        cancellationTask = nil
        cancellationID = nil
        isCancelling = false
        isBusy = false
    }

    private static func displayMessage(for result: GatewayUpdateResult) -> String {
        switch result.phase {
        case "waiting_for_app_exit": return "Update staged. Close this window to finish installing it."
        case "installed": return "Update installed. Reopen GateFox to use it."
        default: return result.message
        }
    }

    private static func safeMessage(for code: String?) -> String {
        switch code {
        case "auth_required": return "Sign in to check for updates, then try again."
        case "cancelled": return "Update check cancelled."
        case "timed_out": return "The update request took too long. Try again."
        case "updates_unavailable": return "Updates are unavailable in this app bundle."
        default: return "Updates could not be checked. Try again."
        }
    }
}
