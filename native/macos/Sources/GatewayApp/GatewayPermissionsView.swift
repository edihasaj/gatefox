import AppKit
import SwiftUI

struct GatewayPermissionsView: View {
    @EnvironmentObject private var permissions: GatewayPermissions

    var body: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                Label("Permissions", systemImage: "lock.shield")
                    .font(GatewayTheme.display(24))
                    .foregroundStyle(GatewayTheme.charcoal)

                Text("Choose access for the development work you run through Harness Gateway on this Mac.")
                    .font(GatewayTheme.body(14))

                VStack(alignment: .leading, spacing: 10) {
                    Text("Full Disk Access")
                        .font(GatewayTheme.body(16, weight: .semibold))
                    Text("Optional for development tasks that need protected files, including Mail, Messages, Safari data and backups. It grants broad access beyond your project folders.")
                    Text("1. Open System Settings → Privacy & Security → Full Disk Access.\n2. Enable Harness Gateway. If it is missing, use + to select this app from Applications.")
                    Text("If macOS asks to quit and reopen, finish active work first. A background tool may need to restart later; this window does not restart the gateway.")
                    HStack(spacing: 10) {
                        paneButton(.fullDiskAccess)
                        if Bundle.main.bundleURL.pathExtension == "app" {
                            Button("Show this app") {
                                NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
                            }
                            .buttonStyle(GatewaySecondaryButtonStyle())
                            .accessibilityIdentifier("permissions.reveal-app")
                        }
                    }
                }

                Divider().overlay(GatewayTheme.line)

                DisclosureGroup("Other gateway permissions") {
                    VStack(alignment: .leading, spacing: 16) {
                        toolPane(.automation, detail: "When a client-run development task uses AppleScript or Apple Events to control another app, macOS can request Automation access. Run that action first, then review its requesting app and target here.")
                        toolPane(.localNetwork, detail: "Allow Local Network access when connecting to a model server or shared gateway on your LAN. macOS requests it when the connection needs it; loopback-only use does not require it.")
                    }
                    .padding(.top, 12)
                }
                .accessibilityIdentifier("permissions.other-access")

                Text("Verify access by retrying the intended task. Enable the app macOS identifies as responsible. For remote work, review permissions on the Mac running it.")
                if let message = permissions.message {
                    Text(message)
                        .foregroundStyle(GatewayTheme.moss)
                        .accessibilityIdentifier("permissions.message")
                }
            }
            .font(GatewayTheme.body(13))
            .foregroundStyle(GatewayTheme.charcoal.opacity(0.72))
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.permissions")
    }

    private func paneButton(_ pane: GatewayPrivacyPane) -> some View {
        Button("Open \(pane.title)") { permissions.open(pane) }
            .buttonStyle(GatewaySecondaryButtonStyle())
            .accessibilityIdentifier("permissions.\(pane.rawValue)")
    }

    private func toolPane(_ pane: GatewayPrivacyPane, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(detail)
            paneButton(pane)
        }
    }
}
