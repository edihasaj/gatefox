import SwiftUI

struct GatewayDiagnosticsView: View {
    @ObservedObject var gateway: GatewayModel
    @StateObject private var diagnostics = GatewayDiagnosticsModel()
    @State private var hours = 1

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("DIAGNOSTICS")
                            .font(GatewayTheme.body(11, weight: .semibold))
                            .tracking(1.5)
                            .foregroundStyle(GatewayTheme.moss)
                        Text("Cache, retries and failures.")
                            .font(GatewayTheme.display(34))
                        Text(diagnostics.report.map { "This Mac · \($0.hostname)" } ?? "This Mac only")
                            .font(GatewayTheme.body(14))
                    }
                    Spacer()
                    Button("Refresh") { Task { await diagnostics.refresh(gateway.configPath, hours: hours) } }
                        .buttonStyle(GatewaySecondaryButtonStyle())
                        .disabled(diagnostics.isBusy || !gateway.hasConfig)
                        .accessibilityIdentifier("diagnostics.refresh")
                }
                Picker("Time window", selection: $hours) {
                    Text("Last hour").tag(1)
                    Text("6 hours").tag(6)
                    Text("24 hours").tag(24)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 380)
                .accessibilityIdentifier("diagnostics.window")
                Text("Recorded requests and connection events on this Mac. Cache percentages use only requests that reported cache usage.")
                    .font(GatewayTheme.body(13))
                    .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                if let report = diagnostics.report {
                    if let date = report.checkedDate {
                        Text("Checked \(date.formatted(date: .abbreviated, time: .standard))")
                            .font(GatewayTheme.body(12))
                            .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                    }
                    GatewayDiagnosticsContent(report: report)
                } else {
                    Text(diagnostics.message ?? (diagnostics.isBusy ? "Reading diagnostics…" : "Choose a gateway configuration to view diagnostics."))
                        .font(GatewayTheme.body(14))
                }
            }
            .foregroundStyle(GatewayTheme.charcoal)
            .padding(42)
            .frame(maxWidth: 1050, alignment: .leading)
        }
        .accessibilityLabel("Gateway diagnostics")
        .task(id: "\(gateway.configPath)|\(hours)") {
            diagnostics.select(gateway.configPath, hours: hours)
            while !Task.isCancelled {
                if gateway.hasConfig { await diagnostics.refresh(gateway.configPath, hours: hours) }
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
            }
        }
    }
}

