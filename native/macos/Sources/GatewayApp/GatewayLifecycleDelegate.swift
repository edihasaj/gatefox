import AppKit

/// Completes app-owned work before quit. The independently managed gateway
/// service keeps its own lifecycle.
@MainActor
final class GatewayLifecycleDelegate: NSObject, NSApplicationDelegate {
    weak var connections: GatewayConnectionsModel?
    weak var gateway: GatewayModel?
    weak var updates: GatewayUpdatesModel?
    private var terminationPending = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        AppRelocation.relocateIfNeeded(homeDirectory: FileManager.default.homeDirectoryForCurrentUser) { relaunched in
            if relaunched { NSApp.terminate(nil) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let connectionsNeedCleanup = connections.map { $0.isBusy || $0.draft != nil } ?? false
        let updatesNeedCleanup = updates?.hasPendingWork == true
        guard connectionsNeedCleanup || gateway?.hasPendingWork == true || updatesNeedCleanup else {
            return .terminateNow
        }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        let connections = connections
        let gateway = gateway
        let updates = updates
        Task {
            await Self.completeTerminationCleanup(
                connections: connections,
                gateway: gateway,
                updates: updates
            )
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func completeTerminationCleanup() async {
        await Self.completeTerminationCleanup(connections: connections, gateway: gateway, updates: updates)
    }

    private static func completeTerminationCleanup(
        connections: GatewayConnectionsModel?,
        gateway: GatewayModel?,
        updates: GatewayUpdatesModel?
    ) async {
        async let connectionsCleanup = connections?.endWizardSession()
        async let gatewayCleanup = gateway?.waitForPendingWork()
        async let updatesCleanup = updates?.cancelAndWait()
        _ = await (connectionsCleanup, gatewayCleanup, updatesCleanup)
    }
}
