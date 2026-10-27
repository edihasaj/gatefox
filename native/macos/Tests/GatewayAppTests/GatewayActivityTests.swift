import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayActivityTests: XCTestCase {
    private func report(coverage: String = "available", state: String = "completed", source: String = "sdk") -> GatewayActivityReport {
        let at = ISO8601DateFormatter.string(from: Date(), timeZone: .gmt, formatOptions: [.withInternetDateTime, .withFractionalSeconds])
        return GatewayActivityReport(version: 1, hostname: "fixture", checkedAt: at, coverage: coverage, hasMore: false,
            rows: [GatewayActivityRow(threadId: "thread-one", name: "Fixture", model: nil, isSubagent: false,
                state: state, source: source, observedAt: at, turn: GatewayActivityTurn(id: "turn-one", status: "completed", completedAt: at, errorClass: nil))])
    }

    func testActivityRefreshUsesReadOnlyOperationAndClearsOnFailure() async {
        let bridge = AutoLatestBridge(responses: [
            .init(ok: true, result: ManagementResult(configPath: "/a", activity: report()), error: nil),
            .failure("unavailable", message: "private error"),
        ])
        let model = GatewayActivityModel(bridge: bridge)
        await model.refresh("/a")
        XCTAssertEqual(model.report?.rows.first?.state, "completed")
        await model.refresh("/a")
        XCTAssertNil(model.report)
        XCTAssertFalse(model.message?.contains("private error") ?? true)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["activity", "activity"])
    }

    func testSelectingAnotherConfigurationRejectsOldCompletionEvenAfterSwitchingBack() async {
        let bridge = AutoLatestStagedBridge()
        let model = GatewayActivityModel(bridge: bridge)
        let task = Task { await model.refresh("/a") }
        await bridge.waitForRequest(count: 1)
        model.select("/b")
        model.select("/a")
        await bridge.complete(.init(ok: true, result: ManagementResult(configPath: "/a", activity: report()), error: nil), request: 0)
        await task.value
        XCTAssertNil(model.report)
    }

    func testRecordedOutcomeCannotClaimLiveRunningStatus() async {
        let bridge = AutoLatestBridge(responses: [
            .init(ok: true, result: ManagementResult(configPath: "/a", activity: report(state: "running", source: "recorded")), error: nil),
            .init(ok: true, result: ManagementResult(configPath: "/a", activity: report(coverage: "unavailable", state: "unknown", source: "recorded")), error: nil),
        ])
        let model = GatewayActivityModel(bridge: bridge)
        await model.refresh("/a")
        XCTAssertNil(model.report)
        await model.refresh("/a")
        XCTAssertEqual(model.report?.coverage, "unavailable")
        XCTAssertEqual(model.report?.rows.first?.state, "unknown")
        XCTAssertEqual(model.report?.rows.first?.turn?.status, "completed")
    }

    func testCancelledViewCannotPublishItsPendingResult() async {
        let bridge = AutoLatestStagedBridge()
        let model = GatewayActivityModel(bridge: bridge)
        let task = Task { await model.refresh("/a") }
        await bridge.waitForRequest(count: 1)
        task.cancel()
        await bridge.complete(.init(ok: true, result: ManagementResult(configPath: "/a", activity: report()), error: nil), request: 0)
        await task.value
        XCTAssertNil(model.report)
        XCTAssertFalse(model.isBusy)
    }
}
