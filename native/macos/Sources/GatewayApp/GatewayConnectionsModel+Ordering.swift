import Foundation

extension GatewayConnectionsModel {
    /// Moves one connection to `index` and saves the whole order. Nothing is reordered locally; the list changes
    /// only from the saved response, so a refused or stale save leaves the displayed order intact.
    @discardableResult
    func move(providerID: String, to index: Int) async -> Bool {
        guard !isBusy, !gateway.clientOnly else { return fail("invalid_request") }
        var order = connections.map(\.id)
        guard let from = order.firstIndex(of: providerID), order.indices.contains(index) else { return fail("invalid_request") }
        guard from != index else { return true }
        order.insert(order.remove(at: from), at: index)
        return await reorder(providerIDs: order)
    }

    func reorder(providerIDs: [String]) async -> Bool {
        guard !isBusy, !gateway.clientOnly, revision != nil,
              Set(providerIDs) == Set(connections.map(\.id)), providerIDs.count == connections.count else { return fail("invalid_request") }
        return await saveReviewed({ path, revision in
            ManagementRequest(operation: "reorder", configPath: path, revision: revision, providerIds: providerIDs)
        }, accepts: { _, providers in providers.map(\.id) == providerIDs })
    }
}