struct GatewayDiagnosticsContent: View {
    let report: GatewayDiagnosticsReport

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            GatewayPanel {
                VStack(alignment: .leading, spacing: 18) {
                    title("Cache by model")
                    if report.models.isEmpty {
                        Text("No requests were recorded in this time window.")
                            .font(GatewayTheme.body(14))
                    }
                    ForEach(report.models) { row in
                        if row.id != report.models.first?.id { Divider() }
                        cacheRow(row)
                    }
                    if report.hasMoreModels { note("The model list is truncated. Use gateway diagnostics for the full report.") }
                }
            }
            if !report.sessions.isEmpty {
                GatewayPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        title("Copilot sessions")
                        note("Rebuilding a session can require history to be sent again. The provider’s reported cache use appears above.")
                        ForEach(report.sessions) { row in
                            HStack {
                                Text(sessionLabel(row.outcome))
                                Spacer()
                                Text(row.count.formatted()).monospacedDigit()
                            }
                            .font(GatewayTheme.body(13))
                        }
                    }
                }
            }
            GatewayPanel {
                VStack(alignment: .leading, spacing: 14) {
                    title("Failures and reconnect signals")
                    if report.issues.isEmpty { note("No provider or connection issues were recorded in this time window.") }
                    ForEach(Array(report.issues.enumerated()), id: \.offset) { _, issue in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(issueLabel(issue.code))
                                    .font(GatewayTheme.body(14, weight: .semibold))
                                Spacer()
                                if issue.retrying { Text("Retrying").foregroundStyle(GatewayTheme.vermilion) }
                            }
                            Text([issue.model ?? issue.provider, issue.event, issue.code].compactMap { $0 }.joined(separator: " · "))
                                .font(GatewayTheme.body(11))
                                .foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
                                .textSelection(.enabled)
                            if let date = GatewayActivityReport.date(issue.at) {
                                Text(date.formatted(date: .abbreviated, time: .standard))
                                    .font(GatewayTheme.body(11))
                            }
                        }
                        if issue.at != report.issues.last?.at { Divider() }
                    }
                    if report.hasMoreIssues { note("Showing the latest \(report.issues.count) signals. Earlier events remain in local telemetry.") }
                }
            }
        }
        .font(GatewayTheme.body(13))
    }

    private func title(_ value: String) -> some View {
        Text(value).font(GatewayTheme.display(24)).foregroundStyle(GatewayTheme.charcoal)
    }
    private func note(_ value: String) -> some View {
        Text(value).font(GatewayTheme.body(12)).foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
    }
    private func metric(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(name).font(GatewayTheme.body(11)).foregroundStyle(GatewayTheme.charcoal.opacity(0.6))
            Text(value).font(GatewayTheme.body(17, weight: .semibold)).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func tokens(_ value: Double, reported: Bool) -> String {
        reported ? value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1))) : "Not reported"
    }
    private func cacheRow(_ row: GatewayCacheDiagnostic) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.model).font(GatewayTheme.body(14, weight: .semibold)).textSelection(.enabled)
                Spacer()
                Text("\(row.requests) requests · \(row.failed) failed")
                    .font(GatewayTheme.body(12))
                    .foregroundStyle(row.failed > 0 ? GatewayTheme.vermilion : GatewayTheme.charcoal.opacity(0.6))
            }
            HStack(spacing: 18) {
                metric("Input tokens", tokens(row.inputTokens, reported: row.usageSamples > 0))
                metric("Cache read", tokens(row.cachedTokens, reported: row.cacheSamples > 0))
                metric("Cache written", tokens(row.cacheWriteTokens, reported: row.cacheWriteSamples > 0))
                metric("Cache hit", row.hitLabel)
            }
            note("Cache usage reported by \(row.cacheSamples) of \(row.requests) requests.")
        }
        .padding(.vertical, 4)
    }
    private func sessionLabel(_ outcome: String) -> String {
        let parts = outcome.split(separator: ":", maxSplits: 1).map(String.init)
        let action = ["continued": "Session reused", "spawned": "Session started", "reseeded": "Session rebuilt",
                      "closed": "Session closed", "crashed": "Session failed", "fallback": "One-shot fallback",
                      "interrupted": "Request interrupted", "reaped": "Session expired", "evicted": "Session evicted"][parts[0]] ?? parts[0].capitalized
        guard parts.count == 2 else { return action }
        let reason = ["session_dead": "Previous session ended", "unexpected_tail": "Conversation changed while tools were pending",
                      "prefix_diverged": "Earlier history changed", "fingerprint_changed": "Model, instructions or tools changed",
                      "window_changed": "Context window changed", "capacity": "Live session limit reached"][parts[1]] ?? issueLabel(parts[1])
        return "\(action) · \(reason)"
    }
    private func issueLabel(_ code: String) -> String {
        switch code {
        case "unknown_tool": "Tool was not in the caller’s catalog"
        case "duplicate_tool_id": "Duplicate tool call identifier"
        case "malformed_tool_call": "Malformed tool call"
        case "invalid_tool_arguments": "Invalid tool argument structure"
        case "nontext_custom_input": "Free-form tool input was not text"
        case "tool_request_missing": "Tool request was not handed over"
        case "forced_tool_mismatch": "Model selected a different tool"
        case "required_tool_missing": "Required tool call was missing"
        case "responseStreamDisconnected", "stream_disconnected": "Response stream disconnected"
        case "transport_closed": "Client transport closed"
        case "invalid_tool_call": "Tool call rejected; detailed reason was not recorded"
        default: code.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
