import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayLifecycleDelegateTests: XCTestCase {
    func testTerminationCleanupWaitsForAnOwnedUpdateProcessToCancel() async {
        let runner = TerminationUpdateRunner(responses: [.success(current: "1.0.0")])
        let updates = GatewayUpdatesModel(runner: runner)
        await updates.configure(configPath: "/tmp/gateway.json")

        let check = Task { await updates.check() }
        await runner.waitForRequest(count: 2)
        let lifecycle = GatewayLifecycleDelegate()
        lifecycle.updates = updates
        let cleanup = Task { await lifecycle.completeTerminationCleanup() }
        await runner.waitForCancellation(count: 1)

        XCTAssertTrue(updates.hasPendingWork)
        XCTAssertTrue(updates.isCancelling)
        await runner.finishCancellation()
        await cleanup.value
        await check.value

        XCTAssertFalse(updates.hasPendingWork)
        XCTAssertFalse(updates.isBusy)
        XCTAssertFalse(updates.isCancelling)
        let cancellations = await runner.cancelCount()
        XCTAssertEqual(cancellations, 1)
    }
}

private actor TerminationUpdateRunner: GatewayUpdateRunning {
    private var responses: [GatewayUpdateResponse]
    private var continuations: [CheckedContinuation<GatewayUpdateResponse, Never>] = []
    private var cancellationContinuations: [CheckedContinuation<Void, Never>] = []
    private var requestCount = 0
    private var cancellations = 0

    init(responses: [GatewayUpdateResponse]) { self.responses = responses }

    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse {
        requestCount += 1
        if !responses.isEmpty { return responses.removeFirst() }
        return await withCheckedContinuation { continuations.append($0) }
    }

    func cancel() async {
        cancellations += 1
        await withCheckedContinuation { cancellationContinuations.append($0) }
    }

    func waitForRequest(count: Int) async {
        while requestCount < count { await Task.yield() }
    }

    func waitForCancellation(count: Int) async {
        while cancellations < count { await Task.yield() }
    }

    func finishCancellation() {
        if !continuations.isEmpty {
            continuations.removeFirst().resume(returning: .failure("cancelled"))
        }
        if !cancellationContinuations.isEmpty {
            cancellationContinuations.removeFirst().resume()
        }
    }

    func cancelCount() -> Int { cancellations }
}

private extension GatewayUpdateResponse {
    static func success(current: String) -> GatewayUpdateResponse {
        .init(
            ok: true,
            result: .init(
                automatic: false, currentVersion: current, latestVersion: nil,
                available: false, phase: "idle", message: "Ready", lastChecked: nil
            ),
            error: nil
        )
    }
}
