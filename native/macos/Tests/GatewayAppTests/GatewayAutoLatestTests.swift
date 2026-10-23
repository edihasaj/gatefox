import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayAutoLatestTests: XCTestCase {
    func testInspectionReportsStateAndEnablesEditing() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [fixture.inspected(revision: "r1", status: fixture.status(enabled: false))])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        XCTAssertFalse(model.canEditAutoLatest)

        await model.refresh()

        XCTAssertEqual(model.autoLatest?.enabled, false)
        XCTAssertTrue(model.canEditAutoLatest)
        XCTAssertFalse(model.canCheckAutoLatest)
        XCTAssertEqual(model.autoLatest?.familyLines, ["Codex Main · Astra, Sol, Terra, Luna, Daybreak", "Claude · Fable, Opus, Sonnet, Haiku"])
    }

    func testEnableSendsEnabledAndReviewedRevisionAndAppliesTheSavedResponse() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false)),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: true)),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setAutoLatest(true)

        XCTAssertTrue(saved)
        let sent1 = await bridge.requests()
        let request = try XCTUnwrap(sent1.last)
        XCTAssertEqual(request.operation, "auto-latest")
        XCTAssertEqual(request.enabled, true)
        XCTAssertEqual(request.revision, "r1")
        XCTAssertEqual(request.configPath, fixture.config.path)
        XCTAssertNil(request.selectedModels)
        XCTAssertNil(request.providerIds)
        XCTAssertEqual(model.autoLatest?.enabled, true)
        XCTAssertEqual(model.revision, "r2")
        XCTAssertTrue(model.canCheckAutoLatest)
    }

    func testDisableSendsOnlyTheFlagAndUsesTheNewestRevision() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false)),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: true)),
            fixture.inspected(revision: "r3", status: fixture.status(enabled: false)),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let on = await model.setAutoLatest(true)
        let off = await model.setAutoLatest(false)

        XCTAssertTrue(on && off)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["inspect", "auto-latest", "auto-latest"])
        XCTAssertEqual(requests.compactMap(\.enabled), [true, false])
        XCTAssertEqual(requests.compactMap(\.revision), ["r1", "r2"])
        // Turning off sends no model selection, so it cannot enable or re-enable any model.
        XCTAssertNil(requests.last?.selectedModels)
        XCTAssertNil(requests.last?.manualModels)
        XCTAssertEqual(model.autoLatest?.enabled, false)
        XCTAssertEqual(model.revision, "r3")
    }

    func testChoosingTheCurrentStateSendsNothing() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [fixture.inspected(revision: "r1", status: fixture.status(enabled: true))])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setAutoLatest(true)

        XCTAssertTrue(saved)
        let sent2 = await bridge.requests()
        XCTAssertEqual(sent2.map(\.operation), ["inspect"])
    }

    func testStateDoesNotChangeOptimisticallyWhileTheSaveIsPending() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(revision: "r1", status: fixture.status(enabled: false)), request: 0)
        await first.value

        let pending = Task { await model.setAutoLatest(true) }
        await bridge.waitForRequest(count: 2)

        XCTAssertEqual(model.autoLatest?.enabled, false)
        XCTAssertTrue(model.isBusy)
        XCTAssertFalse(model.canEditAutoLatest)
        let second = await model.setAutoLatest(false)
        XCTAssertFalse(second)
        await bridge.complete(fixture.inspected(revision: "r2", status: fixture.status(enabled: true)), request: 1)
        let saved = await pending.value
        XCTAssertTrue(saved)
        XCTAssertEqual(model.autoLatest?.enabled, true)
        XCTAssertEqual(model.revision, "r2")
    }

    func testRefusedSaveKeepsStateRevisionAndShowsAMessage() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false)),
            .refused("configuration_changed", message: "ignored"),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let saved = await model.setAutoLatest(true)

        XCTAssertFalse(saved)
        XCTAssertEqual(model.autoLatest?.enabled, false)
        XCTAssertEqual(model.revision, "r1")
        XCTAssertEqual(model.message, "Gateway settings changed. Refresh and try again.")
    }

    func testMismatchedMissingOrForeignResponsesAreRefused() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false)),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: false)), // not the requested state
            fixture.inspected(revision: "r3", status: nil), // no autoLatest at all
            fixture.inspected(revision: "r4", status: fixture.status(enabled: true), path: fixture.otherConfig.path),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        for _ in 0..<3 {
            let saved = await model.setAutoLatest(true)
            XCTAssertFalse(saved)
            XCTAssertEqual(model.autoLatest?.enabled, false)
            XCTAssertEqual(model.revision, "r1")
            XCTAssertNotNil(model.message)
        }
    }

    func testWithoutAReviewedSnapshotNothingIsSent() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)

        let saved = await model.setAutoLatest(true)
        let checked = await model.checkAutoLatestNow()

        XCTAssertFalse(saved || checked)
        let sent3 = await bridge.requests()
        XCTAssertTrue(sent3.isEmpty)
    }

    func testOlderResponseWithoutTheFieldMeansUnavailableNotInherited() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: true)),
            fixture.inspected(revision: "r2", status: nil),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        XCTAssertEqual(model.autoLatest?.enabled, true)

        await model.refresh()

        XCTAssertNil(model.autoLatest)
        XCTAssertFalse(model.canEditAutoLatest)
        let saved = await model.setAutoLatest(false)
        XCTAssertFalse(saved)
        let sent4 = await bridge.requests()
        XCTAssertEqual(sent4.map(\.operation), ["inspect", "inspect"])
    }

    func testCancelledAndRetriedSaveDoesNotLeakIntoTheRetry() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(revision: "r1", status: fixture.status(enabled: false)), request: 0)
        await first.value

        let pending = Task { await model.setAutoLatest(true) }
        await bridge.waitForRequest(count: 2)
        model.cancel()
        while model.isBusy { await Task.yield() }
        let retry = Task { await model.refresh() }
        await bridge.waitForRequest(count: 3)
        await bridge.complete(fixture.inspected(revision: "r2", status: fixture.status(enabled: false)), request: 2)
        await retry.value
        await bridge.complete(fixture.inspected(revision: "r9", status: fixture.status(enabled: true)), request: 1)
        let saved = await pending.value

        XCTAssertFalse(saved)
        XCTAssertNil(model.message)
        XCTAssertEqual(model.autoLatest?.enabled, false)
        XCTAssertEqual(model.revision, "r2")
    }

    func testSwitchingConfigurationClearsStateAndIgnoresTheOldCompletion() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestStagedBridge()
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        let first = Task { await model.refresh() }
        await bridge.waitForRequest(count: 1)
        await bridge.complete(fixture.inspected(revision: "r1", status: fixture.status(enabled: true)), request: 0)
        await first.value
        XCTAssertEqual(model.autoLatest?.enabled, true)

        let pending = Task { await model.setAutoLatest(false) }
        await bridge.waitForRequest(count: 2)
        fixture.gateway.configPath = fixture.otherConfig.path
        let changed = Task { await model.configurationDidChange() }
        await bridge.waitForRequest(count: 3)
        XCTAssertNil(model.autoLatest)
        XCTAssertFalse(model.canEditAutoLatest)
        // The new configuration's older gateway does not report the field: unavailable, not the old value.
        await bridge.complete(fixture.inspected(ids: ["x"], revision: "o1", status: nil, path: fixture.otherConfig.path), request: 2)
        await changed.value
        await bridge.complete(.refused("configuration_changed", message: "ignored"), request: 1)
        let saved = await pending.value

        XCTAssertFalse(saved)
        XCTAssertNil(model.message)
        XCTAssertNil(model.autoLatest)
        XCTAssertEqual(model.revision, "o1")
        XCTAssertEqual(model.connections.map(\.id), ["x"])
    }

    func testSharedGatewayConsumerSavesLocallyAndKeepsItsCatalogButCannotReorder() async throws {
        let fixture = try AutoLatestFixture(clientOnly: true)
        defer { fixture.remove() }
        let catalog = SharedGatewaySnapshot(status: "available", hostname: "studio", providers: [
            SharedGatewayProvider(id: "remote", label: "Remote", type: "responses-api", models: [SharedGatewayModel(id: "m", label: "M")]),
        ])
        let local = AutoLatestStatus(enabled: false, intervalMinutes: 5, families: [], nativeFamilies: ["Astra", "Sol"],
                                     scheduled: nil, lastCheckedAt: nil, lastOutcome: nil)
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(ids: [], revision: "r1", status: local, shared: catalog),
            // A local save carries no remote read, exactly like the real service response.
            fixture.inspected(ids: [], revision: "r2", status: AutoLatestStatus(enabled: true, intervalMinutes: 5, families: [], nativeFamilies: ["Astra", "Sol"],
                                                                                   scheduled: true, lastCheckedAt: nil, lastOutcome: nil)),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await fixture.gateway.refresh()
        await model.refresh()
        XCTAssertTrue(fixture.gateway.clientOnly)

        let reordered = await model.reorder(providerIDs: [])
        let saved = await model.setAutoLatest(true)

        XCTAssertFalse(reordered)
        XCTAssertTrue(saved)
        XCTAssertEqual(model.sharedGateway, catalog)
        XCTAssertEqual(model.autoLatest?.enabled, true)
        XCTAssertEqual(model.autoLatest?.nativeLine, "Astra, Sol")
        XCTAssertEqual(model.autoLatest?.families, [])
        let sent5 = await bridge.requests()
        XCTAssertEqual(sent5.map(\.operation), ["inspect", "auto-latest"])
    }

    func testCheckNowSendsTheReviewedRevisionWithoutAFlagAndRequiresALastCheckTime() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let checkedAt = Date().timeIntervalSince1970
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: true)),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: true, lastCheckedAt: checkedAt, outcome: "no_change")),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()

        let checked = await model.checkAutoLatestNow()

        XCTAssertTrue(checked)
        let sent6 = await bridge.requests()
        let request = try XCTUnwrap(sent6.last)
        XCTAssertEqual(request.operation, "auto-latest-check")
        XCTAssertEqual(request.revision, "r1")
        XCTAssertNil(request.enabled)
        XCTAssertNil(request.selectedModels)
        XCTAssertEqual(model.revision, "r2")
        XCTAssertNotNil(model.autoLatest?.lastChecked)
        XCTAssertEqual(model.autoLatest?.outcomeText, "No change")
    }

    func testCheckNowIsRefusedWhenOffOrWhenTheResponseHasNoValidLastCheck() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false)),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: true)),
            fixture.inspected(revision: "r3", status: fixture.status(enabled: true)), // enable
            fixture.inspected(revision: "r4", status: fixture.status(enabled: true, lastCheckedAt: -5)), // invalid time
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        let whileOff = await model.checkAutoLatestNow()
        XCTAssertFalse(whileOff)
        let sent7 = await bridge.requests()
        XCTAssertEqual(sent7.map(\.operation), ["inspect"])

        let enabled = await model.setAutoLatest(true)
        XCTAssertTrue(enabled)
        let checked = await model.checkAutoLatestNow()

        XCTAssertFalse(checked)
        XCTAssertEqual(model.revision, "r2")
        XCTAssertNil(model.autoLatest?.lastChecked)
        XCTAssertNotNil(model.message)
    }

    func testSchedulingFailureIsNeverReportedAsPolling() {
        func status(_ scheduled: Bool?) -> AutoLatestStatus {
            AutoLatestStatus(enabled: true, intervalMinutes: 5, families: [], nativeFamilies: [], scheduled: scheduled, lastCheckedAt: nil, lastOutcome: nil)
        }
        XCTAssertEqual(status(true).polling, .running)
        XCTAssertEqual(status(false).polling, .notScheduled)
        XCTAssertEqual(status(nil).polling, .unknown)
    }

    func testSchedulingFailureSurvivesAnEnabledSavedState() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let bridge = AutoLatestBridge(responses: [fixture.inspected(revision: "r1", status: fixture.status(enabled: true, scheduled: false))])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)

        await model.refresh()

        XCTAssertEqual(model.autoLatest?.enabled, true)
        XCTAssertEqual(model.autoLatest?.polling, .notScheduled)
    }

    func testKnownSchedulerFailureSurvivesALaterInspectAndClearsWhenOff() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        var failed = fixture.status(enabled: true, scheduled: false)
        failed = AutoLatestStatus(enabled: true, intervalMinutes: 5, families: failed.families, nativeFamilies: [],
                                  scheduled: false, scheduleReason: "launchd_install_failed")
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: false, scheduled: nil)),
            fixture.inspected(revision: "r2", status: failed),
            fixture.inspected(revision: "r2", status: fixture.status(enabled: true, scheduled: nil)), // inspect omits scheduling
            fixture.inspected(revision: "r3", status: fixture.status(enabled: false, scheduled: nil)),
            fixture.inspected(revision: "r3", status: fixture.status(enabled: true, scheduled: nil)),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        _ = await model.setAutoLatest(true)
        XCTAssertEqual(model.autoLatest?.polling, .notScheduled)

        await model.refresh()
        XCTAssertEqual(model.autoLatest?.polling, .notScheduled)
        XCTAssertEqual(model.autoLatest?.scheduleReason, "launchd_install_failed")

        _ = await model.setAutoLatest(false)
        XCTAssertEqual(model.autoLatest?.polling, .unknown)
        await model.refresh()
        XCTAssertEqual(model.autoLatest?.polling, .unknown, "polling is never assumed from a missing field")
    }
}
