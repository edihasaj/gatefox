import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: GatewayModel
    @EnvironmentObject private var navigation: GatewayNavigation
    @EnvironmentObject private var updates: GatewayUpdatesModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                header
                updateSettings
                settingsPath
                connection
                background
                guide
                if let message = model.message, !message.isEmpty {
                    Text(message)
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.78))
                        .padding(15)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(GatewayTheme.moss.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .textSelection(.enabled)
                        .accessibilityLabel("Gateway message: \(message)")
                }
            }
            .padding(.horizontal, 42)
            .padding(.vertical, 42)
            .frame(maxWidth: 760, alignment: .leading)
        }
        .accessibilityLabel("Gateway settings")
        .task(id: model.configPath) {
            await updates.configure(configPath: model.configPath)
        }
        .task(id: navigation.updateCheckID) {
            guard navigation.updateCheckID > 0 else { return }
            await updates.configure(configPath: model.configPath)
            await updates.requestCheck()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SETTINGS")
                .font(GatewayTheme.body(11, weight: .semibold))
                .tracking(1.5)
                .foregroundStyle(GatewayTheme.moss)
            Text("Make yourself\nat home.")
                .font(GatewayTheme.display(38))
                .foregroundStyle(GatewayTheme.charcoal)
            Text("Connect accounts and choose models in Connections. Advanced settings stay here when you need them.")
                .font(GatewayTheme.body(14))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var updateSettings: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Harness updates")
                            .font(GatewayTheme.display(24))
                            .foregroundStyle(GatewayTheme.charcoal)
                        Text("Current version \(updates.currentVersion)")
                            .font(GatewayTheme.body(13))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.62))
                    }
                    Spacer()
                    if updates.isBusy {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Checking for updates")
                    }
                }

                if let latest = updates.latestVersion {
                    Text(updates.available ? "Version \(latest) is ready." : "Latest version: \(latest)")
                        .font(GatewayTheme.body(14, weight: .semibold))
                        .foregroundStyle(updates.available ? GatewayTheme.moss : GatewayTheme.charcoal.opacity(0.72))
                }

                Text(updates.message)
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)

                Toggle("Automatically install updates", isOn: Binding(
                    get: { updates.automatic },
                    set: { value in Task { await updates.setAutomatic(value) } }
                ))
                .font(GatewayTheme.body(14, weight: .medium))
                .disabled(updates.isBusy)

                HStack(spacing: 10) {
                    Button(updates.phase == "unavailable" ? "Try again" : "Check now") {
                        Task { await updates.check() }
                    }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(updates.isBusy)

                    if updates.available && updates.phase != "waiting_for_app_exit" {
                        Button("Install update") {
                            Task { await updates.install() }
                        }
                        .buttonStyle(GatewayPrimaryButtonStyle())
                        .disabled(updates.isBusy)
                    }

                    if updates.isBusy {
                        Button(updates.isCancelling ? "Cancelling…" : "Cancel") {
                            Task { await updates.cancel() }
                        }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(updates.isCancelling)
                    }

                    Spacer()
                    if let checked = updates.lastChecked {
                        Text("Checked \(checked, format: .relative(presentation: .named))")
                            .font(GatewayTheme.body(12))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.5))
                    }
                }
            }
        }
    }

    private var settingsPath: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                DisclosureGroup {
                    advancedConfiguration
                } label: {
                    Text("Advanced configuration")
                    .font(GatewayTheme.display(24))
                    .foregroundStyle(GatewayTheme.charcoal)
                }
            }
        }
    }

    private var advancedConfiguration: some View {
        VStack(alignment: .leading, spacing: 16) {
                if model.hasConfig {
                    Text(model.configPath)
                        .font(.custom("Menlo", size: 12, relativeTo: .caption))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.73))
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(GatewayTheme.charcoal.opacity(0.055), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .accessibilityLabel("Selected configuration path: \(model.configPath)")
                } else {
                    Text("No configuration is selected. Choose an existing gateway settings file to inspect its routes and status.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("No configuration selected. Choose an existing settings file.")
                }

                HStack(spacing: 10) {
                    Button(model.hasConfig ? "Choose another…" : "Choose existing settings…") {
                        model.chooseConfig()
                    }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(model.isBusy)
                    .accessibilityLabel("Choose an existing gateway settings file")

                    if model.hasConfig {
                        Button("Reveal in Finder") {
                            model.revealConfig()
                        }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(model.isBusy)
                        .accessibilityLabel("Reveal configuration in Finder")
                    }
                }
        }
    }

    private var connection: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 12) {
                Text("Connection")
                    .font(GatewayTheme.display(24))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("The setup wizard can add accounts and help finish the connection to Codex. Your saved connections stay in place.")
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
                Button(model.setupComplete ? "Open Codex" : "Set up connection") {
                    if model.setupComplete {
                        model.openCodex()
                    } else {
                        Task { await model.setup() }
                    }
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(model.isBusy || (!model.setupComplete && !model.canSetup))
                .accessibilityLabel(model.setupComplete ? "Open Codex" : "Set up gateway connection")
                Button("Open setup wizard") {
                    navigation.showSetup = true
                }
                .buttonStyle(GatewaySecondaryButtonStyle())
                .disabled(model.isBusy || model.clientOnly)
                .accessibilityIdentifier("settings.setup")
            }
        }
    }

    private var guide: some View {
        GatewayPanel {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "book.closed")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(GatewayTheme.moss)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text("A guide for the details.")
                        .font(GatewayTheme.body(14, weight: .semibold))
                    Text("Advanced connections, shared Macs, and troubleshooting.")
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                }
                Spacer()
                if let guideURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "guide") {
                    Link("Open guide", destination: guideURL)
                        .font(GatewayTheme.body(14, weight: .semibold))
                        .foregroundStyle(GatewayTheme.vermilion)
                        .accessibilityLabel("Open bundled setup guide")
                }
            }
        }
    }

    private var background: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 12) {
                Text("Available in the background")
                    .font(GatewayTheme.display(24))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("Closing this window exits the control panel. Your gateway keeps serving connections and starts again when you log in.")
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
                if let note = model.backgroundIdentityNote {
                    Text(note)
                        .font(GatewayTheme.body(12))
                        .foregroundStyle(GatewayTheme.moss)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Open Login Items") {
                    SMAppService.openSystemSettingsLoginItems()
                }
                .buttonStyle(GatewaySecondaryButtonStyle())
            }
        }
    }
}
