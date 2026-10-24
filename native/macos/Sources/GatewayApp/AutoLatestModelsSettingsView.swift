import SwiftUI

/// Global panel for automatic latest models. It shows the saved state only: a refused, cancelled or obsolete save
/// leaves the toggle where it was.
struct AutoLatestModelsSettingsView: View {
    @ObservedObject var gateway: GatewayModel
    @ObservedObject var connections: GatewayConnectionsModel

    var body: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(GatewayTheme.moss)
                        .frame(width: 34, height: 34)
                        .background(GatewayTheme.moss.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Automatic latest models")
                            .font(GatewayTheme.body(17, weight: .semibold))
                            .foregroundStyle(GatewayTheme.charcoal)
                        Text("Keep the picker on the newest model of each family you already use.")
                            .font(GatewayTheme.body(13))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                    }
                    Spacer()
                    if connections.isBusy { ProgressView().controlSize(.small) }
                    Toggle("Automatic latest models", isOn: enabledBinding)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .disabled(!connections.canEditAutoLatest)
                        .accessibilityLabel("Automatic latest models")
                        .accessibilityIdentifier("auto-latest.toggle")
                }
                if let status = connections.autoLatest {
                    details(status)
                } else {
                    Text("Not available from this gateway yet. Refresh connections to load this setting.")
                        .font(GatewayTheme.body(12))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.5))
                        .accessibilityIdentifier("auto-latest.unavailable")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("auto-latest.panel")
    }

    @ViewBuilder
    private func details(_ status: AutoLatestStatus) -> some View {
        if !status.hasFamilies {
            note("No supported model families are selected yet, so nothing would be followed. Connections without a supported model catalog stay pinned to the models you chose.", id: "auto-latest.no-families")
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(status.enabled ? "Following these families" : "Would follow these families")
                    .font(GatewayTheme.body(12, weight: .semibold))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                ForEach(status.familyLines, id: \.self) { line in
                    Text(line).font(GatewayTheme.body(13)).foregroundStyle(GatewayTheme.charcoal)
                }
                if let native = status.nativeLine {
                    Text("Native GPT · \(native)").font(GatewayTheme.body(13)).foregroundStyle(GatewayTheme.charcoal)
                }
            }
            .accessibilityIdentifier("auto-latest.families")
        }
        if status.enabled { scheduleStatus(status) }
        note(scopeText, id: "auto-latest.scope")
        DisclosureGroup("How it works") {
            VStack(alignment: .leading, spacing: 7) {
                bullet("Families come from the models you have chosen now. Choosing models here while this is on changes the families being followed.")
                bullet("When a newer model appears in a followed family it replaces the older entry in the picker. Newly found models from other families stay off.")
                bullet("Older versions leave the picker only. Existing chats and explicit model requests keep the model they use, and active chats and accounts are never switched.")
                bullet("Turning it on keeps your current models. Turning it off keeps the current selection as it is and does not bring older models back.")
                bullet("The catalog is checked about every \(status.intervalMinutes) minutes, so a new model can take that long to appear; it is not instant.")
            }
            .padding(.top, 6)
        }
        .font(GatewayTheme.body(12, weight: .semibold))
        .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
        .accessibilityIdentifier("auto-latest.explanation")
        if status.enabled {
            HStack(spacing: 10) {
                Button("Check now") { Task { await connections.checkAutoLatestNow() } }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(!connections.canCheckAutoLatest)
                    .accessibilityIdentifier("auto-latest.check")
                Text(lastCheckText(status))
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    .accessibilityIdentifier("auto-latest.last-check")
                Spacer()
            }
        }
    }

    @ViewBuilder
    private func scheduleStatus(_ status: AutoLatestStatus) -> some View {
        switch status.polling {
        case .running:
            note("Checking about every \(status.intervalMinutes) minutes.", id: "auto-latest.polling")
        case .notScheduled:
            Label("Automatic checks are not running in the gateway service on this Mac yet. Your models stay as they are; Check now still works.\(status.scheduleReason.map { " (\($0.replacingOccurrences(of: "_", with: " ")))" } ?? "")", systemImage: "exclamationmark.triangle")
                .font(GatewayTheme.body(12))
                .foregroundStyle(GatewayTheme.vermilion)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("auto-latest.not-scheduled")
        case .unknown:
            note("Whether background checks are running could not be confirmed.", id: "auto-latest.polling-unknown")
        }
    }

    private func lastCheckText(_ status: AutoLatestStatus) -> String {
        guard let date = status.lastChecked else { return "Not checked yet." }
        let when = date.formatted(date: .abbreviated, time: .shortened)
        return status.outcomeText.map { "Last checked \(when) · \($0)" } ?? "Last checked \(when)"
    }

    private var scopeText: String {
        let host = GatewayConnectionScope.localHostName()
        if gateway.clientOnly {
            return "Saved on this Mac (\(host)) and applies to its native GPT models only. The shared gateway's connections are managed on its own Mac."
        }
        return "Saved on this Mac (\(host)). Each Mac keeps its own setting; chats opened over SSH use the setting on the Mac that runs them."
    }

    private func note(_ text: String, id: String) -> some View {
        Text(text)
            .font(GatewayTheme.body(12))
            .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(id)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("•")
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(GatewayTheme.body(12))
        .foregroundStyle(GatewayTheme.charcoal.opacity(0.62))
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { connections.autoLatest?.enabled ?? false },
            set: { value in Task { await connections.setAutoLatest(value) } }
        )
    }
}

/// Shown in the model chooser while automatic latest models is on.
struct AutoLatestSelectionNote: View {
    @ObservedObject var connections: GatewayConnectionsModel

    var body: some View {
        if connections.autoLatest?.enabled == true {
            Label("Automatic latest models is on. Applying a selection here updates the families it follows. Automatically superseded versions stay routable for existing chats.", systemImage: "sparkles")
                .font(GatewayTheme.body(12))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("auto-latest.selection-note")
        }
    }
}
