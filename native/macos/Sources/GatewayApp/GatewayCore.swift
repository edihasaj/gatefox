import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers

struct GatewayProvider: Identifiable, Equatable {
    let id: String
    let label: String
    let kind: String
    let modelCount: Int
}

private struct GatewayConfiguration: Decodable {
    let version: Int
    let port: Int
    let stateDirectory: String
    let providers: [Provider]
    let clientOnly: Bool

    struct Provider: Decodable {
        let id: String
        let label: String?
        let type: String
        let models: [String: String]
    }

    private enum CodingKeys: String, CodingKey { case version, port, stateDirectory, providers, clientOnly }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        port = try values.decode(Int.self, forKey: .port)
        stateDirectory = try values.decode(String.self, forKey: .stateDirectory)
        providers = try values.decode([Provider].self, forKey: .providers)
        clientOnly = try values.decodeIfPresent(Bool.self, forKey: .clientOnly) ?? false
    }

    var isValid: Bool {
        guard version == 1, (0...65_535).contains(port), !stateDirectory.isEmpty else { return false }
        guard clientOnly ? (port > 0 && providers.isEmpty) : !providers.isEmpty else { return false }
        return providers.allSatisfy { provider in
            Self.supportedProviderTypes.contains(provider.type)
                && Self.validID(provider.id)
                && !provider.models.isEmpty
                && provider.models.allSatisfy { !$0.key.isEmpty && !$0.value.isEmpty }
        }
    }

    static let supportedProviderTypes: Set<String> = [
        "claude-subscription", "codex-subscription", "copilot-subscription", "grok-subscription",
        "responses-api", "anthropic-api", "chat-completions-api"
    ]

    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[a-z][a-z0-9_-]*$", options: .regularExpression) != nil
    }
}

private struct ServiceStatus: Decodable {
    let installed: Bool
    let pid: Int?
    let consolidationPending: String?
}

private struct DesktopStatus: Decodable {
    let registered: Bool?
    let activeForFutureLaunches: Bool?
    let forceCliSet: Bool?
    let staleWrapper: Bool?
}

protocol GatewayHealthChecking: Sendable {
    func check(port: Int) async -> Bool
}

struct GatewayHealthChecker: GatewayHealthChecking {
    func check(port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            return (try? JSONDecoder().decode(Health.self, from: data))?.status == "ok"
        } catch {
            return false
        }
    }

    private struct Health: Decodable { let status: String }
}

@MainActor
final class GatewayModel: ObservableObject {
    @Published var configPath: String {
        didSet {
            guard configPath != oldValue else { return }
            invalidateConfiguration()
        }
    }
    @Published private(set) var providers: [GatewayProvider] = []
    @Published private(set) var isBusy = false
    @Published private(set) var isReachable = false
    @Published private(set) var serviceInstalled = false
    @Published private(set) var desktopReady = false
    @Published private(set) var hasConfig = false
    @Published private(set) var message: String?
    @Published private(set) var lastChecked: Date?
    @Published private(set) var backgroundIdentityNote: String?

    var modelCount: Int { providers.reduce(0) { $0 + $1.modelCount } }
    var endpoint: String { configuration.map { "http://127.0.0.1:\($0.port)" } ?? "" }
    var clientOnly: Bool { configuration?.clientOnly ?? false }
    var hasPendingWork: Bool { isBusy || setupOperations > 0 || backgroundIdentityOperations > 0 }
    var canSetup: Bool {
        hasConfig && serviceStatusSucceeded && desktopStatusSucceeded
            && !managedConfigConflict && !managedConfigurationUnsafe
            && !pendingConsolidation && !isBusy
    }
    var setupComplete: Bool {
        hasConfig && serviceStatusSucceeded && desktopStatusSucceeded
            && !managedConfigConflict && !managedConfigurationUnsafe
            && !pendingConsolidation && isReachable && desktopReady
            && (serviceInstalled || clientOnly)
    }

