import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayNativePickerTests: XCTestCase {
    func testInspectionReportsThePlacementAndEnablesEditing() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [fixture.inspected(placement: "last", revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        XCTAssertFalse(model.canEditNativePlacement)

        await model.refresh()

        XCTAssertEqual(model.nativePlacement, .last)
        XCTAssertTrue(model.canEditNativePlacement)
    }

    func testSavingSendsTheReviewedRevisionAndAppliesOnlyTheSavedResponse() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(placement: "first", revision: "r1"),
            fixture.inspected(placement: "last", revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setNativePlacement(.last)

        XCTAssertTrue(saved)
        let requests = await bridge.requests()
        let request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.operation, "native-picker")
        XCTAssertEqual(request.nativeModelPickerPlacement, "last")
        XCTAssertEqual(request.revision, "r1")
        XCTAssertEqual(request.configPath, fixture.config.path)
        XCTAssertEqual(model.nativePlacement, .last)
        XCTAssertEqual(model.revision, "r2")
        XCTAssertEqual(model.connections.map(\.id), ["a", "b"])
    }

    func testLastThenHiddenThenFirstEachUsesTheNewestRevision() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(placement: "first", revision: "r1"),
            fixture.inspected(placement: "last", revision: "r2"),
            fixture.inspected(placement: "hidden", revision: "r3"),
            fixture.inspected(placement: "first", revision: "r4"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let toLast = await model.setNativePlacement(.last)
        let toHidden = await model.setNativePlacement(.hidden)
        let toFirst = await model.setNativePlacement(.first)

        XCTAssertTrue(toLast && toHidden && toFirst)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect", "native-picker", "native-picker", "native-picker"])
        XCTAssertEqual(requests.compactMap(\.nativeModelPickerPlacement), ["last", "hidden", "first"])
        XCTAssertEqual(requests.compactMap(\.revision), ["r1", "r2", "r3"])
        XCTAssertEqual(model.nativePlacement, .first)
        XCTAssertEqual(model.revision, "r4")
    }

    func testChoosingTheCurrentPlacementSendsNothing() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [fixture.inspected(placement: "last", revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setNativePlacement(.last)

        XCTAssertTrue(saved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
        XCTAssertEqual(model.revision, "r1")
    }

    func testRefusedSaveKeepsThePlacementRevisionAndShowsAMessage() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(placement: "first", revision: "r1"),
            .failure("configuration_changed", message: "ignored"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setNativePlacement(.hidden)

        XCTAssertFalse(saved)
        XCTAssertEqual(model.nativePlacement, .first)
        XCTAssertEqual(model.revision, "r1")
        XCTAssertEqual(model.message, "Gateway settings changed. Refresh and try again.")
    }

    func testResponseWithADifferentPlacementThanRequestedIsRefused() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(placement: "first", revision: "r1"),
            fixture.inspected(placement: "first", revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setNativePlacement(.last)

        XCTAssertFalse(saved)
        XCTAssertEqual(model.nativePlacement, .first)
        XCTAssertEqual(model.revision, "r1")
        XCTAssertNotNil(model.message)
    }

    func testResponseForAnotherConfigurationIsRefused() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(placement: "first", revision: "r1"),
            fixture.inspected(placement: "last", revision: "r2", path: fixture.otherConfig.path),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setNativePlacement(.last)

        XCTAssertFalse(saved)
        XCTAssertEqual(model.nativePlacement, .first)
        XCTAssertEqual(model.revision, "r1")
    }

    func testWithoutAReviewedSnapshotNothingIsSent() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)

        let saved = await model.setNativePlacement(.last)

        XCTAssertFalse(saved)
        XCTAssertFalse(model.canEditNativePlacement)
        let requests = await bridge.requests()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertNil(model.nativePlacement)
    }

    func testAnOlderResponseWithoutAPlacementLeavesTheControlDisabled() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [fixture.inspected(placement: nil, revision: "r1")])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)

        await model.refresh()

        XCTAssertNil(model.nativePlacement)
        XCTAssertFalse(model.canEditNativePlacement)
        let saved = await model.setNativePlacement(.last)
        XCTAssertFalse(saved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
    }

    func testBusyModelRefusesASaveWithoutSendingARequest() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let pending = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        XCTAssertTrue(model.isBusy)
        XCTAssertFalse(model.canEditNativePlacement)

        let saved = await model.setNativePlacement(.last)

        XCTAssertFalse(saved)
        await bridge.complete(fixture.inspected(placement: "first", revision: "r1"), request: 0)
        await pending.value
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect"])
        XCTAssertEqual(model.nativePlacement, .first)
    }

    func testSharedGatewayConsumerCanSaveLocallyAndKeepsItsGoodCatalog() async throws {
        let fixture = try NativePickerFixture(clientOnly: true)
        defer { fixture.remove() }
        let catalog = SharedGatewaySnapshot(status: "available", hostname: "studio", providers: [
            SharedGatewayProvider(id: "remote", label: "Remote", type: "responses-api", models: [SharedGatewayModel(id: "m", label: "M")]),
        ])
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(ids: [], placement: "first", revision: "r1", shared: catalog),
            // The local save carries no remote read, exactly like the real service response.
            fixture.inspected(ids: [], placement: "last", revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await fixture.gateway.refresh()
        await model.refresh()
        XCTAssertTrue(fixture.gateway.clientOnly)
        XCTAssertEqual(model.sharedGateway, catalog)

        let saved = await model.setNativePlacement(.last)

        XCTAssertTrue(saved)
        XCTAssertEqual(model.nativePlacement, .last)
        XCTAssertEqual(model.revision, "r2")
        XCTAssertEqual(model.sharedGateway, catalog)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.last?.operation, "native-picker")
    }

    func testALaterRefreshStillReplacesTheSharedCatalogSoRealOutagesShow() async throws {
        let fixture = try NativePickerFixture(clientOnly: true)
        defer { fixture.remove() }
        let catalog = SharedGatewaySnapshot(status: "available", hostname: "studio", providers: [])
        let outage = SharedGatewaySnapshot(status: "unavailable")
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(ids: [], placement: "first", revision: "r1", shared: catalog),
            fixture.inspected(ids: [], placement: "last", revision: "r2"),
            fixture.inspected(ids: [], placement: "last", revision: "r2", shared: outage),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await fixture.gateway.refresh()
        await model.refresh()
        _ = await model.setNativePlacement(.last)

        await model.refresh()

        XCTAssertEqual(model.sharedGateway, outage)
        XCTAssertEqual(model.nativePlacement, .last)
    }

    func testConsumerReorderStaysRefusedWhileNativePlacementIsAllowed() async throws {
        let fixture = try NativePickerFixture(clientOnly: true)
        defer { fixture.remove() }
        let bridge = NativePickerBridge(responses: [
            fixture.inspected(ids: [], placement: "first", revision: "r1"),
            fixture.inspected(ids: [], placement: "hidden", revision: "r2"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await fixture.gateway.refresh()
        await model.refresh()

        let reordered = await model.reorder(providerIDs: [])
        let saved = await model.setNativePlacement(.hidden)

        XCTAssertFalse(reordered)
        XCTAssertTrue(saved)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect", "native-picker"])
    }

    func testObsoleteSaveCompletionDoesNotLeakIntoTheNewConfiguration() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(placement: "first", revision: "r1"), request: 0)
        await first.value

        let pendingSave = Task { await model.setNativePlacement(.last) }
        await bridge.waitForRequest(count: 2)
        fixture.gateway.configPath = fixture.otherConfig.path
        let changed = Task { await model.configurationDidChange() }
        await bridge.waitForRequest(count: 3)
        XCTAssertNil(model.nativePlacement)
        await bridge.complete(fixture.inspected(ids: ["x"], placement: "hidden", revision: "o1", path: fixture.otherConfig.path), request: 2)
        await changed.value
        // The old save answers last, with a refusal and with a mismatching result; neither may reach the new configuration.
        await bridge.complete(.failure("configuration_changed", message: "ignored"), request: 1)
        let saved = await pendingSave.value

        XCTAssertFalse(saved)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.nativePlacement, .hidden)
        XCTAssertEqual(model.revision, "o1")
        XCTAssertEqual(model.connections.map(\.id), ["x"])
    }

    func testCancelledAndRetriedSaveCompletionDoesNotLeakIntoTheRetry() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(placement: "first", revision: "r1"), request: 0)
        await first.value

        let pendingSave = Task { await model.setNativePlacement(.last) }
        await bridge.waitForRequest(count: 2)
        model.cancel()
        while model.isBusy { await Task.yield() }
        let retry = Task { await model.refresh() }
        await bridge.waitForRequest(count: 3)
        await bridge.complete(fixture.inspected(placement: "first", revision: "r2"), request: 2)
        await retry.value
        // The cancelled save answers last; it must not write a message or change the retry's snapshot.
        await bridge.complete(.failure("configuration_changed", message: "ignored"), request: 1)
        let saved = await pendingSave.value

        XCTAssertFalse(saved)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.nativePlacement, .first)
        XCTAssertEqual(model.revision, "r2")
    }

    func testSwitchingConfigurationClearsThePlacementUntilTheNewOneIsReviewed() async throws {
        let fixture = try NativePickerFixture()
        defer { fixture.remove() }
        let bridge = NativePickerStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(placement: "hidden", revision: "r1"), request: 0)
        await first.value
        XCTAssertEqual(model.nativePlacement, .hidden)

        fixture.gateway.configPath = fixture.otherConfig.path
        let changed = Task { await model.configurationDidChange() }
        await bridge.waitForRequest(count: 2)

        XCTAssertNil(model.nativePlacement)
        XCTAssertFalse(model.canEditNativePlacement)
        await bridge.complete(fixture.inspected(placement: "last", revision: "o1", path: fixture.otherConfig.path), request: 1)
        await changed.value
        XCTAssertEqual(model.nativePlacement, .last)
    }

    func testRequestEncodesThePlacementAndResultDecodesIt() throws {
        let request = ManagementRequest(operation: "native-picker", configPath: "/tmp/gateway.json", revision: "r1", nativeModelPickerPlacement: "hidden")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(object["operation"] as? String, "native-picker")
        XCTAssertEqual(object["nativeModelPickerPlacement"] as? String, "hidden")
        XCTAssertEqual(object["revision"] as? String, "r1")

        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(ManagementRequest(operation: "inspect", configPath: "/tmp/g.json"))) as? [String: Any])
        XCTAssertNil(plain["nativeModelPickerPlacement"])

        let json = #"{"configPath":"/tmp/g.json","revision":"r","providers":[],"nativeModelPickerPlacement":"last"}"#
        let result = try JSONDecoder().decode(ManagementResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.nativeModelPickerPlacement, "last")
    }

    func testPlacementChoicesAreFirstLastHidden() {
        XCTAssertEqual(NativeModelPickerPlacement.allCases.map(\.title), ["First", "Last", "Hidden"])
        XCTAssertEqual(NativeModelPickerPlacement.allCases.map(\.rawValue), ["first", "last", "hidden"])
    }
}

