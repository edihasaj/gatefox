import SwiftUI

struct ProviderModelsView: View {
    @ObservedObject var connections: GatewayConnectionsModel
    let provider: ManagedProvider
    @Binding var isPresented: Bool

    @State private var didLoad = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("MODELS")
                        .font(GatewayTheme.body(11, weight: .semibold))
                        .tracking(1.3)
                        .foregroundStyle(GatewayTheme.moss)
                    Text("Choose models")
                        .font(GatewayTheme.display(28))
                        .foregroundStyle(GatewayTheme.charcoal)
                    Text(provider.label)
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                }
                Spacer()
                if provider.canDiscover {
                    Button("Refresh catalog") { Task { _ = await connections.discover(providerID: provider.id) } }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(connections.isBusy)
                        .accessibilityIdentifier("connections.refresh-models.\(provider.id)")
                }
            }
            .padding(28)
            Divider().overlay(GatewayTheme.line)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    AutoLatestSelectionNote(connections: connections)
                    if connections.isBusy && !didLoad {
                        ProgressView("Looking for models…")
                            .font(GatewayTheme.body(14))
                            .frame(maxWidth: .infinity, minHeight: 180)
                    } else {
                        catalog
                    }
                    if let message = connections.message, !message.isEmpty {
                        Label(message, systemImage: "info.circle")
                            .font(GatewayTheme.body(13))
                            .padding(13)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(GatewayTheme.moss.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                }
                .padding(28)
            }
            Divider().overlay(GatewayTheme.line)
            HStack {
                Button("Cancel") {
                    if connections.isBusy { connections.cancel() }
                    else { isPresented = false }
                }
                    .buttonStyle(GatewaySecondaryButtonStyle())
                    .disabled(connections.isSaving)
                Spacer()
                Button("Apply selected models") { apply() }
                    .buttonStyle(GatewayPrimaryButtonStyle())
                    .disabled(connections.isBusy || selectedCount == 0)
                    .accessibilityIdentifier("connections.apply-models.\(provider.id)")
            }
            .padding(22)
        }
        .frame(minWidth: 580, idealWidth: 640, minHeight: 500, idealHeight: 640)
        .background(GatewayTheme.parchment)
        .task {
            guard !didLoad else { return }
            didLoad = true
            connections.beginEditing(provider)
            if provider.canDiscover {
                _ = await connections.discover(providerID: provider.id)
            }
        }
        .onExitCommand { if !connections.isBusy { isPresented = false } }
    }

    private var catalog: some View {
        VStack(alignment: .leading, spacing: 10) {
            if connections.availableModels.isEmpty {
                GatewayPanel {
                    Text(provider.canDiscover
                        ? "No models are available yet. Refresh the catalog or add a model ID below if this is an API server."
                        : "No models were configured for this connection yet. Choose the models to enable, then apply them.")
                        .font(GatewayTheme.body(14))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.68))
                }
            } else {
                GatewayPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(connections.availableModels) { model in
                            Toggle(isOn: modelBinding(model.id)) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(model.label).font(GatewayTheme.body(14, weight: .semibold))
                                    if let alias = model.alias, alias != model.label {
                                        Text(alias).font(GatewayTheme.body(12)).foregroundStyle(GatewayTheme.charcoal.opacity(0.55))
                                    }
                                    if let providerDate = model.providerDate {
                                        Text("Provider date \(providerDate.formatted(date: .abbreviated, time: .omitted))")
                                            .font(GatewayTheme.body(11)).foregroundStyle(GatewayTheme.charcoal.opacity(0.48))
                                    }
                                }
                            }
                            .toggleStyle(.checkbox)
                            .accessibilityIdentifier("wizard.model.\(model.id)")
                        }
                    }
                }
            }
            if supportsManualModels {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Add model IDs manually")
                        .font(GatewayTheme.body(13, weight: .semibold))
                    TextField("One model ID per line", text: $connections.manualModelsText, axis: .vertical)
                        .lineLimit(3...6)
                        .gatewayInputFieldStyle()
                        .accessibilityIdentifier("connections.manual-models.\(provider.id)")
                    Text("Use this only when the provider cannot list its models.")
                        .font(GatewayTheme.body(12))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.56))
                }
            }
        }
    }

    private var selectedCount: Int {
        connections.effectiveSelection.count
    }

    private var supportsManualModels: Bool {
        provider.type.isAPIProviderType
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

    private func apply() {
        Task {
            if await connections.saveModels(providerID: provider.id) {
                isPresented = false
            }
        }
    }
}
