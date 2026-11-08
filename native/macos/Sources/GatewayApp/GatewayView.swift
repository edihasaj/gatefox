import AppKit
import SwiftUI

struct GatewayView: View {
    @ObservedObject var model: GatewayModel
    @ObservedObject var connections: GatewayConnectionsModel
    @EnvironmentObject private var navigation: GatewayNavigation
    @EnvironmentObject private var permissions: GatewayPermissions

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            Group {
                switch navigation.selection ?? .overview {
                case .overview:
                    OverviewView(model: model)
                case .activity:
                    GatewayActivityView(gateway: model)
                case .diagnostics:
                    GatewayDiagnosticsView(gateway: model)
                case .connections:
                    ConnectionsView(gateway: model, connections: connections) {
                        navigation.showSetup = true
                    }
                case .settings:
                    SettingsView(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(GatewayTheme.parchment)
        }
        .navigationSplitViewStyle(.balanced)
        .tint(GatewayTheme.vermilion)
        .alert("Allow access to protected files?", isPresented: $permissions.showInvitation) {
            Button("Open Full Disk Access") {
                permissions.dismissInvitation()
                navigation.selection = .settings
                permissions.open(.fullDiskAccess)
            }
            Button("Not now", role: .cancel) { permissions.dismissInvitation() }
        } message: {
            Text("Full Disk Access is optional for development tasks that need protected files. It allows broad access to data such as Mail, Messages and backups. Enable GateFox manually in System Settings → Privacy & Security → Full Disk Access. You can review permissions later in Settings.")
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                FoxMark(size: 38)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Harness")
                        .font(GatewayTheme.body(16, weight: .semibold))
                    Text("Gateway")
                        .font(GatewayTheme.display(18))
                }
                .foregroundStyle(GatewayTheme.charcoal)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 25)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("GateFox")

            List(selection: $navigation.selection) {
                Label("Overview", systemImage: "rectangle.grid.1x2")
                    .tag(GatewayNavigation.Section.overview)
                    .accessibilityLabel("Overview")
                Label("Activity", systemImage: "clock.arrow.circlepath")
                    .tag(GatewayNavigation.Section.activity)
                    .accessibilityIdentifier("sidebar.activity")
                Label("Diagnostics", systemImage: "chart.bar.xaxis")
                    .tag(GatewayNavigation.Section.diagnostics)
                    .accessibilityIdentifier("sidebar.diagnostics")
                Label("Connections", systemImage: "point.3.connected.trianglepath.dotted")
                    .tag(GatewayNavigation.Section.connections)
                    .accessibilityLabel("Connections")
                    .accessibilityIdentifier("sidebar.connections")
                Label("Settings", systemImage: "gearshape")
                    .tag(GatewayNavigation.Section.settings)
                    .accessibilityLabel("Settings")
            }
            .listStyle(.sidebar)
            .font(GatewayTheme.body(14, weight: .medium))

            Spacer(minLength: 16)

            if !model.clientOnly {
                Button {
                    navigation.showSetup = true
                } label: {
                    Label("Add connection", systemImage: "plus")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(GatewaySecondaryButtonStyle())
                .disabled(connections.isBusy || model.isBusy)
                .accessibilityIdentifier("sidebar.add-connection")
                .padding(.horizontal, 16)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("HARNESS GATEWAY")
                    .font(GatewayTheme.body(10, weight: .semibold))
                    .tracking(1.1)
                Text(appVersion)
                    .font(GatewayTheme.body(12))
            }
            .foregroundStyle(GatewayTheme.charcoal.opacity(0.52))
            .padding(20)
        }
        .frame(minWidth: 218, idealWidth: 234, maxWidth: 258)
        .background(GatewayTheme.parchment.opacity(0.84))
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return version.map { "Version \($0)" } ?? "Local control panel"
    }
}

private struct OverviewView: View {
    @ObservedObject var model: GatewayModel
    @EnvironmentObject private var navigation: GatewayNavigation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                hero
                controls
                GatewayPanel {
                    VStack(alignment: .leading, spacing: 18) {
                        ProviderList(providers: model.providers, totalModels: model.modelCount)
                        Button("Manage connections") {
                            navigation.selection = .connections
                        }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .accessibilityIdentifier("overview.manage-connections")
                    }
                }
                GatewayPanel {
                    StatusList(model: model)
                }
                if let message = model.message, !message.isEmpty {
                    messageView(message)
                }
            }
            .padding(.horizontal, 42)
            .padding(.vertical, 42)
            .frame(maxWidth: 920, alignment: .leading)
        }
        .accessibilityLabel("Gateway overview")
    }

    private var hero: some View {
        HStack(alignment: .top, spacing: 28) {
            VStack(alignment: .leading, spacing: 12) {
                Text("OVERVIEW")
                    .font(GatewayTheme.body(11, weight: .semibold))
                    .tracking(1.5)
                    .foregroundStyle(GatewayTheme.moss)
                Text("Everything,\nin good company.")
                    .font(GatewayTheme.display(42))
                    .foregroundStyle(GatewayTheme.charcoal)
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.endpoint)
                    .font(GatewayTheme.body(13))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.58))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityLabel("Gateway endpoint, \(model.endpoint)")
            }
            Spacer(minLength: 16)
            ReachabilityChip(isReachable: model.isReachable)
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            if model.setupComplete {
                Button("Open Codex") {
                    model.openCodex()
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .accessibilityLabel("Open Codex")
            } else if !model.hasConfig {
                Button("Set up Gateway") {
                    navigation.showSetup = true
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(model.isBusy)
                .accessibilityLabel("Open gateway setup wizard")
            } else {
                Button("Set up once") {
                    Task { await model.setup() }
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(model.isBusy || !model.canSetup)
                .accessibilityLabel("Set up gateway once")
            }

            Button("Refresh") {
                Task { await model.refresh() }
            }
            .buttonStyle(GatewaySecondaryButtonStyle())
            .disabled(model.isBusy)
            .accessibilityLabel("Refresh gateway status")

            if model.isBusy {
                ProgressView()
                    .controlSize(.small)
                    .padding(.leading, 4)
                    .accessibilityLabel("Checking gateway status")
            }
            Spacer()
            if let lastChecked = model.lastChecked {
                Text("Checked \(lastChecked, format: .relative(presentation: .named))")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.5))
            }
        }
    }

    private func messageView(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "text.bubble")
                .foregroundStyle(GatewayTheme.moss)
            Text(message)
                .font(GatewayTheme.body(13))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.8))
                .textSelection(.enabled)
        }
        .padding(15)
        .background(GatewayTheme.moss.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Gateway message: \(message)")
    }
}

