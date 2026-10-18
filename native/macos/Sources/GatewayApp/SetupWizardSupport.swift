import SwiftUI

enum WizardStep: Int {
    case welcome, provider, connect, models, review, finish

    var eyebrow: String { self == .finish ? "COMPLETE" : "SET UP" }
    var title: String {
        switch self {
        case .welcome: "Welcome"
        case .provider: "Choose a provider"
        case .connect: "Connect safely"
        case .models: "Pick models"
        case .review: "Review connection"
        case .finish: "Saved"
        }
    }
    var progress: String { self == .welcome ? "START" : self == .finish ? "DONE" : "STEP \(rawValue) OF 4" }
}

enum ProviderChoice: String, CaseIterable, Identifiable {
    case claude = "claude-subscription"
    case codex = "codex-subscription"
    case copilot = "copilot-subscription"
    case responsesAPI = "responses-api"
    case anthropicAPI = "anthropic-api"
    case localOpenAI = "chat-completions-api"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .copilot: "GitHub Copilot"
        case .responsesAPI: "Responses API"
        case .anthropicAPI: "Anthropic API"
        case .localOpenAI: "Local OpenAI-compatible"
        }
    }
    var detail: String { isSubscription ? "Use your subscription" : "Connect with an API or local server" }
    var connectingCopy: String { isSubscription ? "Connect your subscription in browser, or use an available sign-in on this Mac." : "Enter your server address. We’ll find its available models before you save." }
    var symbol: String { isSubscription ? "person.crop.circle.badge.checkmark" : "server.rack" }
    var isSubscription: Bool { self == .claude || self == .codex || self == .copilot }
    var requiresEndpoint: Bool { !isSubscription }
    var requiresKey: Bool { self != .localOpenAI && !isSubscription }
    var supportsManualModels: Bool { !isSubscription }
    var allowsAccountEmail: Bool { self == .claude || self == .codex }
    var canReuseLogin: Bool { self == .claude || self == .copilot }
    var requiredPrerequisiteIDs: Set<String> {
        switch self {
        case .claude: ["claude"]
        case .copilot: ["copilot"]
        default: []
        }
    }
    var defaultEndpoint: String {
        switch self {
        case .responsesAPI: "https://api.openai.com/v1"
        case .anthropicAPI: "https://api.anthropic.com"
        case .localOpenAI: "http://127.0.0.1:11434/v1"
        default: ""
        }
    }
}

struct WizardNotice: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "info.circle")
            .font(GatewayTheme.body(13))
            .foregroundStyle(GatewayTheme.charcoal.opacity(0.8))
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GatewayTheme.moss.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel("Setup message: \(message)")
    }
}
