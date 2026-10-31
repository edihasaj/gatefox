import SwiftUI

struct GatewayActivityView: View {
    @ObservedObject var gateway: GatewayModel
    @StateObject private var activity = GatewayActivityModel()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let report = activity.report
            let expired = report?.checkedDate.map { context.date.timeIntervalSince($0) > 30 } ?? true
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("EXECUTION ACTIVITY")
                                .font(GatewayTheme.body(11, weight: .semibold))
                                .tracking(1.5)
                                .foregroundStyle(GatewayTheme.moss)
                            Text("Know where work stands.")
                                .font(GatewayTheme.display(36))
                            Text(report.map { "This Mac · \($0.hostname)" } ?? "This Mac only")
                                .font(GatewayTheme.body(14))
                        }
                        Spacer()
                        Button("Refresh") { Task { await activity.refresh(gateway.configPath) } }
                            .buttonStyle(GatewaySecondaryButtonStyle())
                            .disabled(activity.isBusy || !gateway.hasConfig)
                            .accessibilityIdentifier("activity.refresh")
                    }
                    Text("Read-only snapshots of this execution host. A completed turn is not proof the whole task is done. Other Macs and Codex’s unread dots are not changed here.")
                        .font(GatewayTheme.body(13))
                        .foregroundStyle(GatewayTheme.charcoal.opacity(0.65))
                    if let report {
                        GatewayPanel {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(expired ? "Snapshot expired — refresh to verify" : coverageLabel(report.coverage))
                                    .font(GatewayTheme.body(15, weight: .semibold))
                                    .foregroundStyle(expired || report.coverage != "available" ? GatewayTheme.vermilion : GatewayTheme.moss)
                                if let date = report.checkedDate {
                                    Text("Checked \(date.formatted(date: .abbreviated, time: .standard))")
                                        .font(GatewayTheme.body(12))
                                }
                                if report.rows.isEmpty {
                                    Text(report.coverage == "available" ? "No activity in this bounded snapshot." : "No verified live activity is available. This does not prove the host is idle.")
                                        .font(GatewayTheme.body(14))
                                }
                                ForEach(report.rows) { row in
                                    Divider()
                                    activityRow(row, expired: expired)
                                }
                                if report.hasMore {
                                    Text("More history exists than this snapshot can display.")
                                        .font(GatewayTheme.body(12))
                                }
                            }
                        }
                    } else {
                        Text(activity.message ?? (activity.isBusy ? "Checking existing executors…" : "Choose a gateway configuration to inspect its execution host."))
                            .font(GatewayTheme.body(14))
                    }
                }
                .foregroundStyle(GatewayTheme.charcoal)
                .padding(42)
                .frame(maxWidth: 1000, alignment: .leading)
            }
        }
        .accessibilityLabel("Gateway execution activity")
        .task(id: gateway.configPath) {
            activity.select(gateway.configPath)
            while !Task.isCancelled {
                await activity.refresh(gateway.configPath)
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
            }
        }
    }

    private func coverageLabel(_ coverage: String) -> String {
        switch coverage {
        case "available": "Current bounded snapshot"
        case "partial": "Partial snapshot — some live state could not be verified"
        default: "Live executor unavailable — recorded outcomes only"
        }
    }

    private func activityRow(_ row: GatewayActivityRow, expired: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.name ?? "Thread \(row.threadId.prefix(8))…\(row.threadId.suffix(6))")
                    .font(GatewayTheme.body(15, weight: .semibold))
                    .textSelection(.enabled)
                Spacer()
                Text(expired ? "Unverified" : row.waitingFor.map { "Waiting for \($0)" } ?? row.state.capitalized)
                    .font(GatewayTheme.body(13, weight: .semibold))
                    .foregroundStyle(row.state == "failed" && !expired ? GatewayTheme.vermilion : GatewayTheme.charcoal)
            }
            if let turn = row.turn {
                Text("\(row.source == "recorded" ? "Recorded outcome" : "Latest sampled turn"): \(turn.status)\(turn.errorClass.map { " · \($0)" } ?? "")")
                    .font(GatewayTheme.body(13))
                if let at = turn.completedAt, let date = GatewayActivityReport.date(at) {
                    Text("Turn ended \(date.formatted(date: .abbreviated, time: .standard))")
                        .font(GatewayTheme.body(12))
                }
            }
            if row.source == "recorded", let date = GatewayActivityReport.date(row.observedAt) {
                Text("Recorded \(date.formatted(date: .abbreviated, time: .standard)); current execution is unverified.")
                    .font(GatewayTheme.body(12))
            }
            Text([row.isSubagent == true ? "Subagent" : "Chat", row.requestedModel.map { "\($0) → \(row.model ?? "pending")" } ?? row.model, row.threadId].compactMap { $0 }.joined(separator: " · "))
                .font(GatewayTheme.body(11))
                .foregroundStyle(GatewayTheme.charcoal.opacity(0.55))
                .textSelection(.enabled)
        }
        .padding(.vertical, 5)
    }
}
