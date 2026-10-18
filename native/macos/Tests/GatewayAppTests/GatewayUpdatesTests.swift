import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayUpdatesTests: XCTestCase {
    func testCheckUsesSelectedAbsoluteJSONPathAndRejectsDuplicateOperation() async {
        let runner = DelayedUpdateRunner()
        let model = GatewayUpdatesModel(runner: runner)
        let path = "/tmp/gateway.json"
        let configured = Task { await model.configure(configPath: path) }
        await runner.waitForRequest(count: 1)
        await runner.finishNext(.success(current: "1.2.3"))
        await configured.value

        let check = Task { await model.check() }
        await runner.waitForRequest(count: 2)
        await model.check()
        let pending = await runner.requests()
        XCTAssertEqual(pending.count, 2)
        await runner.finishNext(.success(current: "1.2.3", latest: "1.2.4", available: true))
        await check.value

        let request = await runner.requests().last
        XCTAssertEqual(request?.operation, "check")
        XCTAssertEqual(request?.configPath, path)
        XCTAssertTrue(model.available)
    }

    func testErrorDoesNotLeaveBusyStateOrStaleAvailability() async {
        let runner = UpdateRunner(responses: [
            .success(current: "1.0.0", latest: "1.0.1", available: true),
            .failure("auth_required")
        ])
        let model = GatewayUpdatesModel(runner: runner)
        await model.configure(configPath: "/tmp/gateway.json")
        XCTAssertTrue(model.available)
        await model.check()
        XCTAssertFalse(model.isBusy)
        XCTAssertFalse(model.available)
        XCTAssertEqual(model.phase, "unavailable")
        XCTAssertEqual(model.message, "Sign in to check for updates, then try again.")
    }

    func testCancellationBlocksAnImmediateReplacementUntilCleanupCompletes() async {
        let runner = DelayedUpdateRunner()
        let model = GatewayUpdatesModel(runner: runner)
        let configured = Task { await model.configure(configPath: "/tmp/gateway.json") }
        await runner.waitForRequest(count: 1)
        await runner.finishNext(.success(current: "1.0.0"))
        await configured.value

        let check = Task { await model.check() }
        await runner.waitForRequest(count: 2)
        let cancellation = Task { await model.cancel() }
        await runner.waitForCancellation(count: 1)
        XCTAssertTrue(model.isBusy)
        XCTAssertTrue(model.isCancelling)

        await model.check()
        let duringCancellation = await runner.requests()
        XCTAssertEqual(duringCancellation.count, 2)

        await runner.finishCancellation()
        await cancellation.value
        await check.value
        XCTAssertFalse(model.isBusy)
        XCTAssertFalse(model.isCancelling)
        XCTAssertEqual(model.message, "Update check cancelled.")
        let cancellations = await runner.cancelCount()
        XCTAssertEqual(cancellations, 1)

        let retry = Task { await model.check() }
        await runner.waitForRequest(count: 3)
        await runner.finishNext(.success(current: "1.0.0"))
        await retry.value
    }

    func testInvalidConfigurationWaitsForCancellationAndIgnoresLateResponse() async {
        let runner = LateResponseUpdateRunner(responses: [.success(current: "1.0.0")])
        let model = GatewayUpdatesModel(runner: runner)
        await model.configure(configPath: "/tmp/gateway.json")

        let check = Task { await model.check() }
        await runner.waitForRequest(count: 2)
        let invalid = Task { await model.configure(configPath: "relative/gateway.txt") }
        await runner.waitForCancellation(count: 1)
        await invalid.value
        XCTAssertEqual(model.phase, "unavailable")
        XCTAssertFalse(model.available)

        await runner.finishNext(.success(current: "9.9.9", latest: "10.0.0", available: true))
        await check.value
        XCTAssertEqual(model.phase, "unavailable")
        XCTAssertFalse(model.available)
        XCTAssertNil(model.latestVersion)
    }

    func testPreferencesSendsAutomaticFlag() async {
        let runner = UpdateRunner(responses: [
            .success(current: "1.0.0"),
            .success(current: "1.0.0", automatic: true)
        ])
        let model = GatewayUpdatesModel(runner: runner)
        await model.configure(configPath: "/tmp/gateway.json")
        await model.setAutomatic(true)
        let request = await runner.requests().last
        XCTAssertEqual(request?.operation, "preferences")
        XCTAssertEqual(request?.automatic, true)
        XCTAssertTrue(model.automatic)
    }

    func testInvalidConfigurationNeverReachesBackend() async {
        let runner = UpdateRunner(responses: [])
        let model = GatewayUpdatesModel(runner: runner)
        await model.configure(configPath: "relative/gateway.txt")
        let requests = await runner.requests()
        XCTAssertEqual(requests.count, 0)
        XCTAssertEqual(model.phase, "unavailable")
    }
}

