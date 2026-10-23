import Foundation

/// Where this Mac's native GPT models appear in the model picker. Presentation only: native chats keep working.
enum NativeModelPickerPlacement: String, CaseIterable, Identifiable, Sendable {
    case first
    case last
    case hidden

    var id: String { rawValue }
    var title: String {
        switch self {
        case .first: "First"
        case .last: "Last"
        case .hidden: "Hidden"
        }
    }
}

extension GatewayConnectionsModel {
    /// The setting is editable once a reviewed snapshot reported it and nothing else is in flight.
    var canEditNativePlacement: Bool { !isBusy && revision != nil && nativePlacement != nil }

    /// Saves this Mac's native picker placement. Allowed for shared-gateway consumers too: it edits only local
    /// presentation, never remote providers. The displayed value changes only from the saved response.
    @discardableResult
    func setNativePlacement(_ placement: NativeModelPickerPlacement) async -> Bool {
        guard !isBusy, revision != nil, let current = nativePlacement else { return fail("invalid_request") }
        guard current != placement else { return true }
        return await saveReviewed({ path, revision in
            ManagementRequest(operation: "native-picker", configPath: path, revision: revision,
                              nativeModelPickerPlacement: placement.rawValue)
        }, keepSharedCatalog: true, accepts: { result, _ in result.nativeModelPickerPlacement == placement.rawValue })
    }
}
