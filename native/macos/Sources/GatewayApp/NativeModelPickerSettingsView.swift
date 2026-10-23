import SwiftUI

/// Local presentation setting for the native GPT fallback models in the model picker. Shown for hosts and for
/// shared-gateway consumers: it belongs to the Mac that runs the chats, not to any remote provider.
struct NativeModelPickerSettingsView: View {
    @ObservedObject var gateway: GatewayModel
    @ObservedObject var connections: GatewayConnectionsModel

    var body: some View {
        GatewayPanel {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "list.bullet.indent")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(GatewayTheme.moss)
                        .frame(width: 34, height: 34)
                        .background(GatewayTheme.moss.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Native GPT fallback models")
                            .font(GatewayTheme.body(17, weight: .semibold))
                            .foregroundStyle(GatewayTheme.charcoal)
                        Text("Choose where the built-in GPT models sit in the model picker.")
                            .font(GatewayTheme.body(13))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.64))
                    }
                    Spacer()
                    if connections.isBusy { ProgressView().controlSize(.small) }
                }
                Picker("Placement", selection: placementBinding) {
                    ForEach(NativeModelPickerPlacement.allCases) { placement in
                        Text(placement.title).tag(placement)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(!connections.canEditNativePlacement)
                .accessibilityLabel("Native GPT model placement")
                .accessibilityIdentifier("native-picker.placement")
                Text("Last is recommended: native GPT stays one step away as a fallback without crowding your gateway models. Hidden removes them from the picker only; native chats keep working.")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native-picker.explanation")
                Text(scopeText)
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native-picker.scope")
                if connections.nativePlacement == nil {
                    Text("Refresh connections to load this setting.")
                        .font(GatewayTheme.body(12))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.5))
                        .accessibilityIdentifier("native-picker.unavailable")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("native-picker.panel")
    }

    /// Shows the saved value only. A refused, cancelled, or obsolete save leaves it unchanged.
    private var placementBinding: Binding<NativeModelPickerPlacement> {
        Binding(
            get: { connections.nativePlacement ?? .first },
            set: { choice in Task { await connections.setNativePlacement(choice) } }
        )
    }

    private var scopeText: String {
        let host = GatewayConnectionScope.localHostName()
        let reconnect = " Applies after reconnecting the Codex adapter; active chats are not restarted."
        if gateway.clientOnly {
            return "Saved on this Mac (\(host)). It governs chats that run here; the shared gateway's connections stay read-only and are not changed." + reconnect
        }
        return "Saved on this Mac (\(host)). It applies to chats running here; chats opened over SSH use the setting on the Mac that runs them." + reconnect
    }
}
