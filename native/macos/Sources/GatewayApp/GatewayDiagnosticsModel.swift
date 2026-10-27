import Combine
import Foundation

struct GatewayDiagnosticsReport: Codable, Sendable, Equatable {
    let version: Int
    let hostname: String
    let checkedAt: String
    let since: String
    let hours: Int
    let models: [GatewayCacheDiagnostic]
    let sessions: [GatewaySessionDiagnostic]
    let issues: [GatewayDiagnosticIssue]
    let hasMoreModels: Bool
    let hasMoreIssues: Bool
    var checkedDate: Date? { GatewayActivityReport.date(checkedAt) }
}

struct GatewayCacheDiagnostic: Codable, Identifiable, Sendable, Equatable {
    let model: String
    let requests: Int
    let failed: Int
    let usageSamples: Int
    let cacheSamples: Int
    let cacheWriteSamples: Int
    let inputTokens: Double
    let cachedTokens: Double
    let cacheInputTokens: Double
    let cacheWriteTokens: Double
    let outputTokens: Double
    let cacheHitPercent: Double?
    var id: String { model }
    var hitLabel: String {
        if let value = cacheHitPercent { return "\(value.formatted(.number.precision(.fractionLength(0...1))))%" }
        return cacheSamples > 0 && cacheInputTokens == 0 ? "No input" : "Not reported"
    }
    var isValid: Bool {
        !model.isEmpty && requests >= 0 && failed >= 0 && failed <= requests
            && usageSamples >= 0 && usageSamples <= requests && cacheSamples >= 0 && cacheSamples <= usageSamples
            && cacheWriteSamples >= 0 && cacheWriteSamples <= requests
            && [inputTokens, cachedTokens, cacheInputTokens, cacheWriteTokens, outputTokens].allSatisfy { $0.isFinite && $0 >= 0 }
            && cachedTokens <= cacheInputTokens && cacheInputTokens <= inputTokens
            && (cacheHitPercent.map { $0.isFinite && $0 >= 0 && $0 <= 100 && cacheSamples > 0 && cacheInputTokens > 0 } ?? true)
    }
}

struct GatewaySessionDiagnostic: Codable, Identifiable, Sendable, Equatable {
    let outcome: String
    let count: Int
    let failed: Int
    let cacheReadTokens: Double
    let cacheWriteTokens: Double
    var id: String { outcome }
}

struct GatewayDiagnosticIssue: Codable, Sendable, Equatable {
    let at: String
    let event: String
    let code: String
    let model: String?
    let provider: String?
    let retrying: Bool
}

@MainActor
final class GatewayDiagnosticsModel: ObservableObject {
    @Published private(set) var report: GatewayDiagnosticsReport?
    @Published private(set) var isBusy = false
    @Published private(set) var message: String?
    private let bridge: any GatewayManagementRunning
    private var selectedPath: String?
    private var selectedHours = 1
    private var generation = 0

    init(bridge: any GatewayManagementRunning = GatewayManagementCommand()) { self.bridge = bridge }

    func select(_ path: String, hours: Int) {
        guard selectedPath != path || selectedHours != hours else { return }
        selectedPath = path
        selectedHours = hours
        generation += 1
        report = nil
        message = nil
    }

    func refresh(_ path: String, hours: Int) async {
        select(path, hours: hours)
        guard !isBusy, !Task.isCancelled else { return }
        let current = generation
        isBusy = true
        defer { isBusy = false }
        let response = await bridge.request(ManagementRequest(operation: "diagnostics", configPath: path, sinceHours: hours), timeoutSeconds: 15)
        guard !Task.isCancelled, current == generation, path == selectedPath, hours == selectedHours else { return }
        guard response.ok, response.result?.configPath == path, let value = response.result?.diagnostics,
              value.version == 1, value.hours == hours, value.checkedDate != nil,
              value.models.count <= 64, value.sessions.count <= 64, value.issues.count <= 50,
              Set(value.models.map(\.model)).count == value.models.count,
              value.models.allSatisfy(\.isValid),
              value.sessions.allSatisfy({ $0.count >= 0 && $0.failed >= 0 && $0.failed <= $0.count }),
              value.issues.allSatisfy({ GatewayActivityReport.date($0.at) != nil }) else {
            report = nil
            message = "Diagnostics are unavailable. Refresh to try again."
            return
        }
        report = value
        message = nil
    }
}
