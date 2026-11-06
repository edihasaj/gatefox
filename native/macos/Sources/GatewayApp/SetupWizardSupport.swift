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

enum APIFormat: String, CaseIterable, Identifiable {
    case responses
    case chatCompletions
    case anthropic

    var id: String { rawValue }
    var title: String {
        switch self {
        case .responses: "Responses"
        case .chatCompletions: "Chat Completions"
        case .anthropic: "Anthropic"
        }
    }
    var backendType: String {
        switch self {
        case .responses: "responses-api"
        case .chatCompletions: "chat-completions-api"
        case .anthropic: "anthropic-api"
        }
    }
}

enum ProviderChoice: String, CaseIterable, Identifiable {
    case claude = "claude-subscription"
    case codex = "codex-subscription"
    case copilot = "copilot-subscription"
    case responsesAPI = "responses-api"
    case anthropicAPI = "anthropic-api"
    case localOpenAI = "chat-completions-api"
    case grokAPI = "grok-api"
    case openCodeConsole = "opencode-console"
    case openCodeGo = "opencode-go"
    case openRouter = "openrouter"
    case deepSeek = "deepseek"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .copilot: "GitHub Copilot"
        case .responsesAPI: "Responses API"
        case .anthropicAPI: "Anthropic API"
        case .localOpenAI: "Local OpenAI-compatible"
        case .grokAPI: "Grok API"
        case .openCodeConsole: "OpenCode Console"
        case .openCodeGo: "OpenCode Go"
        case .openRouter: "OpenRouter"
        case .deepSeek: "DeepSeek"
        }
    }
    var detail: String { isSubscription ? "Use your subscription" : "Connect with an API or local server" }
    var connectingCopy: String {
        switch self {
        case .grokAPI:
            "Use an xAI API key from console.x.ai. Grok Build plan usage and its signed-in login are separate and are not used here."
        case .openCodeConsole, .openCodeGo:
            "Choose the API format for this connection, then enter your OpenCode API key. Add model IDs manually when its catalog is unavailable."
        case .openRouter:
            "Enter your OpenRouter API key. We’ll find available models before you save, or you can add model IDs manually."
        case .deepSeek:
            "Enter your DeepSeek API key. Usage is billed to your DeepSeek balance. V4 Flash is selected by default."
        default:
            isSubscription ? "Connect your subscription in browser, or use an available sign-in on this Mac." : "Enter your server address. We’ll find its available models before you save."
        }
    }
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
    /** DeepSeek's connection starts on Flash. Pricier models stay available but need a deliberate choice. */
    static func startsSelected(_ modelID: String, endpoint: String?) -> Bool {
        endpoint != ProviderChoice.deepSeek.defaultEndpoint || modelID == "deepseek-flash"
    }
    var supportsAPIFormat: Bool { self == .openCodeConsole || self == .openCodeGo }
    func effectiveBackendType(for apiFormat: APIFormat = .responses) -> String {
        switch self {
        case .grokAPI:
            "responses-api"
        case .openRouter, .deepSeek:
            "chat-completions-api"
        case .openCodeConsole, .openCodeGo:
            apiFormat.backendType
        default:
            id
        }
    }
    func defaultEndpoint(for apiFormat: APIFormat = .responses) -> String {
        switch self {
        case .responsesAPI: "https://api.openai.com/v1"
        case .anthropicAPI: "https://api.anthropic.com/v1"
        case .localOpenAI: "http://127.0.0.1:11434/v1"
        case .grokAPI: "https://api.x.ai/v1"
        case .openRouter: "https://openrouter.ai/api/v1"
        case .deepSeek: "https://api.deepseek.com"
        case .openCodeConsole:
            switch apiFormat {
            case .anthropic: "https://opencode.ai/inference/anthropic/v1"
            case .responses, .chatCompletions: "https://opencode.ai/inference/openai/v1"
            }
        case .openCodeGo:
            switch apiFormat {
            case .anthropic: "https://opencode.ai/inference/go/anthropic/v1"
            case .responses, .chatCompletions: "https://opencode.ai/inference/go/openai/v1"
            }
        default: ""
        }
    }
    var defaultEndpoint: String { defaultEndpoint() }
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