private struct ReachabilityChip: View {
    let isReachable: Bool

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(isReachable ? GatewayTheme.moss : GatewayTheme.vermilion)
                .frame(width: 7, height: 7)
            Text(isReachable ? "Connected" : "Unavailable")
                .font(GatewayTheme.body(13, weight: .semibold))
        }
        .foregroundStyle(isReachable ? GatewayTheme.moss : GatewayTheme.vermilion)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background((isReachable ? GatewayTheme.moss : GatewayTheme.vermilion).opacity(0.10), in: Capsule())
        .accessibilityLabel(isReachable ? "Gateway connected" : "Gateway unavailable")
    }
}

private struct ProviderList: View {
    let providers: [GatewayProvider]
    let totalModels: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Configured routes")
                        .font(GatewayTheme.display(24))
                        .foregroundStyle(GatewayTheme.charcoal)
                    Text("Accounts and model choices stay in your existing settings.")
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.57))
                }
                Spacer()
                Text("\(totalModels) \(totalModels == 1 ? "model" : "models")")
                    .font(GatewayTheme.body(13, weight: .semibold))
                    .foregroundStyle(GatewayTheme.moss)
            }

            if providers.isEmpty {
                Text("No configured provider routes were found.")
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                    .padding(.vertical, 6)
            } else {
                ForEach(providers) { provider in
                    ProviderRow(provider: provider)
                    if provider.id != providers.last?.id {
                        Divider().overlay(GatewayTheme.line)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Configured routes, \(totalModels) models")
    }
}

private struct ProviderRow: View {
    let provider: GatewayProvider

    var body: some View {
        HStack(spacing: 12) {
            Text(monogram)
                .font(GatewayTheme.body(14, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(provider.label)
                    .font(GatewayTheme.body(15, weight: .semibold))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text(provider.kind)
                    .font(GatewayTheme.body(11, weight: .medium))
                    .tracking(0.8)
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.54))
            }
            Spacer()
            Text("\(provider.modelCount) \(provider.modelCount == 1 ? "model" : "models")")
                .font(GatewayTheme.body(13, weight: .medium))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.66))
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.label), \(provider.kind), \(provider.modelCount) \(provider.modelCount == 1 ? "model" : "models")")
    }

    private var monogram: String {
        String(provider.label.prefix(1)).uppercased()
    }

    private var tint: Color {
        let palette = [GatewayTheme.vermilion, GatewayTheme.moss, Color(red: 0.18, green: 0.35, blue: 0.42), Color(red: 0.48, green: 0.31, blue: 0.17)]
        let index = abs(provider.label.unicodeScalars.reduce(0) { $0 + Int($1.value) }) % palette.count
        return palette[index]
    }
}

private struct StatusList: View {
    @ObservedObject var model: GatewayModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("System status")
                .font(GatewayTheme.display(24))
                .foregroundStyle(GatewayTheme.charcoal)
                .padding(.bottom, 12)
            StatusRow(title: "Connected", detail: "Gateway health endpoint", isReady: model.isReachable)
            Divider().overlay(GatewayTheme.line)
            StatusRow(title: "Background service", detail: "Runs independently of this window", isReady: model.serviceInstalled)
            Divider().overlay(GatewayTheme.line)
            StatusRow(title: "Desktop connected", detail: "Codex desktop registration", isReady: model.desktopReady)
        }
    }
}

private struct StatusRow: View {
    let title: String
    let detail: String
    let isReady: Bool

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: isReady ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isReady ? GatewayTheme.moss : GatewayTheme.charcoal.opacity(0.28))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(GatewayTheme.body(14, weight: .semibold))
                Text(detail)
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.55))
            }
            Spacer()
            Text(isReady ? "Ready" : "Needs attention")
                .font(GatewayTheme.body(12, weight: .medium))
                .foregroundStyle(isReady ? GatewayTheme.moss : GatewayTheme.charcoal.opacity(0.58))
        }
        .foregroundStyle(GatewayTheme.charcoal)
        .padding(.vertical, 13)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(isReady ? "ready" : "needs attention")")
    }
}

struct FoxMark: View {
    let size: CGFloat

    var body: some View {
        Group {
            if let path = Bundle.main.path(forResource: "fox", ofType: "png"),
               let fox = NSImage(contentsOfFile: path) {
                Image(nsImage: fox)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "leaf.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(GatewayTheme.moss)
                    .padding(8)
            }
        }
        .frame(width: size, height: size)
        .background(.white.opacity(0.56), in: RoundedRectangle(cornerRadius: size * 0.29, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.29, style: .continuous)
                .stroke(GatewayTheme.line, lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}
