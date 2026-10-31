import Combine
import Foundation

struct GatewayActivityReport: Codable, Sendable, Equatable {
    let version: Int
    let hostname: String
    let checkedAt: String
    let coverage: String
    let hasMore: Bool
    let rows: [GatewayActivityRow]

    var checkedDate: Date? { Self.date(checkedAt) }
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

struct GatewayActivityRow: Codable, Identifiable, Sendable, Equatable {
    let threadId: String
    let name: String?
    let model: String?
    var requestedModel: String? = nil
    var providerId: String? = nil
    let isSubagent: Bool?
    let state: String
    var waitingFor: String? = nil
    let source: String
    let observedAt: String
    let turn: GatewayActivityTurn?
    var id: String { threadId }
}

struct GatewayActivityTurn: Codable, Sendable, Equatable {
    let id: String
    let status: String
    let completedAt: String?
    let errorClass: String?
}

/// A visible-window reader, not a scheduler. Its cancellation closes only its own management process.
@MainActor
final class GatewayActivityModel: ObservableObject {
    @Published private(set) var report: GatewayActivityReport?
    @Published private(set) var isBusy = false
    @Published private(set) var message: String?
    private let bridge: any GatewayManagementRunning
    private var selectedPath: String?
    private var generation = 0

    init(bridge: any GatewayManagementRunning = GatewayManagementCommand()) { self.bridge = bridge }

    func select(_ path: String) {
        guard selectedPath != path else { return }
        selectedPath = path
        generation += 1
        report = nil
        message = nil
    }

    func refresh(_ path: String) async {
        select(path)
        guard !isBusy, !Task.isCancelled else { return }
        let current = generation
        isBusy = true
        defer { isBusy = false }
        let response = await bridge.request(ManagementRequest(operation: "activity", configPath: path), timeoutSeconds: 10)
        guard !Task.isCancelled, current == generation, path == selectedPath else { return }
        guard response.ok, response.result?.configPath == path, let value = response.result?.activity,
              value.version == 1, value.checkedDate != nil,
              ["available", "partial", "unavailable"].contains(value.coverage),
              value.rows.count <= 32,
              Set(value.rows.map(\.threadId)).count == value.rows.count,
              value.rows.allSatisfy({ ["running", "waiting", "completed", "failed", "interrupted", "unknown"].contains($0.state)
                  && ["sdk", "recorded"].contains($0.source)
                  && ($0.state != "waiting" || ["approval", "input"].contains($0.waitingFor ?? ""))
                  && ($0.source != "recorded" || $0.state == "unknown") }) else {
            report = nil
            message = "Activity could not be verified. Unavailable does not mean finished."
            return
        }
        report = value
        message = nil
    }
}
