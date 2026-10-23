import Foundation

/// Identifies the machine whose chats these connection and model settings
/// govern. The name is always this Mac's own local name; remote SSH hosts are
/// never guessed from loopback endpoints or project paths.
enum GatewayConnectionScope {
    static func localHostName(processInfo: ProcessInfo = .processInfo) -> String {
        if let friendly = Host.current().localizedName?
            .trimmingCharacters(in: .whitespacesAndNewlines), !friendly.isEmpty {
            return friendly
        }
        let raw = processInfo.hostName
        let shortened = raw.replacingOccurrences(of: ".local", with: "", options: [.anchored, .backwards])
        return shortened.isEmpty ? "This Mac" : shortened
    }
}

extension String {
    var isSubscriptionProviderType: Bool {
        ["claude-subscription", "codex-subscription", "copilot-subscription", "grok-subscription"].contains(self)
    }

    var isAPIProviderType: Bool {
        ["responses-api", "anthropic-api", "chat-completions-api"].contains(self)
    }
}
