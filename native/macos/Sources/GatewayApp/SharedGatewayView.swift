import SwiftUI

/// Read-only catalog of the providers a remote gateway publishes to this Mac.
/// It never exposes credential state, sign-in controls, or editing actions;
/// accounts and model choices stay managed on the gateway host.
struct SharedGatewayView: View {
    @ObservedObject var connections: GatewayConnectionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let snapshot = connections.sharedGateway, snapshot.isAvailable {
                availableCatalog(snapshot)
            } else {
                unavailableState
            }
        }
        .accessibilityIdentifier("shared-gateway.panel")
    }

    private func availableCatalog(_ snapshot: SharedGatewaySnapshot) -> some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Shared gateway")
                            .font(GatewayTheme.display(27))
                            .foregroundStyle(GatewayTheme.charcoal)
                        Text(hostLine(snapshot))
                            .font(GatewayTheme.body(14))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                    }
                    Spacer()
                    Text("Read only")
                        .font(GatewayTheme.body(12, weight: .semibold))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.55))
                        .accessibilityIdentifier("shared-gateway.readonly")
                }
                Text("Accounts and model choices are managed on the gateway host. Adding, editing, signing in, and removing connections happen on that Mac.")
                    .font(GatewayTheme.body(13))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                if let providers = snapshot.providers, !providers.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(providers) { provider in
                            sharedProviderRow(provider)
                            if provider.id != providers.last?.id {
                                Divider().overlay(GatewayTheme.line)
                            }
                        }
                    }
                } else {
                    Text("The gateway answered, but published no provider catalog yet. Refresh to check again.")
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                }
            }
        }
    }

    private func sharedProviderRow(_ provider: SharedGatewayProvider) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(GatewayTheme.moss)
                    .frame(width: 30, height: 30)
                    .background(GatewayTheme.moss.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                Text(provider.label)
                    .font(GatewayTheme.body(15, weight: .semibold))
                    .foregroundStyle(GatewayTheme.charcoal)
                Spacer()
                Text("\(provider.models.count) \(provider.models.count == 1 ? "model" : "models")")
                    .font(GatewayTheme.body(13, weight: .medium))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.66))
            }
            if !provider.models.isEmpty {
                Text(provider.models.map(\.label).joined(separator: " · "))
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.58))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(provider.label), \(provider.models.count) \(provider.models.count == 1 ? "model" : "models"), managed on the gateway host")
    }

    private var unavailableState: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 12) {
                Label("The shared gateway catalog is unavailable.", systemImage: "wifi.slash")
                    .font(GatewayTheme.display(24))
                    .foregroundStyle(GatewayTheme.charcoal)
                Text("This Mac uses a shared gateway, but its catalog could not be read. Check the connection, this Mac’s client access, and that the host runs a compatible gateway version. Nothing here changes the gateway or its accounts.")
                    .font(GatewayTheme.body(13))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Try again") { Task { await connections.refresh() } }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(connections.isBusy)
                        .accessibilityIdentifier("shared-gateway.retry")
                    if connections.isBusy {
                        ProgressView().controlSize(.small)
                    }
                }
            }
        }
    }

    private func hostLine(_ snapshot: SharedGatewaySnapshot) -> String {
        guard let hostname = snapshot.hostname?.trimmingCharacters(in: .whitespacesAndNewlines),
              !hostname.isEmpty else {
            return "Runs on your gateway Mac."
        }
        return "Runs on \(hostname)."
    }
}
