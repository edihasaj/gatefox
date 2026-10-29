import Foundation
import XCTest
@testable import GatewayApp

final class GatewayPermissionsTests: XCTestCase {
    @MainActor
    func testInvitationWaitsForSetupAndPersistsOnlyAnExplicitAnswer() throws {
        let suite = "gateway-permissions-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let permissions = GatewayPermissions(defaults: defaults, openURL: { _ in XCTFail("No automatic OS prompt"); return false })
        permissions.offerIfNeeded(setupPresented: true)
        XCTAssertFalse(permissions.showInvitation)
        permissions.offerIfNeeded(setupPresented: false)
        XCTAssertTrue(permissions.showInvitation)

        // Merely displaying the invitation does not consume it if the app exits.
        let reopened = GatewayPermissions(defaults: defaults)
        reopened.offerIfNeeded(setupPresented: false)
        XCTAssertTrue(reopened.showInvitation)
        permissions.dismissInvitation()
        XCTAssertFalse(permissions.showInvitation)
        let answered = GatewayPermissions(defaults: defaults)
        answered.offerIfNeeded(setupPresented: false)
        XCTAssertFalse(answered.showInvitation)
    }

    @MainActor
    func testSettingsActionsOpenTheIntendedPaneAndRemainAvailableAfterDismissal() throws {
        let suite = "gateway-permissions-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var opened: [URL] = []
        let permissions = GatewayPermissions(defaults: defaults, openURL: { opened.append($0); return true })
        permissions.dismissInvitation()
        permissions.open(.fullDiskAccess)
        XCTAssertEqual(opened.last?.absoluteString,
                       "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        XCTAssertTrue(permissions.message?.contains("does not confirm permission") == true)
        for pane in GatewayPrivacyPane.allCases {
            permissions.open(pane)
            XCTAssertEqual(opened.last, pane.url)
        }
    }

    @MainActor
    func testUnavailableSettingsGiveManualFallbackAndPreferencesStayIsolated() throws {
        let suite = "gateway-permissions-\(UUID().uuidString)"
        let otherSuite = "gateway-permissions-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let other = try XCTUnwrap(UserDefaults(suiteName: otherSuite))
        defer {
            defaults.removePersistentDomain(forName: suite)
            other.removePersistentDomain(forName: otherSuite)
        }
        let permissions = GatewayPermissions(defaults: defaults, openURL: { _ in false })
        permissions.open(.fullDiskAccess)
        XCTAssertEqual(permissions.message, "Open System Settings → Privacy & Security → Full Disk Access manually.")
        permissions.dismissInvitation()
        let isolated = GatewayPermissions(defaults: other)
        isolated.offerIfNeeded(setupPresented: false)
        XCTAssertTrue(isolated.showInvitation)
    }
}
