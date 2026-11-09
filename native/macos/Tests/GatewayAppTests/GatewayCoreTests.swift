import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayCoreTests: XCTestCase {
    func testFreshInstallUsesGateFoxConfigurationAndExistingMacKeepsItsOwn() {
        let home = URL(filePath: "/Users/dev")
        let gatefox = "/Users/dev/Library/Application Support/GateFox/gateway.json"
        let legacy = "/Users/dev/Library/Application Support/Subscription Gateway/gateway.json"
        XCTAssertEqual(GatewayModel.defaultConfigPath(homeDirectory: home, exists: { _ in false }), gatefox)
        XCTAssertEqual(GatewayModel.defaultConfigPath(homeDirectory: home, exists: { $0 == legacy }), legacy)
        XCTAssertEqual(GatewayModel.defaultConfigPath(homeDirectory: home, exists: { _ in true }), gatefox)
    }

    func testTerminationWaitsForGatewaySetupToFinish() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let health = HeldHealth()
        let model = GatewayModel(command: readyRunner(), health: health, homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        let setup = Task { await model.setup() }
        while !(await health.started) { await Task.yield() }

        var waiterStarted = false
        var finished = false
        let waiter = Task {
            waiterStarted = true
            await model.waitForPendingWork()
            finished = true
        }
        while !waiterStarted { await Task.yield() }
        XCTAssertTrue(model.hasPendingWork)
        XCTAssertFalse(finished)

        await health.release()
        await setup.value
        await waiter.value
        XCTAssertTrue(finished)
        XCTAssertFalse(model.hasPendingWork)
        XCTAssertTrue(model.setupComplete)
    }

    func testProjectsRealConfigurationWithoutOptionalFieldsOrCredentials() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let model = GatewayModel(command: readyRunner(), health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())

        model.configPath = config.path
        await model.refresh()

        XCTAssertTrue(model.hasConfig)
        XCTAssertFalse(model.clientOnly)
        XCTAssertEqual(model.endpoint, "http://127.0.0.1:3457")
        XCTAssertEqual(model.providers, [GatewayProvider(id: "claude", label: "claude", kind: "Claude subscription", modelCount: 1)])
        XCTAssertEqual(model.modelCount, 1)
    }

    func testMalformedMapAndPortClearPreviouslyReadyStatus() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let model = GatewayModel(command: readyRunner(), health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.refresh()
        XCTAssertTrue(model.setupComplete)

        try #"{"version":1,"port":3457,"stateDirectory":"/state","providers":[{"id":"claude","type":"claude-subscription","models":[]}]}"#.write(to: config, atomically: true, encoding: .utf8)
        await model.refresh()
        XCTAssertFalse(model.hasConfig)
        XCTAssertFalse(model.setupComplete)
        XCTAssertFalse(model.isReachable)
        XCTAssertNil(model.lastChecked)

        try #"{"version":1,"port":70000,"stateDirectory":"/state","providers":[]}"#.write(to: config, atomically: true, encoding: .utf8)
        await model.refresh()
        XCTAssertFalse(model.hasConfig)
        XCTAssertFalse(model.desktopReady)
    }

    func testStatusFailureClearsReadyState() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = MockRunner(responses: [
            "service status --json": [serviceReady, .failed],
            "desktop status --json": [desktopReady, .failed]
        ])
        let model = GatewayModel(command: runner, health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.refresh()
        XCTAssertTrue(model.setupComplete)
        await model.refresh()

        XCTAssertFalse(model.serviceInstalled)
        XCTAssertFalse(model.desktopReady)
        XCTAssertFalse(model.isReachable)
        XCTAssertFalse(model.setupComplete)
        XCTAssertNil(model.lastChecked)
    }

    func testConflictAppearingAfterInitializationRefusesAllWrites() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = MockRunner(responses: ["service status --json": [serviceMissing], "desktop status --json": [desktopMissing]], trustedCLI: false)
        let model = GatewayModel(command: runner, health: MockHealth(value: false), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        try writeManagedAgent(home: home, configPath: "/different/gateway.json")

        await model.setup()

        XCTAssertFalse(model.canSetup)
        let mutations = await runner.mutatingCalls()
        XCTAssertTrue(mutations.isEmpty)
    }

    func testPendingConsolidationRefusesAllWrites() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = MockRunner(responses: [
            "service status --json": [.init(outcome: .success, stdout: #"{"installed":true,"pid":12,"consolidationPending":"next_login"}"#)],
            "desktop status --json": [desktopMissing]
        ], trustedCLI: false)
        let model = GatewayModel(command: runner, health: MockHealth(value: false), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.setup()

        XCTAssertFalse(model.canSetup)
        let mutations = await runner.mutatingCalls()
        XCTAssertTrue(mutations.isEmpty)
    }

    func testInstallerFailureStopsDesktopRegistration() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = MockRunner(responses: ["service status --json": [serviceMissing], "desktop status --json": [desktopMissing]], trustedCLI: false, installResult: .failed)
        let model = GatewayModel(command: runner, health: MockHealth(value: false), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.setup()

        let mutations = await runner.mutatingCalls()
        XCTAssertEqual(mutations, ["install"])
    }

    func testReadySetupDoesNotMutateAnything() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try realConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = readyRunner()
        let model = GatewayModel(command: runner, health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.setup()

        XCTAssertTrue(model.setupComplete)
        let mutations = await runner.mutatingCalls()
        XCTAssertTrue(mutations.isEmpty)
    }

    func testClientOnlyWithNoProvidersNeverInstallsAService() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try clientOnlyConfiguration().write(to: config, atomically: true, encoding: .utf8)
        let runner = MockRunner(responses: ["service status --json": [serviceMissing], "desktop status --json": [desktopMissing]])
        let model = GatewayModel(command: runner, health: MockHealth(value: false), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.setup()

        XCTAssertTrue(model.clientOnly)
        let mutations = await runner.mutatingCalls()
        XCTAssertFalse(mutations.contains("service install"))
    }

    func testGrokSubscriptionConfigurationIsAcceptedAndProjected() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"grok","type":"grok-subscription","label":"Grok","models":{"grok/grok-4":"grok-4"}}]}"#.write(to: config, atomically: true, encoding: .utf8)
        let model = GatewayModel(command: readyRunner(), health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())

        model.configPath = config.path
        await model.refresh()

        XCTAssertTrue(model.hasConfig)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.providers, [GatewayProvider(id: "grok", label: "Grok", kind: "Grok subscription", modelCount: 1)])
    }

    func testGrokSubscriptionProviderSurvivesStatusRefreshRoundtrip() async throws {
        let home = try temporaryHome()
        let config = home.appending(path: "gateway.json")
        try #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"grok","type":"grok-subscription","models":{"grok/grok-4":"grok-4"}}]}"#.write(to: config, atomically: true, encoding: .utf8)
        let model = GatewayModel(command: readyRunner(), health: MockHealth(value: true), homeDirectory: home, defaults: testDefaults())
        model.configPath = config.path
        await model.refresh()
        XCTAssertTrue(model.hasConfig)

        await model.refresh()
        XCTAssertTrue(model.hasConfig)
        XCTAssertEqual(model.modelCount, 1)
    }

    private func temporaryHome() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func testDefaults() -> UserDefaults {
        let name = "GatewayAppTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: name) else { fatalError("Unable to create test defaults") }
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func realConfiguration() -> String {
        #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"claude","type":"claude-subscription","models":{"claude/opus":"claude-opus"},"credentialFile":"/never/read"}]}"#
    }

    private func clientOnlyConfiguration() -> String {
        #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","clientOnly":true,"providers":[]}"#
    }

    private func writeManagedAgent(home: URL, configPath: String) throws {
        let agent = home.appending(path: "Library/LaunchAgents/com.edihasaj.subscription-gateway.plist")
        try FileManager.default.createDirectory(at: agent.deletingLastPathComponent(), withIntermediateDirectories: true)
        let plist = """
        <?xml version="1.0"?><plist version="1.0"><dict><!-- Managed by subscription-gateway --><key>ProgramArguments</key><array><string>gateway</string><string>--config</string><string>\(configPath)</string></array></dict></plist>
        """
        try plist.write(to: agent, atomically: true, encoding: .utf8)
    }

    private func readyRunner() -> MockRunner {
        MockRunner(responses: ["service status --json": [serviceReady], "desktop status --json": [desktopReady]])
    }

    private var serviceReady: GatewayCommandResult { .init(outcome: .success, stdout: #"{"installed":true,"pid":12}"#) }
    private var serviceMissing: GatewayCommandResult { .init(outcome: .success, stdout: #"{"installed":false}"#) }
    private var desktopReady: GatewayCommandResult { .init(outcome: .success, stdout: #"{"registered":true,"activeForFutureLaunches":true}"#) }
    private var desktopMissing: GatewayCommandResult { .init(outcome: .success, stdout: #"{"registered":false,"activeForFutureLaunches":false}"#) }
}

private actor HeldHealth: GatewayHealthChecking {
    private var continuation: CheckedContinuation<Bool, Never>?
    var started: Bool { continuation != nil }

    func check(port: Int) async -> Bool {
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        continuation?.resume(returning: true)
        continuation = nil
    }
}

private actor MockRunner: GatewayCommandRunning {
    private var responses: [String: [GatewayCommandResult]]
    private var trustedCLI: Bool
    private let installResult: GatewayCommandResult
    private var mutations: [String] = []

    init(responses: [String: [GatewayCommandResult]] = [:], trustedCLI: Bool = true, installResult: GatewayCommandResult = .init(outcome: .success, stdout: "")) {
        self.responses = responses
        self.trustedCLI = trustedCLI
        self.installResult = installResult
    }

    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        let key = arguments.joined(separator: " ")
        if arguments == ["service", "install"] || arguments == ["desktop", "register"] { mutations.append(key) }
        guard var queued = responses[key], !queued.isEmpty else { return .failed }
        let result = queued.removeFirst()
        responses[key] = queued.isEmpty ? [result] : queued
        return result
    }

    func hasTrustedCLI() async -> Bool { trustedCLI }

    func install(configPath: String) async -> GatewayCommandResult {
        mutations.append("install")
        if installResult.outcome == .success { trustedCLI = true }
        return installResult
    }

    func mutatingCalls() -> [String] { mutations }
}

private struct MockHealth: GatewayHealthChecking {
    let value: Bool
    func check(port: Int) async -> Bool { value }
}
