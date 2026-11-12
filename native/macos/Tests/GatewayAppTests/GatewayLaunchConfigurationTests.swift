import Foundation
import XCTest
@testable import GatewayApp

final class GatewayLaunchConfigurationTests: XCTestCase {
    func testRenameAliasRetainsExistingPreferencesAndConfigurationIdentity() throws {
        let root = URL(fileURLWithPath: "/tmp/gatefox-launch-\(UUID().uuidString)").resolvingSymlinksInPath()
        let parent = root.appending(path: "Library/Application Support")
        let backing = parent.appending(path: "Subscription Gateway")
        let alias = parent.appending(path: "GateFox")
        try FileManager.default.createDirectory(at: backing, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let oldConfig = backing.appending(path: "gateway.json").path
        let newConfig = alias.appending(path: "gateway.json").path
        try "{}".write(toFile: oldConfig, atomically: true, encoding: .utf8)
        let old = try GatewayLaunchConfiguration.read(arguments: ["GateFox", "--config", oldConfig, "--data-home", root.path])
        old.defaults.set("rename-proof", forKey: "GateFox.rename.test")
        defer { old.defaults.removeObject(forKey: "GateFox.rename.test") }
        try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: backing.path)
        let migrated = try GatewayLaunchConfiguration.read(arguments: ["GateFox", "--config", newConfig, "--data-home", root.path])
        XCTAssertEqual(migrated.configPath, oldConfig)
        XCTAssertEqual(migrated.defaults.string(forKey: "GateFox.rename.test"), "rename-proof")
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: "Subscription Gateway")
        XCTAssertEqual(GatewayLaunchConfiguration.identityConfigPath(newConfig, homeDirectory: root), oldConfig)
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: "/unrelated")
        XCTAssertEqual(GatewayLaunchConfiguration.identityConfigPath(newConfig, homeDirectory: root), newConfig)
    }

    func testIsolatedLaunchUsesSeparateHomeAndPreferences() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "gateway-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let config = root.appending(path: "settings/gateway.json").path
        let launch = try GatewayLaunchConfiguration.read(arguments: ["GatewayApp", "--config", config, "--data-home", root.path])
        XCTAssertEqual(launch.homeDirectory, root.resolvingSymlinksInPath())
        XCTAssertEqual(launch.configPath, config)
        XCTAssertFalse(launch.defaults === UserDefaults.standard)
        launch.defaults.set("fixture-selection", forKey: "GatewayApp.chosenConfigPath")
        let reopened = try GatewayLaunchConfiguration.read(arguments: ["GatewayApp", "--config", config, "--data-home", root.path])
        XCTAssertEqual(reopened.defaults.string(forKey: "GatewayApp.chosenConfigPath"), "fixture-selection")
        reopened.defaults.removeObject(forKey: "GatewayApp.chosenConfigPath")
        let equalsForm = try GatewayLaunchConfiguration.read(arguments: [
            "GatewayApp", "--config=\(config)", "--data-home=\(root.path)"
        ])
        XCTAssertEqual(equalsForm.homeDirectory, launch.homeDirectory)
        XCTAssertEqual(equalsForm.configPath, launch.configPath)
    }

    func testInvalidIsolationCannotFallBackToRealUserConfiguration() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "gateway-invalid-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        for arguments in [
            ["GatewayApp", "--data-home", root.path],
            ["GatewayApp", "--config", "relative.json"],
            ["GatewayApp", "--config"],
            ["GatewayApp", "--config", "/outside/gateway.json", "--data-home", root.path],
            ["GatewayApp", "--config", root.appending(path: "gateway.json").path, "--data-home", "relative"],
            ["GatewayApp", "--data-home=\(root.path)"],
            ["GatewayApp", "--config=/outside/gateway.json", "--data-home=\(root.path)"],
            ["GatewayApp", "--config=\(root.path)/gateway.json", "--data-home="],
            ["GatewayApp", "--configuration", "/outside/gateway.json"],
            ["GatewayApp", "--config=\(root.path)/gateway.json", "--config", "/outside/gateway.json"]
        ] {
            XCTAssertThrowsError(try GatewayLaunchConfiguration.read(arguments: arguments))
        }
        let ordinary = try GatewayLaunchConfiguration.read(arguments: ["GatewayApp", "-psn_0_100"])
        XCTAssertNil(ordinary.configPath)
    }
}
