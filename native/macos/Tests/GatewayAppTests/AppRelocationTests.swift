import Foundation
import XCTest
@testable import GatewayApp

final class AppRelocationTests: XCTestCase {
    private let home = URL(filePath: "/Users/dev")
    private let legacy = URL(filePath: "/Users/dev/Applications/Harness Gateway.app")

    func testLegacyBundleMovesToGateFoxBesideIt() {
        XCTAssertEqual(
            AppRelocation.destination(bundleURL: legacy, homeDirectory: home, exists: { _ in false }, pendingUpdate: { _ in false })?.path,
            "/Users/dev/Applications/GateFox.app"
        )
    }

    func testRenamedOrOccupiedOrUpdatingAppStaysPut() {
        let gatefox = URL(filePath: "/Users/dev/Applications/GateFox.app")
        XCTAssertNil(AppRelocation.destination(bundleURL: gatefox, homeDirectory: home, exists: { _ in false }, pendingUpdate: { _ in false }))
        XCTAssertNil(AppRelocation.destination(bundleURL: legacy, homeDirectory: home, exists: { $0 == gatefox.path }, pendingUpdate: { _ in false }))
        let journal = "/Users/dev/.local/share/subscription-gateway/app-update-transaction.json"
        XCTAssertNil(AppRelocation.destination(bundleURL: legacy, homeDirectory: home, exists: { $0 == journal }, pendingUpdate: { _ in false }))
        XCTAssertNil(AppRelocation.destination(bundleURL: legacy, homeDirectory: home, exists: { _ in false }, pendingUpdate: { _ in true }))
    }

    func testUpdaterStateRecordsPendingOnlyWithAPendingEntry() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = directory.appending(path: "app-update.json")
        XCTAssertFalse(AppRelocation.recordsPendingUpdate(state), "no state file")
        try Data(#"{"lastCheck":"2026-11-09"}"#.utf8).write(to: state)
        XCTAssertFalse(AppRelocation.recordsPendingUpdate(state))
        try Data(#"{"pending":null}"#.utf8).write(to: state)
        XCTAssertFalse(AppRelocation.recordsPendingUpdate(state))
        try Data(#"{"pending":{"version":"1.8.0"}}"#.utf8).write(to: state)
        XCTAssertTrue(AppRelocation.recordsPendingUpdate(state))
        try Data("not json".utf8).write(to: state)
        XCTAssertTrue(AppRelocation.recordsPendingUpdate(state), "an unreadable state is treated as pending")
    }
}
