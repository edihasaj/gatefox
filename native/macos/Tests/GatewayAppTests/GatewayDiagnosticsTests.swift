import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayDiagnosticsTests: XCTestCase {
    private func report(hours: Int = 1, cacheSamples: Int = 1, hit: Double? = 0) -> GatewayDiagnosticsReport {
        let at = ISO8601DateFormatter.string(from: Date(), timeZone: .gmt, formatOptions: [.withInternetDateTime, .withFractionalSeconds])
        return GatewayDiagnosticsReport(version: 1, hostname: "fixture", checkedAt: at, since: at, hours: hours,
            models: [GatewayCacheDiagnostic(model: "copilot/test", requests: 2, failed: 1, usageSamples: 2,
                cacheSamples: cacheSamples, cacheWriteSamples: 0, inputTokens: 100, cachedTokens: 0,
                cacheInputTokens: cacheSamples > 0 ? 100 : 0, cacheWriteTokens: 0, outputTokens: 10, cacheHitPercent: hit)],
            sessions: [], issues: [], hasMoreModels: false, hasMoreIssues: false)
    }

    func testUnknownAndMeasuredZeroCacheAreDifferent() {
        XCTAssertEqual(report().models[0].hitLabel, "0%")
        XCTAssertEqual(report(cacheSamples: 0, hit: nil).models[0].hitLabel, "Not reported")
        XCTAssertFalse(report(cacheSamples: 0, hit: 50).models[0].isValid)
    }

    func testRefreshUsesSelectedWindowAndClearsStaleDataAfterFailure() async {
        let bridge = AutoLatestBridge(responses: [
            .init(ok: true, result: ManagementResult(configPath: "/a", diagnostics: report(hours: 24)), error: nil),
            .failure("unavailable", message: "PRIVATE_SENTINEL"),
        ])
        let model = GatewayDiagnosticsModel(bridge: bridge)
        await model.refresh("/a", hours: 24)
        XCTAssertEqual(model.report?.hours, 24)
        await model.refresh("/a", hours: 24)
        XCTAssertNil(model.report)
        XCTAssertFalse(model.message?.contains("PRIVATE_SENTINEL") ?? true)
        let requests = await bridge.requests()
        XCTAssertEqual(requests.map(\.operation), ["diagnostics", "diagnostics"])
        XCTAssertEqual(requests.map(\.sinceHours), [24, 24])
    }

    func testChangingWindowRejectsOldPendingResponse() async {
        let bridge = AutoLatestStagedBridge()
        let model = GatewayDiagnosticsModel(bridge: bridge)
        let task = Task { await model.refresh("/a", hours: 1) }
        await bridge.waitForRequest(count: 1)
        model.select("/a", hours: 24)
        await bridge.complete(.init(ok: true, result: ManagementResult(configPath: "/a", diagnostics: report()), error: nil), request: 0)
        await task.value
        XCTAssertNil(model.report)
    }
}
