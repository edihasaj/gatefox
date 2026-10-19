import AppKit
import SwiftUI

struct SetupWizardView: View {
    @ObservedObject var gateway: GatewayModel
    @ObservedObject var connections: GatewayConnectionsModel
    @Binding var isPresented: Bool

    @State private var step: WizardStep
    @State private var choice = ProviderChoice.claude
    @State private var label = ""
    @State private var accountEmail = ""
    @State private var endpoint = ProviderChoice.responsesAPI.defaultEndpoint
    @State private var apiFormat = APIFormat.responses
    @State private var apiKey = ""
    @State private var useExistingLogin = false
    @State private var didCommit = false
    @State private var selectionGeneration = 0
    private let isInitialSetup: Bool

    init(gateway: GatewayModel, connections: GatewayConnectionsModel, isPresented: Binding<Bool>) {
        self.gateway = gateway
        self.connections = connections
        _isPresented = isPresented
        isInitialSetup = !gateway.hasConfig
        _step = State(initialValue: gateway.hasConfig ? .provider : .welcome)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(GatewayTheme.line)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    stepContent
                    if let message = connections.message, !message.isEmpty {
                        WizardNotice(message: message)
                    }
                }
                .padding(32)
                .frame(maxWidth: 680, alignment: .leading)
            }
            .disabled(connections.isBusy)
            Divider().overlay(GatewayTheme.line)
            footer
        }
        .frame(minWidth: 620, idealWidth: 680, minHeight: 580, idealHeight: 680)
        .background(GatewayTheme.parchment)
        .interactiveDismissDisabled(true)
        .onChange(of: endpoint) { _, _ in apiKey = "" }
        .onChange(of: apiFormat) { _, newFormat in
            guard choice.supportsAPIFormat else { return }
            selectionGeneration += 1
            endpoint = choice.defaultEndpoint(for: newFormat)
        }
        .onDisappear { apiKey = "" }
        .onExitCommand { cancel() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            FoxMark(size: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.eyebrow)
                    .font(GatewayTheme.body(11, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(GatewayTheme.moss)
                Text(step.title)
                    .font(GatewayTheme.display(29))
                    .foregroundStyle(GatewayTheme.charcoal)
            }
            Spacer()
            Text(step.progress)
                .font(GatewayTheme.body(12, weight: .semibold))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.5))
        }
        .padding(.horizontal, 30)
        .padding(.vertical, 22)
    }

    @ViewBuilder private var stepContent: some View {
        switch step {
        case .welcome: welcome
        case .provider: providerPicker
        case .connect: connectionForm
        case .models: modelPicker
        case .review: review
        case .finish: finish
        }
    }

    private var welcome: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("A quiet place to connect your accounts.")
                    .font(GatewayTheme.display(34))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("Add one provider now. Your running gateway and existing accounts remain untouched until you review and apply the connection.")
                    .font(GatewayTheme.body(15))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button("Add a connection") { step = .provider }
                        .buttonStyle(GatewayPrimaryButtonStyle())
                        .accessibilityIdentifier("wizard.next")
                    Button("Use existing settings…") { connections.useExistingSettings() }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(gateway.isBusy || connections.isBusy)
                        .accessibilityIdentifier("wizard.existing-settings")
                }
                Text("Choosing a file only opens it here; it does not import or copy credentials.")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.53))
            }
        }
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose the account you want to add.")
                .font(GatewayTheme.body(15))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                ForEach(ProviderChoice.allCases) { provider in
                    Button {
                        selectionGeneration += 1
                        choice = provider
                        endpoint = provider.defaultEndpoint
                        apiFormat = .responses
                        useExistingLogin = false
                        apiKey = ""
                        accountEmail = ""
                        connections.clearMessage()
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Image(systemName: provider.symbol)
                                .font(.system(size: 19, weight: .medium))
                            Text(provider.title).font(GatewayTheme.body(15, weight: .semibold))
                            Text(provider.detail)
                                .font(GatewayTheme.body(12))
                                .foregroundStyle(GatewayTheme.charcoal.opacity(0.62))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(GatewayTheme.charcoal)
                        .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
                        .padding(16)
                        .background(choice == provider ? GatewayTheme.moss.opacity(0.13) : .white.opacity(0.52), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                .stroke(choice == provider ? GatewayTheme.moss : GatewayTheme.line, lineWidth: choice == provider ? 2 : 1)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Choose \(provider.title)")
                    .accessibilityIdentifier(provider == .localOpenAI ? "wizard.provider.local" : "wizard.provider.\(provider.id)")
                }
            }
        }
    }

    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 20) {
            GatewayPanel {
                VStack(alignment: .leading, spacing: 14) {
                    Text(choice.title).font(GatewayTheme.display(25)).foregroundStyle(GatewayTheme.charcoal)
                    Text(choice.connectingCopy)
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.68))
                        .fixedSize(horizontal: false, vertical: true)
                    TextField("Connection name (optional)", text: $label)
                        .gatewayInputFieldStyle()
                        .accessibilityIdentifier("wizard.label")
                    if choice.allowsAccountEmail && !(choice.canReuseLogin && useExistingLogin) {
                        TextField("Account email (optional)", text: $accountEmail)
                            .gatewayInputFieldStyle()
                            .accessibilityIdentifier("wizard.email")
                    }
                    if choice.requiresEndpoint {
                        endpointFields
                    }
                    if choice.canReuseLogin {
                        Toggle("Use an existing sign-in on this Mac", isOn: $useExistingLogin)
                            .toggleStyle(.switch)
                            .font(GatewayTheme.body(14, weight: .medium))
                            .accessibilityIdentifier("wizard.existing-login")
                        Text(useExistingLogin ? "The gateway will use the provider’s current local sign-in without copying it." : "A separate, private sign-in will be used for this connection.")
                            .font(GatewayTheme.body(12))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.58))
                    }
                }
            }
            if choice.isSubscription { prerequisites }
        }
    }

    private var endpointFields: some View {
        VStack(alignment: .leading, spacing: 9) {
            if choice.supportsAPIFormat {
                Picker("Model API format", selection: $apiFormat) {
                    ForEach(APIFormat.allCases) { format in
                        Text(format.title).tag(format)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("wizard.api-format")
                Text("Choose the API documented for each model. A mixed OpenCode catalog does not mean every model works through this format.")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.58))
            }
            TextField("Server address", text: $endpoint)
                .gatewayInputFieldStyle()
                .accessibilityLabel("Server address")
                .accessibilityIdentifier("wizard.endpoint")
            if choice.requiresEndpoint {
                SecureField(choice == .localOpenAI ? "API key (if required)" : "API key", text: $apiKey)
                    .gatewayInputFieldStyle()
                    .accessibilityLabel("API key")
                    .accessibilityIdentifier("wizard.key")
                Text(choice == .localOpenAI ? "A key is optional for a local server. Leave it blank only when the server accepts local requests without one." : "The key stays in private gateway storage and is never shown here again.")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.58))
            }
        }
    }

    private var prerequisites: some View {
        let missing = connections.prerequisites.filter {
            !$0.available && choice.requiredPrerequisiteIDs.contains($0.id)
        }
        return Group {
            if !missing.isEmpty {
                GatewayPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Before you continue", systemImage: "exclamationmark.circle")
                            .font(GatewayTheme.body(14, weight: .semibold))
                            .foregroundStyle(GatewayTheme.vermilion)
                        ForEach(missing) { prerequisite in
                            HStack {
                                Text(prerequisite.label).font(GatewayTheme.body(13))
                                Spacer()
                                if let url = prerequisite.downloadURL, let destination = URL(string: url) {
                                    Button("Get it") { NSWorkspace.shared.open(destination) }
                                        .buttonStyle(.link)
                                        .accessibilityLabel("Open \(prerequisite.label) download")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose the models this connection can offer.")
                .font(GatewayTheme.body(15))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.68))
            if connections.isBusy {
                ProgressView("Looking for available models…")
                    .font(GatewayTheme.body(14))
                    .controlSize(.small)
            } else if connections.availableModels.isEmpty {
                GatewayPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("No models were returned yet.").font(GatewayTheme.body(15, weight: .semibold))
                        if choice.supportsManualModels {
                            manualModels
                        } else {
                            Text("Check the account connection, then try again.")
                                .font(GatewayTheme.body(13))
                                .foregroundStyle(GatewayTheme.charcoal.opacity(0.62))
                        }
                    }
                }
            } else {
                GatewayPanel { modelChecklist }
                if choice.supportsManualModels { manualModels }
            }
        }
    }

    private var modelChecklist: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(connections.availableModels) { model in
                Toggle(isOn: modelBinding(model.id)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.label).font(GatewayTheme.body(14, weight: .semibold))
                        if let alias = model.alias, alias != model.label {
                            Text(alias).font(GatewayTheme.body(12)).foregroundStyle(GatewayTheme.charcoal.opacity(0.55))
                        }
                    }
                }
                .toggleStyle(.checkbox)
                .accessibilityIdentifier("wizard.model.\(model.id)")
            }
        }
    }

    private var manualModels: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Add model IDs manually")
                .font(GatewayTheme.body(13, weight: .semibold))
            TextField("One model ID per line", text: $connections.manualModelsText, axis: .vertical)
                .lineLimit(3...6)
                .gatewayInputFieldStyle()
                .accessibilityIdentifier("wizard.manual-models")
            Text("Use this only when the server does not list its catalog.")
                .font(GatewayTheme.body(12))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.56))
        }
    }

    private var review: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 17) {
                Text("Ready when you are.")
                    .font(GatewayTheme.display(30))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("Add \(choice.title) with \(selectedCount) \(selectedCount == 1 ? "model" : "models").")
                    .font(GatewayTheme.body(16, weight: .medium))
                Text("Applying saves only this reviewed connection. It does not restart your gateway service or change other accounts.")
                    .font(GatewayTheme.body(14))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var finish: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 17) {
                Label("Connection saved", systemImage: "checkmark.seal.fill")
                    .font(GatewayTheme.display(30))
                    .foregroundStyle(GatewayTheme.moss)
                readinessRow("Gateway service", ready: gateway.serviceInstalled)
                readinessRow("Desktop connection", ready: gateway.desktopReady)
                if gateway.setupComplete && isInitialSetup {
                    Text("Quit and reopen Codex once to load your gateway models. Future launches keep this connection.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                }
                if !gateway.setupComplete {
                    Text("The connection is saved, but this Mac still needs finishing before the desktop is ready.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.7))
                    Button("Finish connecting this Mac") {
                        Task { await gateway.setup() }
                    }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(gateway.isBusy || !gateway.canSetup)
                    if !FileManager.default.fileExists(atPath: "/Applications/ChatGPT.app") {
                        Link("Get Codex for Mac", destination: URL(string: "https://chatgpt.com/codex")!)
                            .font(GatewayTheme.body(14, weight: .semibold))
                            .foregroundStyle(GatewayTheme.vermilion)
                    }
                    if let guide = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "guide") {
                        Link("Open installation guide", destination: guide)
                            .font(GatewayTheme.body(14, weight: .semibold))
                            .foregroundStyle(GatewayTheme.vermilion)
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            if step != .welcome && step != .finish {
                Button("Back") { goBack() }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(connections.isBusy)
            }
            Button(step == .finish ? "Close" : "Cancel") { cancel() }
                .buttonStyle(GatewaySecondaryButtonStyle())
                .disabled(connections.isSaving)
            Spacer()
            actionButton
        }
        .padding(.horizontal, 30)
        .padding(.vertical, 18)
    }

    @ViewBuilder private var actionButton: some View {
        switch step {
        case .welcome: EmptyView()
        case .provider:
            Button("Continue") { step = .connect }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .accessibilityIdentifier("wizard.next")
        case .connect:
            Button(choice.isSubscription && !(choice.canReuseLogin && useExistingLogin) ? "Connect subscription in browser" : "Find models") { prepareConnection() }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(connections.isBusy || !connectionFormIsValid)
                .accessibilityIdentifier("wizard.next")
        case .models:
            Button("Review connection") { step = .review }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(connections.isBusy || selectedCount == 0)
                .accessibilityIdentifier("wizard.next")
        case .review:
            Button("Apply connection") { commit() }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .disabled(connections.isBusy || selectedCount == 0)
                .accessibilityIdentifier("wizard.apply")
        case .finish:
            Button("Done") { isPresented = false }
                .buttonStyle(GatewayPrimaryButtonStyle())
                .accessibilityIdentifier("wizard.done")
        }
    }

    private var connectionFormIsValid: Bool {
        guard choice.requiresEndpoint else { return true }
        guard URL(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)) != nil else { return false }
        return !choice.requiresKey || choice == .localOpenAI || !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var selectedCount: Int {
        connections.effectiveSelection.count
    }

    private func prepareConnection() {
        let selectedChoice = choice
        let selectedAPIFormat = apiFormat
        let selectedGeneration = selectionGeneration
        let expectedBackendType = selectedChoice.effectiveBackendType(for: selectedAPIFormat)
        var input = ProviderInput(label: label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? choice.title : label.trimmingCharacters(in: .whitespacesAndNewlines), type: expectedBackendType)
        input.baseUrl = choice.requiresEndpoint ? endpoint.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        input.apiKey = choice.requiresEndpoint && !apiKey.isEmpty ? apiKey : nil
        input.useExistingLogin = choice.canReuseLogin ? useExistingLogin : nil
        input.accountEmail = accountEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : accountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            guard await connections.prepare(input),
                  choice == selectedChoice,
                  apiFormat == selectedAPIFormat,
                  selectionGeneration == selectedGeneration,
                  connections.draft?.provider.type == expectedBackendType else { return }
            if selectedChoice.isSubscription && !(selectedChoice.canReuseLogin && useExistingLogin) {
                guard await connections.authenticate(),
                      choice == selectedChoice,
                      apiFormat == selectedAPIFormat,
                      selectionGeneration == selectedGeneration,
                      connections.draft?.provider.type == expectedBackendType else { return }
            }
            let discovered = await connections.discover()
            guard discovered || selectedChoice.supportsManualModels,
                  choice == selectedChoice,
                  apiFormat == selectedAPIFormat,
                  selectionGeneration == selectedGeneration,
                  connections.draft?.provider.type == expectedBackendType else { return }
            step = .models
        }
    }

    private func commit() {
        Task {
            if await connections.commitDraft() {
                didCommit = true
                step = .finish
            }
        }
    }

    private func goBack() {
        switch step {
        case .provider: step = .welcome
        case .connect: discardDraftThen { step = .provider }
        case .models: discardDraftThen { step = .connect }
        case .review: step = .models
        case .welcome, .finish: break
        }
    }

    private func cancel() {
        if connections.isBusy {
            connections.cancel()
            return
        }
        if didCommit || connections.draft == nil {
            isPresented = false
        } else {
            discardDraftThen { isPresented = false }
        }
    }

    private func discardDraftThen(_ action: @escaping () -> Void) {
        Task {
            if await connections.discardDraft() { action() }
        }
    }

    private func modelBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { connections.selectedModels.contains(id) },
            set: { selected in
                if selected { connections.selectedModels.insert(id) }
                else { connections.selectedModels.remove(id) }
            }
        )
    }

    private func readinessRow(_ title: String, ready: Bool) -> some View {
        HStack(spacing: 9) {
            Image(systemName: ready ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(ready ? GatewayTheme.moss : GatewayTheme.charcoal.opacity(0.34))
            Text(title).font(GatewayTheme.body(14, weight: .semibold))
            Spacer()
            Text(ready ? "Ready" : "Needs setup")
                .font(GatewayTheme.body(13))
                .foregroundStyle(ready ? GatewayTheme.moss : GatewayTheme.charcoal.opacity(0.6))
        }
    }
}
