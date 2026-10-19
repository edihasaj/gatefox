import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayManagementModelTests: XCTestCase {
    func testManualOnlyModelsAreIncludedWhenCommittingDraft() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let draft = fixture.draft()
        let bridge = ManagementBridge(responses: [
            .success(prerequisites: [], draft: draft),
            .success(configPath: fixture.config.path, revision: "next", providers: [fixture.provider()]),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)

        let prepared = await model.prepare(ProviderInput(label: "API", type: "responses-api"))
        XCTAssertTrue(prepared)
        model.manualModelsText = "  manual-model  \nmanual-model\n"

        let committed = await model.commitDraft()
        XCTAssertTrue(committed)
        let commitRequests = await bridge.requests()
        let request = try XCTUnwrap(commitRequests.last)
        XCTAssertEqual(request.operation, "commit")
        XCTAssertEqual(request.selectedModels, ["manual-model"])
        XCTAssertEqual(request.manualModels, ["manual-model"])
    }

    func testManualOnlyModelsAreIncludedWhenSavingProvider() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let updated = fixture.provider(models: [ManagedModel(id: "manual-model", label: "Manual", enabled: true)])
        let bridge = ManagementBridge(responses: [
            .success(configPath: fixture.config.path, revision: "base", providers: [fixture.provider()], prerequisites: []),
            .success(configPath: fixture.config.path, revision: "next", providers: [updated]),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        model.beginEditing(fixture.provider())
        model.selectedModels = []
        model.manualModelsText = "manual-model\n manual-model"

        let saved = await model.saveModels(providerID: fixture.provider().id)
        XCTAssertTrue(saved)
        let saveRequests = await bridge.requests()
        let request = try XCTUnwrap(saveRequests.last)
        XCTAssertEqual(request.operation, "models")
        XCTAssertEqual(request.selectedModels, ["manual-model"])
        XCTAssertEqual(request.manualModels, ["manual-model"])
    }

    func testFailedDiscoveryForBLeavesOnlyBScopedModels() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let providerB = ManagedProvider(
            id: "b", label: "B", type: "responses-api", authState: "saved", authDetail: "Saved",
            models: [ManagedModel(id: "b-model", label: "B", enabled: true)], canDiscover: true, canReconnect: true
        )
        let bridge = ManagementBridge(responses: [
            .success(configPath: fixture.config.path, revision: "base", providers: [fixture.provider(), providerB], prerequisites: []),
            .failure("discovery_failed", message: "ignored"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        model.beginEditing(fixture.provider())
        model.manualModelsText = "a-manual"
        model.beginEditing(providerB)

        let discovered = await model.discover(providerID: providerB.id)
        XCTAssertFalse(discovered)
        XCTAssertEqual(model.modelEditingProviderID, providerB.id)
        XCTAssertEqual(model.availableModels.map(\.id), ["b-model"])
        XCTAssertEqual(model.selectedModels, ["b-model"])
        XCTAssertTrue(model.manualModelsText.isEmpty)
    }

    func testConfigurationChangeCancelsOldInspectAndQueuesLatestInspect() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let bridge = DelayedManagementBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let firstRefresh = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        fixture.gateway.configPath = fixture.otherConfig.path

        let changed = Task { await model.configurationDidChange() }
        XCTAssertTrue(model.connections.isEmpty)
        XCTAssertNil(model.revision)
        XCTAssertNil(model.draft)
        await bridge.waitForRequest(count: 2)
        await bridge.finishNext(.success(configPath: fixture.otherConfig.path, revision: "other", providers: [fixture.provider()], prerequisites: []))
        await changed.value
        await firstRefresh.value

        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.configPath), [fixture.config.path, fixture.otherConfig.path])
        XCTAssertEqual(model.revision, "other")
    }

    func testFailedPrepareDiscardsOldDraftInsteadOfReusingIt() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let bridge = ManagementBridge(responses: [
            .success(prerequisites: [], draft: fixture.draft(id: "old")),
            .success(configPath: fixture.config.path),
            .failure("invalid_provider", message: "ignored"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let firstPrepare = await model.prepare(ProviderInput(label: "API", type: "responses-api"))
        XCTAssertTrue(firstPrepare)

        let secondPrepare = await model.prepare(ProviderInput(label: "Other", type: "anthropic-api"))
        XCTAssertFalse(secondPrepare)
        XCTAssertNil(model.draft)
        let prepareRequests = await bridge.requests()
        XCTAssertEqual(prepareRequests.map(\.operation), ["prepare", "discard", "prepare"])
    }

    func testCancelledAuthenticationReturnsFalseBeforeDiscoveryCanRun() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let bridge = DelayedManagementBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let draft = fixture.draft()
        await bridge.enqueue(.success(prerequisites: [], draft: draft))
        let prepared = await model.prepare(ProviderInput(label: "API", type: "responses-api"))
        XCTAssertTrue(prepared)

        let authentication = Task { await model.authenticate() }
        await bridge.waitForRequest(count: 2)
        model.cancel()
        let authenticated = await authentication.value
        XCTAssertFalse(authenticated)
        let authenticationRequests = await bridge.requests()
        XCTAssertEqual(authenticationRequests.map(\.operation), ["prepare", "authenticate"])
    }

    func testReplacingAPIKeyUsesProviderInputAndRevision() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let reconnectable = fixture.provider(canReconnect: true)
        let bridge = ManagementBridge(responses: [
            .success(configPath: fixture.config.path, revision: "base", providers: [reconnectable], prerequisites: []),
            .success(configPath: fixture.config.path, revision: "next", providers: [reconnectable]),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let replaced = await model.replaceCredentials(providerID: reconnectable.id, apiKey: "example-key")
        XCTAssertTrue(replaced)
        let credentialRequests = await bridge.requests()
        let request = try XCTUnwrap(credentialRequests.last)
        XCTAssertEqual(request.operation, "authenticate")
        XCTAssertEqual(request.providerId, reconnectable.id)
        XCTAssertEqual(request.revision, "base")
        XCTAssertEqual(request.provider?.label, reconnectable.label)
        XCTAssertEqual(request.provider?.type, reconnectable.type)
        XCTAssertEqual(request.provider?.apiKey, "example-key")
    }

    func testSaveWorkflowSerializesConcurrentModelChanges() async throws {
        let fixture = try ModelFixture()
        defer { fixture.remove() }
        let bridge = DelayedManagementBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await bridge.enqueue(.success(configPath: fixture.config.path, revision: "base", providers: [fixture.provider()], prerequisites: []))
        await model.refresh()
        model.beginEditing(fixture.provider())
        let firstSave = Task { await model.saveModels(providerID: fixture.provider().id) }
        await bridge.waitForRequest(count: 2)

        let secondSave = await model.saveModels(providerID: fixture.provider().id)
        XCTAssertFalse(secondSave)
        let pendingRequests = await bridge.requests()
        XCTAssertEqual(pendingRequests.count, 2)
        await bridge.finishNext(.success(configPath: fixture.config.path, revision: "next", providers: [fixture.provider()]))
        let firstSaveResult = await firstSave.value
        XCTAssertTrue(firstSaveResult)
    }
}

private actor ManagementBridge: GatewayManagementRunning {
    private var queued: [ManagementResponse]
    private var captured: [ManagementRequest] = []

    init(responses: [ManagementResponse]) { queued = responses }

    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        return queued.isEmpty ? .failure("invalid_request", message: "ignored") : queued.removeFirst()
    }

    func cancel() async {}
    func requests() -> [ManagementRequest] { captured }
}

private actor DelayedManagementBridge: GatewayManagementRunning {
    private var queued: [ManagementResponse] = []
    private var captured: [ManagementRequest] = []
    private var continuations: [CheckedContinuation<ManagementResponse, Never>] = []

    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        if !queued.isEmpty { return queued.removeFirst() }
        return await withCheckedContinuation { continuations.append($0) }
    }

    func cancel() async { await finishNext(.failure("cancelled", message: "ignored")) }
    func enqueue(_ response: ManagementResponse) { queued.append(response) }
    func requests() -> [ManagementRequest] { captured }
    func finishNext(_ response: ManagementResponse) {
        guard !continuations.isEmpty else { queued.append(response); return }
        continuations.removeFirst().resume(returning: response)
    }

    func waitForRequest(count: Int) async {
        while captured.count < count { await Task.yield() }
    }
}