private actor UpdateRunner: GatewayUpdateRunning {
    private var responses: [GatewayUpdateResponse]
    private var captured: [GatewayUpdateRequest] = []

    init(responses: [GatewayUpdateResponse]) { self.responses = responses }

    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse {
        captured.append(request)
        return responses.isEmpty ? .failure("updates_unavailable") : responses.removeFirst()
    }

    func cancel() async {}
    func requests() -> [GatewayUpdateRequest] { captured }
}

private actor DelayedUpdateRunner: GatewayUpdateRunning {
    private var captured: [GatewayUpdateRequest] = []
    private var continuations: [CheckedContinuation<GatewayUpdateResponse, Never>] = []
    private var cancellationContinuations: [CheckedContinuation<Void, Never>] = []
    private var cancellations = 0

    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse {
        captured.append(request)
        return await withCheckedContinuation { continuations.append($0) }
    }

    func cancel() async {
        cancellations += 1
        await withCheckedContinuation { cancellationContinuations.append($0) }
    }

    func waitForRequest(count: Int) async {
        while captured.count < count { await Task.yield() }
    }

    func finishNext(_ response: GatewayUpdateResponse) {
        guard !continuations.isEmpty else { return }
        continuations.removeFirst().resume(returning: response)
    }

    func finishCancellation() {
        finishNext(.failure("cancelled"))
        guard !cancellationContinuations.isEmpty else { return }
        cancellationContinuations.removeFirst().resume()
    }

    func requests() -> [GatewayUpdateRequest] { captured }
    func cancelCount() -> Int { cancellations }

    func waitForCancellation(count: Int) async {
        while cancellations < count { await Task.yield() }
    }
}

private actor LateResponseUpdateRunner: GatewayUpdateRunning {
    private var responses: [GatewayUpdateResponse]
    private var captured: [GatewayUpdateRequest] = []
    private var continuations: [CheckedContinuation<GatewayUpdateResponse, Never>] = []
    private var cancellations = 0

    init(responses: [GatewayUpdateResponse]) { self.responses = responses }

    func request(_ request: GatewayUpdateRequest, timeout: Duration) async -> GatewayUpdateResponse {
        captured.append(request)
        if !responses.isEmpty { return responses.removeFirst() }
        return await withCheckedContinuation { continuations.append($0) }
    }

    func cancel() async { cancellations += 1 }

    func waitForRequest(count: Int) async {
        while captured.count < count { await Task.yield() }
    }

    func waitForCancellation(count: Int) async {
        while cancellations < count { await Task.yield() }
    }

    func finishNext(_ response: GatewayUpdateResponse) {
        guard !continuations.isEmpty else { return }
        continuations.removeFirst().resume(returning: response)
    }
}

private extension GatewayUpdateResponse {
    static func success(
        current: String,
        latest: String? = nil,
        available: Bool = false,
        automatic: Bool = false,
        phase: String = "idle"
    ) -> GatewayUpdateResponse {
        .init(
            ok: true,
            result: .init(
                automatic: automatic, currentVersion: current, latestVersion: latest,
                available: available, phase: phase, message: "Ready", lastChecked: nil
            ),
            error: nil
        )
    }
}
