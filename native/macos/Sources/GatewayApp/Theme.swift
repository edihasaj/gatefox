import SwiftUI

enum GatewayTheme {
    static let parchment = Color(red: 246 / 255, green: 243 / 255, blue: 235 / 255)
    static let charcoal = Color(red: 24 / 255, green: 32 / 255, blue: 27 / 255)
    static let moss = Color(red: 66 / 255, green: 98 / 255, blue: 88 / 255)
    static let vermilion = Color(red: 186 / 255, green: 60 / 255, blue: 25 / 255)
    static let line = Color(red: 24 / 255, green: 32 / 255, blue: 27 / 255).opacity(0.13)
    static let paperShadow = Color.black.opacity(0.08)

    static func display(_ size: CGFloat) -> Font {
        .custom("Baskerville", size: size, relativeTo: .largeTitle)
    }

    static func body(_ size: CGFloat = 14, weight: Font.Weight = .regular) -> Font {
        .custom("Avenir Next", size: size, relativeTo: .body).weight(weight)
    }
}

struct GatewayPanel<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(20)
            .background(.white.opacity(0.54), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(GatewayTheme.line, lineWidth: 1)
            }
    }
}

private enum GatewayControlMetrics {
    static let horizontalInset: CGFloat = 12
    static let verticalInset: CGFloat = 10
    static let minimumHeight: CGFloat = 44
    static let cornerRadius: CGFloat = 10
}

private struct GatewayInputFieldModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var isFocused: Bool

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(GatewayTheme.body(14))
            .foregroundStyle(GatewayTheme.charcoal)
            .focused($isFocused)
            .padding(.horizontal, GatewayControlMetrics.horizontalInset)
            .padding(.vertical, GatewayControlMetrics.verticalInset)
            .frame(maxWidth: .infinity, minHeight: GatewayControlMetrics.minimumHeight, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: GatewayControlMetrics.cornerRadius, style: .continuous)
                    .fill(.white)
                    .onTapGesture {
                        guard isEnabled else { return }
                        isFocused = true
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: GatewayControlMetrics.cornerRadius, style: .continuous)
                    .stroke(isFocused ? GatewayTheme.moss : GatewayTheme.line, lineWidth: isFocused ? 2 : 1)
                    .allowsHitTesting(false)
            }
            .opacity(isEnabled ? 1 : 0.45)
    }
}

extension View {
    func gatewayInputFieldStyle() -> some View {
        modifier(GatewayInputFieldModifier())
    }
}

struct GatewayPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(GatewayTheme.body(14, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, GatewayControlMetrics.horizontalInset)
            .padding(.vertical, GatewayControlMetrics.verticalInset)
            .frame(minHeight: GatewayControlMetrics.minimumHeight)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(GatewayTheme.vermilion.opacity(configuration.isPressed ? 0.78 : 1))
            }
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(isEnabled ? 1 : 0.45)
    }
}

struct GatewaySecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(GatewayTheme.body(14, weight: .medium))
            .foregroundStyle(GatewayTheme.charcoal)
            .padding(.horizontal, GatewayControlMetrics.horizontalInset)
            .padding(.vertical, GatewayControlMetrics.verticalInset)
            .frame(minHeight: GatewayControlMetrics.minimumHeight)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(GatewayTheme.charcoal.opacity(configuration.isPressed ? 0.12 : 0.07))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(GatewayTheme.line, lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
    }
}