    private static let configurationError = "Choose an existing valid gateway configuration, then refresh its status."
    private static let statusError = "Gateway status could not be checked. Refresh and try again."
    private static let conflictError = "Setup is blocked because the managed gateway service uses a different configuration."
    private static let unsafeServiceError = "Setup is blocked because the gateway LaunchAgent is not a readable managed service."
    private static let pendingError = "Setup is blocked until the pending gateway service consolidation finishes."
    private static let setupError = "Setup stopped before desktop registration. Check gateway status, then try again."
    private static let partialError = "Setup is not complete yet. Refresh status and try again."

    private let command: any GatewayCommandRunning
    private let health: any GatewayHealthChecking
    private let homeDirectory: URL
    private let defaults: UserDefaults
    private var configuration: GatewayConfiguration?
    private var serviceStatusSucceeded = false
    private var desktopStatusSucceeded = false
    private var managedConfigConflict = false
    private var managedConfigurationUnsafe = false
    private var pendingConsolidation = false
    private var serviceIsLoaded = false
    private var setupOperations = 0
    private var backgroundIdentityOperations = 0

    init(
        command: any GatewayCommandRunning = GatewayCommand(),
        health: any GatewayHealthChecking = GatewayHealthChecker(),
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        defaults: UserDefaults = .standard,
        initialConfigPath: String? = nil
    ) {
        self.command = command
        self.health = health
        self.homeDirectory = homeDirectory
        self.defaults = defaults
        self.configPath = initialConfigPath ?? Self.discoverConfig(homeDirectory: homeDirectory, defaults: defaults).path
        loadConfiguration(at: configPath)
    }

    func refresh() async {
        guard !isBusy else { return }
        let selectedPath = configPath
        isBusy = true
        defer { isBusy = false }
        message = nil

        guard let loaded = Self.readConfiguration(at: selectedPath) else {
            guard selectedPath == configPath else { return }
            invalidateConfiguration()
            message = Self.configurationError
            return
        }
        guard selectedPath == configPath else { return }
        applyConfiguration(loaded)
        applyManagedConfiguration(Self.managedConfiguration(homeDirectory: homeDirectory), selectedPath: selectedPath)

        async let service = command.run(["service", "status", "--json"], configPath: selectedPath)
        async let desktop = command.run(["desktop", "status", "--json"], configPath: selectedPath)
        async let reachable = health.check(port: loaded.port)
        let (serviceResult, desktopResult, healthResult) = await (service, desktop, reachable)

        guard selectedPath == configPath else { return }
        guard applyServiceStatus(serviceResult), applyDesktopStatus(desktopResult) else {
            clearStatus()
            message = Self.statusError
            return
        }
        isReachable = healthResult
        lastChecked = Date()
        message = safetyMessage()
    }

    func setup() async {
        guard !isBusy else { return }
        setupOperations += 1
        defer { setupOperations -= 1 }
        await refresh()
        let selectedPath = configPath
        guard canSetup else {
            message = safetyMessage() ?? (hasConfig ? Self.statusError : Self.configurationError)
            return
        }
        guard !setupComplete else { return }

        isBusy = true
        var failed = false
        var serviceStartedThisRun = false

        if !(await command.hasTrustedCLI()) {
            guard mutationIsSafe(for: selectedPath) else { await finishBlockedSetup(for: selectedPath); return }
            let installed = await command.install(configPath: selectedPath)
            let trustedAfterInstall = await command.hasTrustedCLI()
            failed = installed.outcome != .success || !trustedAfterInstall
        }
        if !failed && !clientOnly && !serviceIsLoaded {
            guard mutationIsSafe(for: selectedPath) else { await finishBlockedSetup(for: selectedPath); return }
            let service = await command.run(["service", "install"], configPath: selectedPath)
            failed = service.outcome != .success
            serviceStartedThisRun = !failed
        }
        if !failed && !desktopReady {
            guard clientOnly || serviceIsLoaded || serviceStartedThisRun else {
                await finishSetup(for: selectedPath, failed: true)
                return
            }
            guard mutationIsSafe(for: selectedPath) else { await finishBlockedSetup(for: selectedPath); return }
            failed = (await command.run(["desktop", "register"], configPath: selectedPath)).outcome != .success
        }
        await finishSetup(for: selectedPath, failed: failed)
    }

