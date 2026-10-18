import AppKit

/// Completes an explicit save or cancels unfinished account setup before quit.
/// The independently managed gateway service keeps its own lifecycle.
@MainActor
final class GatewayLifecycleDelegate: NSObject, NSApplicationDelegate {
    weak var connections: GatewayConnectionsModel?
    weak var gateway: GatewayModel?
    private var terminationPending = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let connectionsNeedCleanup = connections.map { $0.isBusy || $0.draft != nil } ?? false
        guard connectionsNeedCleanup || gateway?.hasPendingWork == true else {
            return .terminateNow
        }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        Task {
            await connections?.endWizardSession()
            await gateway?.waitForPendingWork()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
