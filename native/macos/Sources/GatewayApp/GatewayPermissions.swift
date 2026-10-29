import AppKit
import SwiftUI

enum GatewayPrivacyPane: String, CaseIterable {
    case fullDiskAccess = "Privacy_AllFiles"
    case automation = "Privacy_Automation"
    case localNetwork = "Privacy_LocalNetwork"

    var title: String {
        switch self {
        case .fullDiskAccess: "Full Disk Access"
        case .automation: "Automation"
        case .localNetwork: "Local Network"
        }
    }

    var url: URL {
        URL(string: "x-apple.systempreferences:com.apple.preference.security?\(rawValue)")!
    }

    var instructions: String { "System Settings → Privacy & Security → \(title)" }
}

/// Remembers only whether the invitation was answered. Opening a pane cannot
/// establish a TCC grant, especially for a separately running service or tool.
@MainActor
final class GatewayPermissions: ObservableObject {
    @Published var showInvitation = false
    @Published private(set) var message: String?
    private let defaults: UserDefaults
    private let openURL: (URL) -> Bool
    private static let invitationKey = "GatewayApp.diskAccessInvitationAnswered"

    init(defaults: UserDefaults, openURL: @escaping (URL) -> Bool = { NSWorkspace.shared.open($0) }) {
        self.defaults = defaults
        self.openURL = openURL
    }

    func offerIfNeeded(setupPresented: Bool) {
        guard !setupPresented, !defaults.bool(forKey: Self.invitationKey) else { return }
        showInvitation = true
    }

    func dismissInvitation() {
        defaults.set(true, forKey: Self.invitationKey)
        showInvitation = false
    }

    func open(_ pane: GatewayPrivacyPane) {
        message = openURL(pane.url)
            ? "Review access in \(pane.instructions). Opening Settings does not confirm permission."
            : "Open \(pane.instructions) manually."
    }
}
