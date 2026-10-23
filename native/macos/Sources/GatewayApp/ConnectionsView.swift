import SwiftUI

struct ConnectionsView: View {
    @ObservedObject var gateway: GatewayModel
    @ObservedObject var connections: GatewayConnectionsModel
    let onAddConnection: () -> Void

    @State private var modelsProvider: ManagedProvider?
    @State private var renamingProvider: ManagedProvider?
    @State private var credentialProvider: ManagedProvider?
    @State private var removalCandidate: ManagedProvider?
    @State private var renameLabel = ""
    @State private var replacementAPIKey = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                if let message = connections.message, !message.isEmpty {
                    connectionMessage(message)
                }
                if gateway.hasConfig || connections.revision != nil {
                    NativeModelPickerSettingsView(gateway: gateway, connections: connections)
                }
                if gateway.clientOnly {
                    SharedGatewayView(connections: connections)
                } else if connections.connections.isEmpty {
                    emptyState
                } else {
                    providerList
                }
            }
            .padding(.horizontal, 42)
            .padding(.vertical, 38)
            .frame(maxWidth: 900, alignment: .leading)
        }
        .background(GatewayTheme.parchment)
        .onChange(of: gateway.configPath) { _, _ in
            dismissAllSheets()
        }
        .task { await connections.refresh() }
        .sheet(item: $modelsProvider) { provider in
            ProviderModelsView(connections: connections, provider: provider, isPresented: sheetBinding(for: provider, state: $modelsProvider))
        }
        .sheet(item: $renamingProvider) { provider in
            renameSheet(provider)
        }
        .sheet(item: $credentialProvider, onDismiss: { replacementAPIKey = "" }) { provider in
            credentialsSheet(provider)
        }
        .alert("Remove connection?", isPresented: removalAlertBinding) {
            Button("Remove", role: .destructive) { removeCandidate() }
            Button("Keep connection", role: .cancel) { removalCandidate = nil }
        } message: {
            Text("This removes \(removalCandidate?.label ?? "this connection") from the gateway. Its stored credentials are not deleted.")
        }
        .accessibilityLabel("Connections")
    }

    private var header: some View {
        HStack(alignment: .bottom, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("CONNECTIONS")
                    .font(GatewayTheme.body(11, weight: .semibold))
                    .tracking(1.5)
                    .foregroundStyle(GatewayTheme.moss)
                Text("Accounts, kept clear.")
                    .font(GatewayTheme.display(38))
                    .foregroundStyle(GatewayTheme.charcoal)
                if gateway.clientOnly {
                    Text("This Mac uses a gateway managed elsewhere. Its connections and models are listed read-only below.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Check each connection, choose its models, or add another account.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 10) {
                if gateway.clientOnly {
                    Text("Shared gateway")
                        .font(GatewayTheme.body(12, weight: .semibold))
                        .foregroundStyle(GatewayTheme.moss)
                        .accessibilityIdentifier("connections.scope")
                } else {
                    Text("This Mac · \(GatewayConnectionScope.localHostName())")
                        .font(GatewayTheme.body(12, weight: .semibold))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                        .accessibilityIdentifier("connections.scope")
                }
                if connections.isBusy {
                    Button("Cancel active task") { connections.cancel() }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .accessibilityIdentifier("connections.cancel")
                }
                Button("Refresh") { Task { await connections.refresh() } }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(connections.isBusy)
                    .accessibilityIdentifier("connections.refresh")
                if !gateway.clientOnly {
                    Button("Add connection", action: onAddConnection)
                        .buttonStyle(GatewayPrimaryButtonStyle())
                        .disabled(connections.isBusy)
                        .accessibilityIdentifier("connections.add")
                }
            }
        }
    }

    private var emptyState: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 12) {
                Text("No connections yet.")
                    .font(GatewayTheme.display(27))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("Add a provider to choose models for this gateway.")
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                Button("Add connection", action: onAddConnection)
                    .buttonStyle(GatewayPrimaryButtonStyle())
                    .disabled(connections.isBusy)
                    .accessibilityIdentifier("connections.add")
            }
        }
    }

    @ViewBuilder
    private var providerList: some View {
        VStack(alignment: .leading, spacing: 14) {
            hostScopeNote
            LazyVStack(spacing: 14) {
                ForEach(connections.connections) { provider in
                    providerCard(provider)
                }
            }
        }
    }

    private var hostScopeNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(GatewayTheme.moss)
            VStack(alignment: .leading, spacing: 2) {
                Text("This Mac · \(GatewayConnectionScope.localHostName())")
                    .font(GatewayTheme.body(13, weight: .semibold))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("Connections and model choices here apply to chats running on this Mac. Chats opened over SSH use the gateway on that remote Mac instead.")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(13)
        .background(GatewayTheme.moss.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .accessibilityIdentifier("connections.host-scope")
    }

    private func dismissAllSheets() {
        modelsProvider = nil
        renamingProvider = nil
        credentialProvider = nil
        removalCandidate = nil
        renameLabel = ""
        replacementAPIKey = ""
    }

    private func providerCard(_ provider: ManagedProvider) -> some View {
        let modelCount = provider.models.filter(\.enabled).count
        return GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: providerSymbol(provider))
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(GatewayTheme.moss)
                        .frame(width: 34, height: 34)
                        .background(GatewayTheme.moss.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.label).font(GatewayTheme.body(17, weight: .semibold))
                        Text(providerKind(provider))
                            .font(GatewayTheme.body(12, weight: .medium))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.56))
                    }
                    Spacer()
                    Text("\(modelCount) \(modelCount == 1 ? "model" : "models")")
                        .font(GatewayTheme.body(13, weight: .semibold))
                        .foregroundStyle(GatewayTheme.moss)
                    if !gateway.clientOnly, connections.connections.count > 1 {
                        reorderControls(provider)
                    }
                }
                HStack(spacing: 8) {
                    Image(systemName: authSymbol(provider.authState))
                        .foregroundStyle(authTint(provider.authState))
                    Text(provider.authDetail)
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                    Spacer()
                }
                .padding(11)
                .background(GatewayTheme.charcoal.opacity(0.045), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                HStack(spacing: 10) {
                    if provider.canDiscover {
                        Button("Check connection") { Task { await connections.discover(providerID: provider.id) } }
                            .buttonStyle(GatewaySecondaryButtonStyle())
                            .disabled(connections.isBusy)
                            .accessibilityIdentifier("connections.check.\(provider.id)")
                    }
                    Button("Choose models") { modelsProvider = provider }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(connections.isBusy)
                        .accessibilityIdentifier("connections.models.\(provider.id)")
                    if provider.canReconnect && isSubscription(provider) {
                        Button("Reconnect") {
                            Task {
                                if await connections.authenticate(providerID: provider.id) {
                                    await connections.discover(providerID: provider.id)
                                }
                            }
                        }
                            .buttonStyle(GatewaySecondaryButtonStyle())
                            .disabled(connections.isBusy)
                            .accessibilityIdentifier("connections.reconnect.\(provider.id)")
                    } else if provider.canReconnect {
                        Button("Update API key") {
                            replacementAPIKey = ""
                            credentialProvider = provider
                        }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(connections.isBusy)
                        .accessibilityIdentifier("connections.update-key.\(provider.id)")
                    }
                    Menu {
                        Button("Rename") { renameLabel = provider.label; renamingProvider = provider }
                        if !gateway.clientOnly, connections.connections.count > 1 {
                            Button("Move to top") { Task { await connections.move(providerID: provider.id, to: 0) } }
                                .disabled(connections.connections.first?.id == provider.id)
                        }
                        if !isSubscription(provider), !provider.canReconnect {
                            Text("API credentials are managed outside Harness Gateway.")
                        }
                        Divider()
                        Button("Remove connection", role: .destructive) { removalCandidate = provider }
                            .disabled(connections.connections.count <= 1)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 17))
                            .frame(width: 33, height: 33)
                    }
                    .menuStyle(.borderlessButton)
                    .disabled(connections.isBusy)
                    .accessibilityLabel("More options for \(provider.label)")
                    Spacer()
                    if connections.isBusy {
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .accessibilityElement(children: .contain)
        }
    }

    /// Compact order controls. The list only changes from the saved response, never optimistically.
    private func reorderControls(_ provider: ManagedProvider) -> some View {
        let index = connections.connections.firstIndex(where: { $0.id == provider.id }) ?? 0
        let last = connections.connections.count - 1
        return HStack(spacing: 2) {
            Button { Task { await connections.move(providerID: provider.id, to: index - 1) } } label: {
                Image(systemName: "chevron.up").frame(width: 26, height: 26)
            }
            .buttonStyle(.borderless)
            .disabled(connections.isBusy || index <= 0)
            .help("Move up")
            .accessibilityLabel("Move \(provider.label) up")
            .accessibilityIdentifier("connections.move-up.\(provider.id)")
            Button { Task { await connections.move(providerID: provider.id, to: index + 1) } } label: {
                Image(systemName: "chevron.down").frame(width: 26, height: 26)
            }
            .buttonStyle(.borderless)
            .disabled(connections.isBusy || index >= last)
            .help("Move down")
            .accessibilityLabel("Move \(provider.label) down")
            .accessibilityIdentifier("connections.move-down.\(provider.id)")
        }
    }

    private func renameSheet(_ provider: ManagedProvider) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Rename connection")
                .font(GatewayTheme.display(27))
            TextField("Connection name", text: $renameLabel)
                .gatewayInputFieldStyle()
                .disabled(connections.isBusy)
                .accessibilityIdentifier("connections.rename.field")
            HStack {
                Button("Cancel") { renamingProvider = nil }.buttonStyle(GatewaySecondaryButtonStyle())
                Spacer()
                Button("Save") {
                    let label = renameLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !label.isEmpty else { return }
                    Task {
                        if await connections.rename(providerID: provider.id, label: label) {
                            renamingProvider = nil
                        }
                    }
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(renameLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || connections.isBusy)
            }
        }
        .padding(28)
        .frame(width: 420)
        .background(GatewayTheme.parchment)
    }

    private func credentialsSheet(_ provider: ManagedProvider) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Update API key")
                .font(GatewayTheme.display(27))
            Text("Enter a replacement key for \(provider.label). It is sent directly to private gateway storage and is never shown here again.")
                .font(GatewayTheme.body(14))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.68))
                .fixedSize(horizontal: false, vertical: true)
            SecureField("API key", text: $replacementAPIKey)
                .gatewayInputFieldStyle()
                .accessibilityIdentifier("connections.api-key.field")
            HStack {
                Button("Cancel") {
                    replacementAPIKey = ""
                    credentialProvider = nil
                }
                .buttonStyle(GatewaySecondaryButtonStyle())
                .disabled(connections.isBusy)
                Spacer()
                Button("Save key") {
                    let key = replacementAPIKey
                    Task {
                        if await connections.replaceCredentials(providerID: provider.id, apiKey: key) {
                            replacementAPIKey = ""
                            credentialProvider = nil
                        }
                    }
                }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(connections.isBusy || replacementAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(28)
        .frame(width: 460)
        .background(GatewayTheme.parchment)
    }

    private func connectionMessage(_ message: String) -> some View {
        Label(message, systemImage: "info.circle")
            .font(GatewayTheme.body(13))
            .foregroundStyle(GatewayTheme.charcoal.opacity(0.8))
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GatewayTheme.moss.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var removalAlertBinding: Binding<Bool> {
        Binding(get: { removalCandidate != nil }, set: { if !$0 { removalCandidate = nil } })
    }

    private func removeCandidate() {
        guard let provider = removalCandidate else { return }
        Task {
            if await connections.remove(providerID: provider.id) {
                removalCandidate = nil
            }
        }
    }

    private func sheetBinding(for provider: ManagedProvider, state: Binding<ManagedProvider?>) -> Binding<Bool> {
        Binding(get: { state.wrappedValue?.id == provider.id }, set: { if !$0 { state.wrappedValue = nil } })
    }

    private func isSubscription(_ provider: ManagedProvider) -> Bool {
        provider.type.isSubscriptionProviderType
    }

    private func providerKind(_ provider: ManagedProvider) -> String {
        switch provider.type {
        case "claude-subscription": "Claude subscription"
        case "codex-subscription": "Codex subscription"
        case "copilot-subscription": "GitHub Copilot subscription"
        case "grok-subscription": "Grok subscription"
        case "responses-api": "Responses API"
        case "anthropic-api": "Anthropic API"
        case "chat-completions-api": "OpenAI-compatible server"
        default: "Connected provider"
        }
    }

    private func providerSymbol(_ provider: ManagedProvider) -> String { isSubscription(provider) ? "person.crop.circle.badge.checkmark" : "server.rack" }
    private func authSymbol(_ state: String) -> String { state == "ready" ? "checkmark.circle.fill" : state == "needs-sign-in" ? "person.crop.circle.badge.exclamationmark" : "info.circle" }
    private func authTint(_ state: String) -> Color {
        if state == "ready" { return GatewayTheme.moss }
        if state == "needs-sign-in" || state == "missing-cli" { return GatewayTheme.vermilion }
        return GatewayTheme.charcoal.opacity(0.6)
    }
}
