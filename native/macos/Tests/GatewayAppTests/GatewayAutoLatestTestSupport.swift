import Foundation
import XCTest
@testable import GatewayApp

// Shared fixtures for the automatic latest models tests.
actor AutoLatestBridge: GatewayManagementRunning {
    private var queued: [ManagementResponse]
    private var captured: [ManagementRequest] = []
    init(responses: [ManagementResponse]) { queued = responses }
    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        return queued.isEmpty ? .refused("invalid_request", message: "ignored") : queued.removeFirst()
    }
    func cancel() async {}
    func requests() -> [ManagementRequest] { captured }
}

actor AutoLatestStagedBridge: GatewayManagementRunning {
    private var captured: [ManagementRequest] = []
    private var continuations: [CheckedContinuation<ManagementResponse, Never>] = []
    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        return await withCheckedContinuation { continuations.append($0) }
    }
    /// Deliberately inert: a pending request finishes only when the test releases it.
    func cancel() async {}
    func waitForRequest(count: Int) async { while captured.count < count { await Task.yield() } }
    func complete(_ response: ManagementResponse, request index: Int) { continuations[index].resume(returning: response) }
}

@MainActor
struct AutoLatestFixture {
    let home: URL
    let config: URL
    let otherConfig: URL
    let gateway: GatewayModel

    init(clientOnly: Bool = false) throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayAutoLatestTests \(UUID().uuidString)")
        config = home.appending(path: "gateway.json")
        otherConfig = home.appending(path: "other.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let content = clientOnly
            ? #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","clientOnly":true,"providers":[]}"#
            : #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"a","type":"responses-api","models":{"one":"one"}}]}"#
        try content.write(to: config, atomically: true, encoding: .utf8)
        try content.write(to: otherConfig, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "GatewayAutoLatestTests.\(UUID().uuidString)")!
        gateway = GatewayModel(command: AutoLatestStatusRunner(), health: AutoLatestHealth(), homeDirectory: home, defaults: defaults)
        gateway.configPath = config.path
    }

    func provider(_ id: String) -> ManagedProvider {
        ManagedProvider(id: id, label: id.uppercased(), type: "responses-api", authState: "saved", authDetail: "Saved",
                        models: [ManagedModel(id: "one", label: "One", enabled: true)], canDiscover: true, canReconnect: false)
    }

    func status(enabled: Bool, scheduled: Bool? = true, lastCheckedAt: Double? = nil, outcome: String? = nil) -> AutoLatestStatus {
        AutoLatestStatus(
            enabled: enabled, intervalMinutes: 5,
            families: [
                AutoLatestFamilyGroup(providerId: "a", label: "Codex Main", families: ["Astra", "Sol", "Terra", "Luna", "Daybreak"]),
                AutoLatestFamilyGroup(providerId: "b", label: "Claude", families: ["Fable", "Opus", "Sonnet", "Haiku"]),
            ],
            nativeFamilies: [], scheduled: scheduled, lastCheckedAt: lastCheckedAt, lastOutcome: outcome)
    }

    func inspected(
        ids: [String] = ["a", "b"],
        revision: String,
        status: AutoLatestStatus?,
        path: String? = nil,
        shared: SharedGatewaySnapshot? = nil
    ) -> ManagementResponse {
        .init(ok: true, result: ManagementResult(
            configPath: path ?? config.path, revision: revision, providers: ids.map(provider), prerequisites: [],
            changed: true, sharedGateway: shared, autoLatest: status
        ), error: nil)
    }

    func remove() { try? FileManager.default.removeItem(at: home) }
}

actor AutoLatestStatusRunner: GatewayCommandRunning {
    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        if arguments.starts(with: ["service"]) { return .init(outcome: .success, stdout: #"{"installed":true,"pid":1}"#) }
        return .init(outcome: .success, stdout: #"{"registered":true,"activeForFutureLaunches":true}"#)
    }
    func hasTrustedCLI() async -> Bool { true }
    func install(configPath: String) async -> GatewayCommandResult { .init(outcome: .success, stdout: "") }
}

struct AutoLatestHealth: GatewayHealthChecking { func check(port: Int) async -> Bool { false } }

extension ManagementResponse {
    static func refused(_ code: String, message: String) -> ManagementResponse {
        ManagementResponse(ok: false, result: nil, error: ManagementError(code: code, message: message))
    }
}
