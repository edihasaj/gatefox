import Darwin
import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayCommandTests: XCTestCase {
    func testTrustedCLIReceivesLiteralArgumentsAndConfigPath() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        printf '<%s>\\n' "$@"
        """)
        let config = fixture.home.appending(path: "config with 'quotes' and spaces.json").path

        let result = await fixture.command.run(["service", "status", "a \"literal\" value"], configPath: config)

        XCTAssertEqual(result.outcome, .success)
        XCTAssertEqual(result.stdout, """
        <service>
        <status>
        <a "literal" value>
        <--config>
        <\(config)>
        """ + "\n")
    }

    func testInstallerUsesInjectedHomeWithoutConfigArgument() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.writeInstaller("""
        printf '<%s>\\n' "$HOME" "$#"
        """)

        let result = await fixture.command.install(configPath: "/ignored/config with spaces.json")

        XCTAssertEqual(result.outcome, .success)
        XCTAssertEqual(result.stdout, "<\(fixture.home.path)>\n<0>\n")
    }

    func testBackgroundIdentityUsesBundledToolWithLiteralSelectedConfiguration() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("exit 9")
        try fixture.writeBackgroundRuntime(#"printf '<%s>\n' "$HOME" "$@""#)
        let selectedPath = fixture.home.appending(path: "settings with 'quotes'.json").path

        let result = await fixture.command.associateBackgroundItem(configPath: selectedPath)

        XCTAssertEqual(result.outcome, .success)
        XCTAssertEqual(result.stdout, """
        <\(fixture.home.path)>
        <\(fixture.resources.appending(path: "management/dist/app-background.js").path)>
        <--config>
        <\(selectedPath)>
        <--apply>
        """ + "\n")
    }

    func testNonzeroExitFailsWithoutReturningOutput() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        printf 'do not return this'
        exit 7
        """)

        let result = await fixture.command.run(["service", "status"], configPath: fixture.config.path)

        XCTAssertEqual(result, .failed)
    }

    func testLargeStderrIsDrained() async throws {
        let fixture = try Fixture(timeoutSeconds: 2)
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        i=0
        while [ "$i" -lt 5000 ]; do
          printf '0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789' >&2
          i=$((i + 1))
        done
        printf ok
        """)

        let result = await fixture.command.run(["service", "status"], configPath: fixture.config.path)

        XCTAssertEqual(result, GatewayCommandResult(outcome: .success, stdout: "ok"))
    }

    func testStdoutOverCaptureLimitFailsClosed() async throws {
        let fixture = try Fixture(timeoutSeconds: 2)
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        /usr/bin/yes x | /usr/bin/head -c 1048577
        """)

        let result = await fixture.command.run(["service", "status"], configPath: fixture.config.path)

        XCTAssertEqual(result, .failed)
    }

    func testTimeoutWithPipeHoldingDescendantReturnsPromptly() async throws {
        let fixture = try Fixture(timeoutSeconds: 0.15)
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        (sleep 2) &
        sleep 2
        """)

        let started = ContinuousClock.now
        let result = await fixture.command.run(["service", "status"], configPath: fixture.config.path)
        let elapsed = started.duration(to: .now)

        XCTAssertEqual(result, GatewayCommandResult(outcome: .timedOut, stdout: ""))
        XCTAssertLessThan(elapsed, .seconds(2))
    }

    func testTimeoutStopsResistantOwnedProcessGroup() async throws {
        let fixture = try Fixture(timeoutSeconds: 1)
        defer { fixture.remove() }
        try fixture.writeTrustedCLI("""
        trap '' TERM
        printf '%s' "$$" > "$HOME/own-pid"
        (trap '' TERM; sleep 5) &
        wait
        """)
        let result = await fixture.command.run(["service", "status"], configPath: fixture.config.path)
        XCTAssertEqual(result.outcome, .timedOut)
        let pidText = try String(contentsOf: fixture.home.appending(path: "own-pid"), encoding: .utf8)
        let pid = try XCTUnwrap(Int32(pidText))
        for _ in 0..<50 {
            if kill(pid, 0) != 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(kill(pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
    }
}

private final class Fixture {
    let home: URL
    let resources: URL
    let config: URL
    let command: GatewayCommand

    init(timeoutSeconds: TimeInterval = 1) throws {
        home = FileManager.default.temporaryDirectory.appending(path: "GatewayCommandTests \(UUID().uuidString)")
        resources = home.appending(path: "resources")
        config = home.appending(path: "gateway config.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try "{}".write(to: config, atomically: true, encoding: .utf8)
        command = GatewayCommand(
            homeDirectory: home,
            resourceDirectory: resources,
            timeoutSeconds: timeoutSeconds
        )
    }

    func writeTrustedCLI(_ body: String) throws {
        let script = home.appending(path: ".local/bin/gateway")
        try writeScript("""
        #!/bin/sh
        # Managed by subscription-gateway installer
        \(body)
        """, to: script)
    }

    func writeInstaller(_ body: String) throws {
        try writeScript("""
        #!/bin/sh
        set -u
        \(body)
        """, to: resources.appending(path: "backend/install"))
    }

    func writeBackgroundRuntime(_ body: String) throws {
        let tool = resources.appending(path: "management/dist/app-background.js")
        try FileManager.default.createDirectory(at: tool.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "// fixture".write(to: tool, atomically: true, encoding: .utf8)
        try writeScript("#!/bin/sh\n\(body)\n", to: resources.appending(path: "backend/runtime/bin/node"))
    }

    func remove() {
        try? FileManager.default.removeItem(at: home)
    }

    private func writeScript(_ contents: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        XCTAssertEqual(chmod(url.path, S_IRUSR | S_IWUSR | S_IXUSR), 0)
    }
}