private actor NativePickerBridge: GatewayManagementRunning {
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

private actor NativePickerStagedBridge: GatewayManagementRunning {
    private var captured: [ManagementRequest] = []
    private var continuations: [CheckedContinuation<ManagementResponse, Never>] = []
    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse {
        captured.append(request)
        return await withCheckedContinuation { continuations.append($0) }
    }
    /// Deliberately inert: a pending request finishes only when the test releases it.
    func cancel() async {}
    func requests() -> [ManagementRequest] { captured }
    func waitForRequest(count: Int) async { while captured.count < count { await Task.yield() } }
    func complete(_ response: ManagementResponse, request index: Int) { continuations[index].resume(returning: response) }
}

@MainActor
private struct NativePickerFixture {
    let home: URL
    let config: URL
    let otherConfig: URL
    let gateway: GatewayModel

    init(clientOnly: Bool = false) throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayNativePickerTests \(UUID().uuidString)")
        config = home.appending(path: "gateway.json")
        otherConfig = home.appending(path: "other.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let content = clientOnly
            ? #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","clientOnly":true,"providers":[]}"#
            : #"{"version":1,"port":3457,"stateDirectory":"/fixture/state","providers":[{"id":"a","type":"responses-api","models":{"one":"one"}}]}"#
        try content.write(to: config, atomically: true, encoding: .utf8)
        try content.write(to: otherConfig, atomically: true, encoding: .utf8)
        let defaults = UserDefaults(suiteName: "GatewayNativePickerTests.\(UUID().uuidString)")!
        gateway = GatewayModel(command: NativePickerStatusRunner(), health: NativePickerHealth(), homeDirectory: home, defaults: defaults)
        gateway.configPath = config.path
    }

    func provider(_ id: String) -> ManagedProvider {
        ManagedProvider(id: id, label: id.uppercased(), type: "responses-api", authState: "saved", authDetail: "Saved",
                        models: [ManagedModel(id: "one", label: "One", enabled: true)], canDiscover: true, canReconnect: false)
    }

    func inspected(
        ids: [String] = ["a", "b"],
        placement: String?,
        revision: String,
        path: String? = nil,
        shared: SharedGatewaySnapshot? = nil
    ) -> ManagementResponse {
        .init(ok: true, result: ManagementResult(
            configPath: path ?? config.path, revision: revision, providers: ids.map(provider), prerequisites: [],
            changed: true, sharedGateway: shared, nativeModelPickerPlacement: placement
        ), error: nil)
    }

    func remove() { try? FileManager.default.removeItem(at: home) }
}

private actor NativePickerStatusRunner: GatewayCommandRunning {
    func run(_ arguments: [String], configPath: String) async -> GatewayCommandResult {
        if arguments.starts(with: ["service"]) { return .init(outcome: .success, stdout: #"{"installed":true,"pid":1}"#) }
        return .init(outcome: .success, stdout: #"{"registered":true,"activeForFutureLaunches":true}"#)
    }
    func hasTrustedCLI() async -> Bool { true }
    func install(configPath: String) async -> GatewayCommandResult { .init(outcome: .success, stdout: "") }
}

private struct NativePickerHealth: GatewayHealthChecking { func check(port: Int) async -> Bool { false } }

private extension ManagementResponse {
    static func failure(_ code: String, message: String) -> ManagementResponse {
        ManagementResponse(ok: false, result: nil, error: ManagementError(code: code, message: message))
    }
}
