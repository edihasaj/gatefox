import Darwin
import Foundation
import XCTest
@testable import GatewayApp

final class GatewayManagementProcessTests: XCTestCase {
    func testSecretTravelsOnlyOnJSONStdin() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("""
        printf '<%s>\\n' "$@" > "$HOME/argv"
        cat > "$HOME/request"
        printf '%s' '{"ok":true,"result":{"providers":[],"prerequisites":[]}}'
        """)
        let secret = "only-stdin-test-secret"
        let response = await fixture.command.request(
            ManagementRequest(
                operation: "prepare",
                configPath: "/tmp/gateway.json",
                provider: ProviderInput(label: "API", type: "responses-api", apiKey: secret)
            ),
            timeoutSeconds: 1
        )

        XCTAssertTrue(response.ok)
        let arguments = try String(contentsOf: fixture.home.appending(path: "argv"), encoding: .utf8)
        let input = try String(contentsOf: fixture.home.appending(path: "request"), encoding: .utf8)
        XCTAssertFalse(arguments.contains(secret))
        XCTAssertTrue(input.contains(secret))
        XCTAssertEqual(arguments.trimmingCharacters(in: .whitespacesAndNewlines), "<\(fixture.script.path)>")
    }

    func testMalformedAndOversizedOutputFailClosed() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("cat >/dev/null; printf '{not-json'")
        let malformed = await fixture.command.request(fixture.inspect, timeoutSeconds: 1)
        XCTAssertFalse(malformed.ok)
        XCTAssertEqual(malformed.error?.code, "invalid_response")

        try fixture.writeNode("cat >/dev/null; /usr/bin/head -c 2097153 /dev/zero")
        let oversized = await fixture.command.request(fixture.inspect, timeoutSeconds: 1)
        XCTAssertFalse(oversized.ok)
        XCTAssertEqual(oversized.error?.code, "invalid_response")
    }

    func testNonReadingChildWithNearLimitInputTimesOutPromptly() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("trap '' TERM; sleep 5")

        let started = ContinuousClock.now
        let response = await fixture.command.request(fixture.largePrepare, timeoutSeconds: 0.15)
        XCTAssertEqual(response.error?.code, "timed_out")
        XCTAssertLessThan(started.duration(to: .now), .seconds(2))
    }

    func testOutputBeforeInputIsFullyReadDoesNotDeadlock() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("""
        dd if=/dev/zero bs=65536 count=2 2>/dev/null | tr '\\000' ' '
        cat >/dev/null
        printf '%s' '{"ok":true,"result":{"providers":[],"prerequisites":[]}}'
        """)

        let started = ContinuousClock.now
        let response = await fixture.command.request(fixture.largePrepare, timeoutSeconds: 1)
        XCTAssertTrue(response.ok)
        XCTAssertLessThan(started.duration(to: .now), .seconds(2))
    }

    func testCancellationCompletesCleanupBeforeTheNextRequest() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("""
        if [ ! -e "$HOME/first-request" ]; then
          : > "$HOME/first-request"
          trap '' TERM
          while :; do sleep 1; done
        fi
        cat >/dev/null
        printf '%s' '{"ok":true,"result":{"providers":[],"prerequisites":[]}}'
        """)
        let command = fixture.command
        let inspect = fixture.inspect
        let first = Task.detached { await command.request(inspect, timeoutSeconds: 30) }
        for _ in 0..<50 where !FileManager.default.fileExists(atPath: fixture.home.appending(path: "first-request").path) {
            try await Task.sleep(for: .milliseconds(10))
        }

        await command.cancel()
        let cancelled = await first.value
        XCTAssertEqual(cancelled.error?.code, "cancelled")
        let second = await command.request(inspect, timeoutSeconds: 1)
        XCTAssertTrue(second.ok)
    }

    func testBrokenStdinDoesNotTerminateTheTestHost() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("""
        exec 0<&-
        sleep 0.05
        printf '%s' '{"ok":true,"result":{"providers":[],"prerequisites":[]}}'
        """)

        let response = await fixture.command.request(fixture.largePrepare, timeoutSeconds: 1)
        XCTAssertTrue(response.ok)
    }

    func testCancellationStopsOnlyOwnedLongRunningProcessPromptly() async throws {
        let fixture = try ManagementProcessFixture()
        defer { fixture.remove() }
        try fixture.writeNode("""
        trap '' TERM
        printf '%s' "$$" > "$HOME/own-pid"
        cat >/dev/null
        (trap '' TERM; sleep 5) &
        wait
        """)
        let command = fixture.command
        let inspect = fixture.inspect
        let request = Task.detached { await command.request(inspect, timeoutSeconds: 30) }
        for _ in 0..<50 where !FileManager.default.fileExists(atPath: fixture.home.appending(path: "own-pid").path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        let started = ContinuousClock.now
        await fixture.command.cancel()
        let response = await request.value
        XCTAssertEqual(response.error?.code, "cancelled")
        XCTAssertLessThan(started.duration(to: .now), .seconds(1))

        let pidText = try String(contentsOf: fixture.home.appending(path: "own-pid"), encoding: .utf8)
        let pid = try XCTUnwrap(Int32(pidText))
        for _ in 0..<50 where kill(pid, 0) == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(kill(pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }
}

private final class ManagementProcessFixture {
    let home: URL
    let resources: URL
    let script: URL
    let command: GatewayManagementCommand
    let inspect = ManagementRequest(operation: "inspect", configPath: "/tmp/gateway.json")
    let largePrepare = ManagementRequest(
        operation: "prepare",
        configPath: "/tmp/gateway.json",
        provider: ProviderInput(label: "Large request", type: "responses-api", apiKey: String(repeating: "x", count: 120_000))
    )

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayManagementTests \(UUID().uuidString)")
        resources = home.appending(path: "resources")
        script = resources.appending(path: "management/dist/app-management.js")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// mock".write(to: script, atomically: true, encoding: .utf8)
        let node = resources.appending(path: "backend/runtime/bin/node")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: node, atomically: true, encoding: .utf8)
        XCTAssertEqual(chmod(node.path, S_IRUSR | S_IWUSR | S_IXUSR), 0)
        command = GatewayManagementCommand(homeDirectory: home, resourceDirectory: resources)
    }

    func writeNode(_ body: String) throws {
        let node = resources.appending(path: "backend/runtime/bin/node")
        try "#!/bin/sh\nset -eu\n\(body)\n".write(to: node, atomically: true, encoding: .utf8)
        XCTAssertEqual(chmod(node.path, S_IRUSR | S_IWUSR | S_IXUSR), 0)
    }

    func remove() { try? FileManager.default.removeItem(at: home) }
}
