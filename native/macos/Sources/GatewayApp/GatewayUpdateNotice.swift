import AppKit
import SwiftUI

struct GatewayUpdateNotice: View {
    @EnvironmentObject private var updates: GatewayUpdatesModel
    @EnvironmentObject private var navigation: GatewayNavigation

    private var staged: Bool { updates.phase == "waiting_for_app_exit" }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: staged ? "checkmark.circle.fill" : updates.available ? "arrow.down.circle.fill" : "exclamationmark.circle")
                .font(.system(size: 22))
                .foregroundStyle(GatewayTheme.vermilion)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(GatewayTheme.body(14, weight: .semibold))
                Text(staged ? "Quit GateFox to finish installing. Running chats continue." : updates.available
                     ? "Install the latest improvements to GateFox." : updates.message)
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            if updates.isBusy {
                ProgressView().controlSize(.small)
                    .accessibilityLabel("Preparing update")
            } else if staged {
                Button("Quit & Finish Update") { NSApp.terminate(nil) }
                    .buttonStyle(GatewayPrimaryButtonStyle())
                    .accessibilityLabel("Quit and finish update")
                    .accessibilityIdentifier("updates.finish")
            } else if updates.available {
                Button("Install Update") { Task { await updates.install() } }
                    .buttonStyle(GatewayPrimaryButtonStyle())
                    .accessibilityLabel("Install Update")
                    .accessibilityIdentifier("updates.install")
            } else {
                Button("Check Again") { Task { await updates.requestCheck() } }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .accessibilityLabel("Check Again")
                    .accessibilityIdentifier("updates.retry")
            }
            Button("Details") { navigation.selection = .settings }
                .buttonStyle(.plain)
                .accessibilityLabel("Update details")
                .accessibilityIdentifier("updates.details")
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .background(GatewayTheme.vermilion.opacity(0.08))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("App update")
        .accessibilityIdentifier("updates.notice")
    }

    private var title: String {
        if staged { return "Your update is ready to finish" }
        if updates.available { return updates.latestVersion.map { "GateFox \($0) is available" } ?? "A GateFox update is available" }
        return "Couldn’t check for updates"
    }
}