    func associateBackgroundItem() async {
        guard hasConfig else { return }
        backgroundIdentityOperations += 1
        defer { backgroundIdentityOperations -= 1 }
        let path = configPath
        let response = await command.associateBackgroundItem(configPath: path)
        guard path == configPath else { return }
        guard response.outcome == .success,
              let data = response.stdout.data(using: .utf8),
              let result = try? JSONDecoder().decode(BackgroundIdentityResponse.self, from: data),
              result.ok else {
            backgroundIdentityNote = "The background item could not be updated. Your running gateway was kept in place."
            return
        }
        switch result.result?.status {
        case "associated", "already_associated":
            backgroundIdentityNote = "The app identity is ready. macOS may refresh its name and fox icon at your next login."
        case "pending":
            backgroundIdentityNote = "The background identity can update after the pending startup change finishes."
        case "unsigned":
            backgroundIdentityNote = "Use a signed app to show its name and fox icon in Login Items."
        default:
            backgroundIdentityNote = nil
        }
    }

    func waitForPendingWork() async {
        while hasPendingWork {
            do { try await Task.sleep(for: .milliseconds(25)) }
            catch { return }
        }
    }

    func chooseConfig() {
        guard !isBusy else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await useConfig(url.path) }
    }

    func useConfig(_ path: String) async {
        guard path.hasPrefix("/") else { return }
        while isBusy {
            do { try await Task.sleep(for: .milliseconds(25)) }
            catch { return }
        }
        configPath = URL(fileURLWithPath: path).standardizedFileURL.path
        defaults.set(configPath, forKey: Self.chosenConfigKey)
        await refresh()
    }

    func revealConfig() {
        let url = URL(fileURLWithPath: configPath)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func openCodex() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/ChatGPT.app"))
    }

    private func finishBlockedSetup(for path: String) async {
        isBusy = false
        await refresh()
        if configPath == path { message = safetyMessage() ?? Self.statusError }
    }

    private func finishSetup(for path: String, failed: Bool) async {
        isBusy = false
        await refresh()
        guard configPath == path else { return }
        message = setupComplete ? nil : (failed ? Self.setupError : Self.partialError)
        if setupComplete { await associateBackgroundItem() }
    }

    private func mutationIsSafe(for path: String) -> Bool {
        guard path == configPath, let loaded = Self.readConfiguration(at: path) else { return false }
        applyConfiguration(loaded)
        applyManagedConfiguration(Self.managedConfiguration(homeDirectory: homeDirectory), selectedPath: path)
        return !managedConfigConflict && !managedConfigurationUnsafe && !pendingConsolidation
    }

    private func loadConfiguration(at path: String) {
        guard let loaded = Self.readConfiguration(at: path) else {
            invalidateConfiguration()
            message = Self.configurationError
            return
        }
        applyConfiguration(loaded)
        applyManagedConfiguration(Self.managedConfiguration(homeDirectory: homeDirectory), selectedPath: path)
        message = safetyMessage()
    }

    private func applyConfiguration(_ loaded: GatewayConfiguration) {
        configuration = loaded
        providers = loaded.providers.map {
            GatewayProvider(id: $0.id, label: $0.label ?? $0.id, kind: Self.providerKind($0.type), modelCount: $0.models.count)
        }
        hasConfig = true
    }

    private func invalidateConfiguration() {
        configuration = nil
        providers = []
        hasConfig = false
        clearStatus()
        managedConfigConflict = false
        managedConfigurationUnsafe = false
        message = nil
        backgroundIdentityNote = nil
    }

    private func clearStatus() {
        isReachable = false
        serviceInstalled = false
        desktopReady = false
        lastChecked = nil
        serviceStatusSucceeded = false
        desktopStatusSucceeded = false
        pendingConsolidation = false
        serviceIsLoaded = false
    }

    private func applyServiceStatus(_ result: GatewayCommandResult) -> Bool {
        guard result.outcome == .success,
              let status = try? JSONDecoder().decode(ServiceStatus.self, from: Data(result.stdout.utf8)) else { return false }
        serviceStatusSucceeded = true
        serviceIsLoaded = status.installed
        serviceInstalled = status.installed && (status.pid ?? 0) > 0
        pendingConsolidation = !(status.consolidationPending?.isEmpty ?? true)
        return true
    }

    private func applyDesktopStatus(_ result: GatewayCommandResult) -> Bool {
        guard result.outcome == .success,
              let status = try? JSONDecoder().decode(DesktopStatus.self, from: Data(result.stdout.utf8)) else { return false }
        desktopStatusSucceeded = true
        desktopReady = (status.registered ?? false) && (status.activeForFutureLaunches ?? false)
            && !(status.forceCliSet ?? false) && !(status.staleWrapper ?? false)
        return true
    }

    private func applyManagedConfiguration(_ managed: ManagedConfiguration, selectedPath: String) {
        managedConfigConflict = false
        managedConfigurationUnsafe = false
        switch managed {
        case .missing:
            break
        case let .managed(path):
            managedConfigConflict = !Self.samePath(path, selectedPath)
        case .unsafe:
            managedConfigurationUnsafe = true
        }
    }

    private func safetyMessage() -> String? {
        if managedConfigurationUnsafe { return Self.unsafeServiceError }
        if managedConfigConflict { return Self.conflictError }
        if pendingConsolidation { return Self.pendingError }
        return nil
    }

    private static func providerKind(_ type: String) -> String {
        switch type {
        case "claude-subscription": return "Claude subscription"
        case "codex-subscription": return "Codex subscription"
        case "copilot-subscription": return "Copilot subscription"
        case "grok-subscription": return "Grok subscription"
        case "chat-completions-api": return "Local / API"
        default: return "API"
        }
    }

    private static let chosenConfigKey = "GatewayApp.chosenConfigPath"

    static func discoverConfig(homeDirectory: URL, defaults: UserDefaults) -> (path: String, managedPath: String?) {
        let managed = managedConfiguration(homeDirectory: homeDirectory)
        let managedPath: String?
        if case let .managed(path) = managed { managedPath = path } else { managedPath = nil }
        if let chosen = defaults.string(forKey: chosenConfigKey), !chosen.isEmpty { return (chosen, managedPath) }
        return (managedPath ?? homeDirectory.appending(path: "Library/Application Support/Subscription Gateway/gateway.json").path, managedPath)
    }

    private enum ManagedConfiguration { case missing, managed(String), unsafe }

    private static func managedConfiguration(homeDirectory: URL) -> ManagedConfiguration {
        let plist = homeDirectory.appending(path: "Library/LaunchAgents/com.edihasaj.subscription-gateway.plist")
        let manager = FileManager.default
        guard manager.fileExists(atPath: plist.path) else { return .missing }
        guard let data = try? Data(contentsOf: plist),
              String(data: data, encoding: .utf8)?.contains("<!-- Managed by subscription-gateway -->") == true,
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dictionary = object as? [String: Any],
              let arguments = dictionary["ProgramArguments"] as? [String],
              let index = arguments.firstIndex(of: "--config"), arguments.indices.contains(index + 1) else { return .unsafe }
        let path = arguments[index + 1]
        guard URL(fileURLWithPath: path).path == path else { return .unsafe }
        return .managed(URL(fileURLWithPath: path).standardizedFileURL.path)
    }

    private static func readConfiguration(at path: String) -> GatewayConfiguration? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let configuration = try? JSONDecoder().decode(GatewayConfiguration.self, from: data),
              configuration.isValid else { return nil }
        return configuration
    }

    private static func samePath(_ lhs: String, _ rhs: String) -> Bool {
        let left = URL(fileURLWithPath: lhs).standardizedFileURL.resolvingSymlinksInPath().path
        let right = URL(fileURLWithPath: rhs).standardizedFileURL.resolvingSymlinksInPath().path
        return left == right
    }
}
