import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayConnectionOrderTests: XCTestCase {
    func testMoveUpSavesTheFullOrderWithTheReviewedRevisionAndAppliesTheSavedResponse() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [
            fixture.inspected(["a", "b", "c"], revision: "r1"),
            fixture.inspected(["b", "a", "c"], revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "b", to: 0)

        XCTAssertTrue(moved)
        let requests = await bridge.requests()
        let request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.operation, "reorder")
        XCTAssertEqual(request.providerIds, ["b", "a", "c"])
        XCTAssertEqual(request.revision, "r1")
        XCTAssertEqual(request.configPath, fixture.config.path)
        XCTAssertEqual(model.connections.map(\.id), ["b", "a", "c"])
        XCTAssertEqual(model.revision, "r2")
    }

    func testMoveDownSavesTheNextPosition() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [
            fixture.inspected(["a", "b", "c"], revision: "r1"),
            fixture.inspected(["b", "a", "c"], revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "a", to: 1)

        XCTAssertTrue(moved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.last?.providerIds, ["b", "a", "c"])
        XCTAssertEqual(model.connections.map(\.id), ["b", "a", "c"])
    }

    func testOutOfBoundsAndUnknownMovesSendNothingAndKeepTheOrder() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [fixture.inspected(["a", "b", "c"], revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let aboveTop = await model.move(providerID: "a", to: -1)
        let belowBottom = await model.move(providerID: "c", to: 3)
        let unknown = await model.move(providerID: "missing", to: 0)

        XCTAssertFalse(aboveTop)
        XCTAssertFalse(belowBottom)
        XCTAssertFalse(unknown)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
        XCTAssertEqual(model.connections.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(model.revision, "r1")
    }

    func testMovingToTheCurrentPositionIsANoOpWithoutARequest() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [fixture.inspected(["a", "b"], revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "a", to: 0)

        XCTAssertTrue(moved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
    }

    func testRefusedSaveKeepsTheDisplayedOrderRevisionAndShowsAMessage() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [
            fixture.inspected(["a", "b", "c"], revision: "r1"),
            .failure("configuration_changed", message: "ignored"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "c", to: 0)

        XCTAssertFalse(moved)
        XCTAssertEqual(model.connections.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(model.revision, "r1")
        XCTAssertEqual(model.message, "Gateway settings changed. Refresh and try again.")
    }

    func testResponseWithADifferentOrderThanRequestedIsRefused() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [
            fixture.inspected(["a", "b", "c"], revision: "r1"),
            fixture.inspected(["a", "b", "c"], revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "c", to: 0)

        XCTAssertFalse(moved)
        XCTAssertEqual(model.connections.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(model.revision, "r1")
        XCTAssertNotNil(model.message)
    }

    func testResponseForAnotherConfigurationIsRefused() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [
            fixture.inspected(["a", "b"], revision: "r1"),
            .success(configPath: fixture.otherConfig.path, revision: "r2", providers: ["b", "a"].map(fixture.provider)),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let moved = await model.move(providerID: "b", to: 0)

        XCTAssertFalse(moved)
        XCTAssertEqual(model.connections.map(\.id), ["a", "b"])
        XCTAssertEqual(model.revision, "r1")
    }

    func testClientOnlyConsumerNeverSendsAReorder() async throws {
        let fixture = try OrderFixture(clientOnly: true)
        defer { fixture.remove() }
        let bridge = OrderBridge(responses: [fixture.inspected(["a", "b"], revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await fixture.gateway.refresh()
        await model.refresh()
        XCTAssertTrue(fixture.gateway.clientOnly)

        let moved = await model.move(providerID: "b", to: 0)
        let reordered = await model.reorder(providerIDs: ["b", "a"])

        XCTAssertFalse(moved)
        XCTAssertFalse(reordered)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
        XCTAssertEqual(model.connections.map(\.id), ["a", "b"])
    }

    func testBusyModelRefusesAMoveWithoutSendingARequest() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderHoldingBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let pending = Task { await model.refresh() }
        await bridge.waitForRequest()
        XCTAssertTrue(model.isBusy)

        let moved = await model.move(providerID: "b", to: 0)

        XCTAssertFalse(moved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
        await bridge.release(fixture.inspected(["a", "b"], revision: "r1"))
        await pending.value
        XCTAssertEqual(model.connections.map(\.id), ["a", "b"])
    }

    func testObsoleteReorderCompletionDoesNotLeakIntoTheNewConfiguration() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(["a", "b"], revision: "r1"), request: 0)
        await first.value

        let pendingMove = Task { await model.move(providerID: "b", to: 0) }
        await bridge.waitForRequest(count: 2)
        fixture.gateway.configPath = fixture.otherConfig.path
        let changed = Task { await model.configurationDidChange() }
        await bridge.waitForRequest(count: 3)
        await bridge.complete(.success(configPath: fixture.otherConfig.path, revision: "o1", providers: [fixture.provider("x")], prerequisites: []), request: 2)
        await changed.value
        // The old save answers last, with a refusal and with a mismatching order; neither may reach the new configuration.
        await bridge.complete(.failure("configuration_changed", message: "ignored"), request: 1)
        let moved = await pendingMove.value

        XCTAssertFalse(moved)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.connections.map(\.id), ["x"])
        XCTAssertEqual(model.revision, "o1")
    }

    func testCancelledAndRetriedReorderCompletionDoesNotLeakIntoTheRetry() async throws {
        let fixture = try OrderFixture()
        defer { fixture.remove() }
        let bridge = OrderStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(["a", "b"], revision: "r1"), request: 0)
        await first.value

        let pendingMove = Task { await model.move(providerID: "b", to: 0) }
        await bridge.waitForRequest(count: 2)
        model.cancel()
        while model.isBusy { await Task.yield() }
        let retry = Task { await model.refresh() }
        await bridge.waitForRequest(count: 3)
        await bridge.complete(fixture.inspected(["a", "b"], revision: "r2"), request: 2)
        await retry.value
        // The cancelled save answers last; it must not write a message or change the retry's snapshot.
        await bridge.complete(.failure("configuration_changed", message: "ignored"), request: 1)
        let moved = await pendingMove.value

        XCTAssertFalse(moved)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.connections.map(\.id), ["a", "b"])
        XCTAssertEqual(model.revision, "r2")
    }

    func testReorderRequestEncodesProviderIds() throws {
        let request = ManagementRequest(operation: "reorder", configPath: "/tmp/gateway.json", revision: "r1", providerIds: ["b", "a"])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(object["operation"] as? String, "reorder")
        XCTAssertEqual(object["providerIds"] as? [String], ["b", "a"])
        XCTAssertEqual(object["revision"] as? String, "r1")
    }
}

private actor OrderBridge: GatewayManagementRunning {
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

private actor OrderHoldingBridge: GatewayManagementRunning {
    private var captured: [ManagementRequest] = []
    private var continuation: CheckedContinuation<ManagementResponse, Never>?
    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        return await withCheckedContinuation { continuation = $0 }
    }
    func cancel() async {}
    func requests() -> [ManagementRequest] { captured }
    func waitForRequest() async { while continuation == nil { await Task.yield() } }
    func release(_ response: ManagementResponse) { continuation?.resume(returning: response); continuation = nil }
}

private actor OrderStagedBridge: GatewayManagementRunning {
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
private struct OrderFixture {
    let home: URL
    let config: URL
    let otherConfig: URL
    let gateway: GatewayModel

    init(clientOnly: Bool = false) throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayConnectionOrderTests \(UUID().uuidString)")
        config = home.appending(path: "gateway.json")
        otherConfig = home.appending(path: "other.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let content = clientOnly
            ? #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","clientOnly":true,"providers":[]}"#
            : #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"a","type":"responses-api","models":{"one":"one"}}]}"#
        try content.write(to: config, atomically: true, encoding: .utf8)
        try content.write(to: otherConfig, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "GatewayConnectionOrderTests.\(UUID().uuidString)")!
        gateway = GatewayModel(command: OrderStatusRunner(), health: OrderHealth(), homeDirectory: home, defaults: defaults)
        gateway.configPath = config.path
    }

    func provider(_ id: String) -> ManagedProvider {
        ManagedProvider(id: id, label: id.uppercased(), type: "responses-api", authState: "saved", authDetail: "Saved",
                        models: [ManagedModel(id: "one", label: "One", enabled: true)], canDiscover: true, canReconnect: false)
    }

    func inspected(_ ids: [String], revision: String) -> ManagementResponse {
        .success(configPath: config.path, revision: revision, providers: ids.map(provider), prerequisites: [])
    }

    func remove() { try? FileManager.default.removeItem(at: home) }
}

private actor OrderStatusRunner: GatewayCommandRunning {
    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        if arguments.starts(with: ["service"]) { return .init(outcome: .success, stdout: #"{"installed":true,"pid":1}"#) }
        return .init(outcome: .success, stdout: #"{"registered":true,"activeForFutureLaunches":true}"#)
    }
    func hasTrustedCLI() async -> Bool { true }
    func install(configPath: String) async -> GatewayCommandResult { .init(outcome: .success, stdout: "") }
}

private struct OrderHealth: GatewayHealthChecking { func check(port: Int) async -> Bool { false } }

private extension ManagementResponse {
    static func success(configPath: String?, revision: String?, providers: [ManagedProvider]?, prerequisites: [ManagementPrerequisite]? = nil) -> ManagementResponse {
        .init(ok: true, result: .init(configPath: configPath, revision: revision, providers: providers, prerequisites: prerequisites, changed: true), error: nil)
    }
}