@MainActor
private struct ModelFixture {
    let home: URL
    let config: URL
    let otherConfig: URL
    let gateway: GatewayModel

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayManagementModelTests \(UUID().uuidString)")
        config = home.appending(path: "gateway.json")
        otherConfig = home.appending(path: "other.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let content = #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"api","type":"responses-api","models":{"one":"one"}}]}"#
        try content.write(to: config, atomically: true, encoding: .utf8)
        try content.write(to: otherConfig, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "GatewayManagementModelTests.\(UUID().uuidString)")!
        gateway = GatewayModel(command: ManagementStatusRunner(), health: ManagementHealth(), homeDirectory: home, defaults: defaults)
        gateway.configPath = config.path
    }

    func provider(
        models: [ManagedModel] = [ManagedModel(id: "one", label: "One", enabled: true)],
        canReconnect: Bool = false
    ) -> ManagedProvider {
        ManagedProvider(id: "api", label: "API", type: "responses-api", authState: "saved", authDetail: "Saved", models: models, canDiscover: true, canReconnect: canReconnect)
    }

    func draft(id: String = "draft") -> ManagedDraft {
        ManagedDraft(id: id, provider: provider(), revision: "base", configPath: config.path, isNewConfiguration: false)
    }

    func remove() { try? FileManager.default.removeItem(at: home) }
}

private actor ManagementStatusRunner: GatewayCommandRunning {
    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        if arguments.starts(with: ["service"]) { return .init(outcome: .success, stdout: #"{"installed":true,"pid":1}"#) }
        return .init(outcome: .success, stdout: #"{"registered":true,"activeForFutureLaunches":true}"#)
    }
    func hasTrustedCLI() async -> Bool { true }
    func install(configPath: String) async -> GatewayCommandResult { .init(outcome: .success, stdout: "") }
}

private struct ManagementHealth: GatewayHealthChecking { func check(port: Int) async -> Bool { false } }

private extension ManagementResponse {
    static func success(
        configPath: String? = nil,
        revision: String? = nil,
        providers: [ManagedProvider]? = nil,
        prerequisites: [ManagementPrerequisite]? = nil,
        draft: ManagedDraft? = nil,
        models: [ManagedModel]? = nil
    ) -> ManagementResponse {
        .init(ok: true, result: .init(configPath: configPath, revision: revision, providers: providers, prerequisites: prerequisites, draft: draft, models: models, changed: nil, removed: nil), error: nil)
    }
}
