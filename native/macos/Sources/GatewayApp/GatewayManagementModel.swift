import Combine
import Foundation

@MainActor
final class GatewayConnectionsModel: ObservableObject {
    @Published private(set) var connections: [ManagedProvider] = []
    @Published private(set) var prerequisites: [ManagementPrerequisite] = []
    /// Catalog from the remote gateway for client-only configurations. It is
    /// replaced by every valid inspection of the active configuration and
    /// cleared whenever that configuration changes or stops answering.
    @Published private(set) var sharedGateway: SharedGatewaySnapshot?
    @Published private(set) var draft: ManagedDraft?
    @Published private(set) var availableModels: [ManagedModel] = []
    @Published private(set) var isBusy = false
    @Published private(set) var isSaving = false
    @Published private(set) var message: String?
    @Published private(set) var revision: String?
    /// Where this Mac's native GPT models sit in the model picker, from the last reviewed snapshot.
    /// `nil` until an inspection reports it; it changes only from a saved response.
    @Published private(set) var nativePlacement: NativeModelPickerPlacement?
    /// Automatic latest models state from the last reviewed snapshot. `nil` (unavailable) until a valid response
    /// reports it; never inherited from another configuration and changed only from a saved response.
    @Published private(set) var autoLatest: AutoLatestStatus?
    @Published private(set) var modelEditingProviderID: String?
    @Published var selectedModels: Set<String> = []
    @Published var manualModelsText = ""

    let gateway: GatewayModel
    private let bridge: any GatewayManagementRunning
    private var operationID: UUID?
    private var operationGeneration = 0
    private var configurationGeneration = 0
    private var editingConfigPath: String?
    private var cancellationInProgress = false
    private var refreshQueued = false

    init(gateway: GatewayModel, bridge: any GatewayManagementRunning = GatewayManagementCommand()) {
        self.gateway = gateway
        self.bridge = bridge
    }

    var needsFirstSetup: Bool { !gateway.hasConfig }
    var existingConfiguration: Bool { gateway.hasConfig }
    var validManualModelIDs: [String] {
        guard editingProviderSupportsManualModels else { return [] }
        return Array(Set(manualModelsText.split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty })).sorted()
    }
    var effectiveSelection: [String] { Array(selectedModels.union(validManualModelIDs)).sorted() }

    func refresh() async {
        guard !isBusy else { return }
        let path = gateway.configPath
        let outcome = await performOutcome(ManagementRequest(operation: "inspect", configPath: path), path: path)
        guard let result = outcome.result,
              let providers = result.providers,
              let prerequisites = result.prerequisites,
              result.configPath == path else {
            // A completion that is cancelled, superseded, or scoped to a
            // previous configuration must not clear a newer snapshot nor
            // overwrite the active operation's message. Path equality alone
            // is insufficient after an A→B→A switch or a cancel-and-retry.
            if outcome.isCurrent, path == gateway.configPath {
                sharedGateway = nil
                reportInvalidResponseIfNeeded()
            }
            return
        }
        applyInspection(result, providers: providers, prerequisites: prerequisites)
    }

    /// Invalidates every configuration-scoped value before the active bridge
    /// request is cleaned up, then inspects the newest chosen configuration.
    func configurationDidChange() async {
        configurationGeneration &+= 1
        clearConfigurationState()
        refreshQueued = true
        await cancelActiveOperation(messageOnCancel: false)
        await refreshQueuedConfigurationIfPossible()
    }

    @discardableResult
    func prepare(_ input: ProviderInput) async -> Bool {
        guard !isBusy else { return false }
        if draft != nil {
            guard await discardDraft() else { return false }
        }
        let path = gateway.configPath
        guard let result = await perform(
            ManagementRequest(operation: "prepare", configPath: path, provider: input),
            path: path
        ), let newDraft = result.draft,
          newDraft.configPath == path,
          newDraft.provider.type == input.type,
          let prerequisites = result.prerequisites else {
            reportInvalidResponseIfNeeded()
            return false
        }
        draft = newDraft
        self.prerequisites = prerequisites
        clearModelEditing()
        return true
    }

    @discardableResult
    func authenticate(providerID: String? = nil) async -> Bool {
        let path = gateway.configPath
        guard !isBusy else { return false }
        guard draft != nil || providerID != nil else { return fail("draft_invalid") }
        let currentDraftID = draft?.id
        let request = ManagementRequest(
            operation: "authenticate",
            configPath: path,
            draftId: providerID == nil ? currentDraftID : nil,
            providerId: providerID
        )
        guard let result = await perform(request, path: path, timeout: 900) else { return false }
        if let providerID {
            guard let providers = result.providers,
                  result.configPath == path,
                  providers.contains(where: { $0.id == providerID }) else {
                reportInvalidResponseIfNeeded()
                return false
            }
            applyInspection(result, providers: providers, prerequisites: result.prerequisites)
            return true
        }
        guard let updatedDraft = result.draft,
              updatedDraft.id == currentDraftID,
              updatedDraft.configPath == path else {
            reportInvalidResponseIfNeeded()
            return false
        }
        draft = updatedDraft
        return true
    }

    @discardableResult
    func replaceCredentials(providerID: String, apiKey: String) async -> Bool {
        guard !isBusy,
              let provider = connections.first(where: { $0.id == providerID }),
              let revision else { return fail("invalid_request") }
        let path = gateway.configPath
        let input = ProviderInput(label: provider.label, type: provider.type, apiKey: apiKey)
        let request = ManagementRequest(
            operation: "authenticate",
            configPath: path,
            providerId: providerID,
            provider: input,
            revision: revision
        )
        guard let result = await perform(request, path: path),
              let providers = result.providers,
              result.configPath == path else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        return true
    }

    func beginEditing(_ provider: ManagedProvider) {
        let path = gateway.configPath
        modelEditingProviderID = provider.id
        editingConfigPath = path
        availableModels = provider.models
        selectedModels = Set(provider.models.filter(\.enabled).map(\.id))
        manualModelsText = ""
    }

    @discardableResult
    func discover(providerID: String? = nil) async -> Bool {
        let path = gateway.configPath
        let isDraft = providerID == nil
        guard !isBusy else { return false }
        guard draft != nil || providerID != nil else { return fail("draft_invalid") }
        if let providerID {
            guard let provider = connections.first(where: { $0.id == providerID }) else { return fail("invalid_provider") }
            if modelEditingProviderID != providerID || editingConfigPath != path { beginEditing(provider) }
        }
        let request = ManagementRequest(
            operation: "discover",
            configPath: path,
            draftId: isDraft ? draft?.id : nil,
            providerId: providerID,
            manualModels: validManualModelIDs
        )
        guard let result = await perform(request, path: path), let models = result.models else { return false }
        if isDraft {
            guard let updatedDraft = result.draft,
                  updatedDraft.id == draft?.id,
                  updatedDraft.configPath == path else {
                reportInvalidResponseIfNeeded()
                return false
            }
            draft = updatedDraft
        } else {
            guard let providers = result.providers,
                  result.configPath == path,
                  modelEditingProviderID == providerID,
                  editingConfigPath == path else {
                reportInvalidResponseIfNeeded()
                return false
            }
            applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        }
        availableModels = models
        selectedModels = Set(models.filter { isDraft || $0.enabled }.map(\.id))
        return true
    }

    func commitDraft() async -> Bool {
        guard !isBusy, let draft else { return false }
        guard !effectiveSelection.isEmpty else { return fail("invalid_models") }
        let path = gateway.configPath
        let wasFirstSetup = needsFirstSetup
        isSaving = true
        defer { finishWorkflow() }
        let request = ManagementRequest(
            operation: "commit",
            configPath: path,
            draftId: draft.id,
            selectedModels: effectiveSelection,
            manualModels: validManualModelIDs,
            revision: draft.revision
        )
        guard let result = await perform(request, path: path, holdBusy: true),
              let savedPath = result.configPath,
              savedPath == path,
              let revision = result.revision,
              let providers = result.providers else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        self.revision = revision
        self.draft = nil
        clearModelEditing()
        await gateway.useConfig(savedPath)
        guard gateway.configPath == path else { return false }
        if wasFirstSetup { await gateway.setup() }
        await gateway.refresh()
        return true
    }

    func saveModels(providerID: String) async -> Bool {
        guard !isBusy,
              let revision,
              modelEditingProviderID == providerID,
              editingConfigPath == gateway.configPath,
              !effectiveSelection.isEmpty else { return fail("invalid_models") }
        let path = gateway.configPath
        isSaving = true
        defer { finishWorkflow() }
        let request = ManagementRequest(
            operation: "models",
            configPath: path,
            providerId: providerID,
            selectedModels: effectiveSelection,
            manualModels: validManualModelIDs,
            revision: revision
        )
        guard let result = await perform(request, path: path, holdBusy: true),
              result.configPath == path,
              let providers = result.providers,
              result.revision != nil else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        if let provider = providers.first(where: { $0.id == providerID }) {
            availableModels = provider.models
            selectedModels = Set(provider.models.filter(\.enabled).map(\.id))
        }
        await gateway.refresh()
        return true
    }

    func rename(providerID: String, label: String) async -> Bool {
        guard !isBusy, let revision else { return fail("invalid_request") }
        let path = gateway.configPath
        guard let result = await perform(
            ManagementRequest(operation: "rename", configPath: path, providerId: providerID, revision: revision, label: label),
            path: path
        ), result.configPath == path, let providers = result.providers, result.revision != nil else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        await gateway.refresh()
        return true
    }

    func remove(providerID: String) async -> Bool {
        guard !isBusy, let revision else { return fail("invalid_request") }
        let path = gateway.configPath
        guard let result = await perform(
            ManagementRequest(operation: "remove", configPath: path, providerId: providerID, revision: revision),
            path: path
        ), result.configPath == path, let providers = result.providers, result.revision != nil else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites)
        clearModelEditing()
        await gateway.refresh()
        return true
    }

    @discardableResult
    func discardDraft() async -> Bool {
        guard let draft else { return true }
        let path = gateway.configPath
        clearDraftState()
        let result = await perform(
            ManagementRequest(operation: "discard", configPath: path, draftId: draft.id),
            path: path
        )
        return result != nil
    }

    func endWizardSession() async {
        while isSaving {
            do { try await Task.sleep(for: .milliseconds(25)) }
            catch { return }
        }
        await cancelActiveOperation(messageOnCancel: false)
        guard draft != nil else { return }
        _ = await discardDraft()
    }

    func cancel() {
        guard operationID != nil, !cancellationInProgress else { return }
        cancellationInProgress = true
        Task { await finishCancellation(messageOnCancel: true) }
    }

    func clearMessage() { message = nil }

    func useExistingSettings() {
        guard !isBusy else { return }
        gateway.chooseConfig()
    }

    private func perform(
        _ request: ManagementRequest,
        path: String,
        timeout: Double = 30,
        holdBusy: Bool = false
    ) async -> ManagementResult? {
        await performOutcome(request, path: path, timeout: timeout, holdBusy: holdBusy).result
    }

    /// `isCurrent` reports whether the completion still describes the active
    /// configuration generation, path, and operation identity. The operation
    /// UUID is a per-request monotonic identity: `operationGeneration` mirrors
    /// the configuration generation only, so a cancel-and-retry on the same
    /// path changes the UUID while the generation stays equal. Callers must not
    /// apply failure side effects (messages, snapshot clearing) for obsolete
    /// work; they return early instead.
    private func performOutcome(
        _ request: ManagementRequest,
        path: String,
        timeout: Double = 30,
        holdBusy: Bool = false
    ) async -> (result: ManagementResult?, isCurrent: Bool) {
        guard !isBusy else { return (nil, false) }
        let id = UUID()
        let generation = configurationGeneration
        operationID = id
        operationGeneration = generation
        isBusy = true
        message = nil
        let response = await bridge.request(request, timeoutSeconds: timeout)
        guard operationID == id,
              operationGeneration == generation,
              !cancellationInProgress else { return (nil, false) }
        operationID = nil
        if !holdBusy { finishBusyState() }
        guard generation == configurationGeneration, path == gateway.configPath else { return (nil, false) }
        guard response.ok, let result = response.result else {
            message = Self.safeMessage(for: response.error?.code ?? "invalid_request")
            return (nil, true)
        }
        return (result, true)
    }

    /// Sends one configuration mutation against the reviewed revision and applies only a saved response that
    /// `accepts`. Used by ordering and the native picker setting. An obsolete completion (configuration switched,
    /// cancelled, or superseded) returns false without touching the new state or message.
    func saveReviewed(
        _ makeRequest: (_ path: String, _ revision: String) -> ManagementRequest,
        keepSharedCatalog: Bool = false,
        accepts: (ManagementResult, [ManagedProvider]) -> Bool
    ) async -> Bool {
        guard !isBusy, let revision else { return fail("invalid_request") }
        let path = gateway.configPath
        let outcome = await performOutcome(makeRequest(path, revision), path: path)
        guard outcome.isCurrent else { return false }
        guard let result = outcome.result, result.configPath == path, let providers = result.providers, result.revision != nil,
              accepts(result, providers) else {
            reportInvalidResponseIfNeeded()
            return false
        }
        applyInspection(result, providers: providers, prerequisites: result.prerequisites, keepSharedGateway: keepSharedCatalog)
        await gateway.refresh()
        return true
    }

    private func cancelActiveOperation(messageOnCancel: Bool) async {
        guard operationID != nil, !cancellationInProgress else { return }
        cancellationInProgress = true
        await finishCancellation(messageOnCancel: messageOnCancel)
    }

    private func finishCancellation(messageOnCancel: Bool) async {
        await bridge.cancel()
        operationID = nil
        cancellationInProgress = false
        if isBusy { finishBusyState() }
        if messageOnCancel { message = Self.safeMessage(for: "cancelled") }
    }

    private func refreshQueuedConfigurationIfPossible() async {
        guard refreshQueued, !isBusy else { return }
        refreshQueued = false
        await refresh()
    }

    private func finishWorkflow() {
        isSaving = false
        if isBusy { finishBusyState() }
    }

    private func finishBusyState() {
        isBusy = false
        if refreshQueued {
            Task { await self.refreshQueuedConfigurationIfPossible() }
        }
    }

    private func applyInspection(
        _ result: ManagementResult,
        providers: [ManagedProvider],
        prerequisites: [ManagementPrerequisite]? = nil,
        keepSharedGateway: Bool = false
    ) {
        connections = providers
        revision = result.revision
        // A local-only save (native picker) carries no remote read; it must not erase a good shared catalog.
        if !keepSharedGateway { sharedGateway = result.sharedGateway }
        nativePlacement = result.nativeModelPickerPlacement.flatMap(NativeModelPickerPlacement.init(rawValue:))
        autoLatest = result.validAutoLatest?.carryingScheduleFailure(from: autoLatest)
        if let prerequisites { self.prerequisites = prerequisites }
    }

    private func clearConfigurationState() {
        connections = []
        prerequisites = []
        sharedGateway = nil
        revision = nil
        nativePlacement = nil
        autoLatest = nil
        clearDraftState()
    }

    private func clearDraftState() {
        draft = nil
        clearModelEditing()
    }

    private func clearModelEditing() {
        availableModels = []
        selectedModels = []
        manualModelsText = ""
        modelEditingProviderID = nil
        editingConfigPath = nil
    }

    private var editingProviderSupportsManualModels: Bool {
        guard let providerID = modelEditingProviderID,
              let provider = connections.first(where: { $0.id == providerID }) else { return draft?.provider.type.isAPIProviderType ?? false }
        return provider.type.isAPIProviderType
    }

    func fail(_ code: String) -> Bool {
        message = Self.safeMessage(for: code)
        return false
    }

    private func reportInvalidResponseIfNeeded() {
        if message == nil { message = Self.safeMessage(for: "invalid_request") }
    }

    private static func safeMessage(for code: String) -> String {
        switch code {
        case "invalid_configuration": return "The gateway settings file is invalid. Choose or repair it, then refresh."
        case "unsafe_path": return "That settings location is not allowed. Choose a different file."
        case "configuration_changed": return "Gateway settings changed. Refresh and try again."
        case "invalid_request": return "The requested connection change could not be validated. Refresh and try again."
        case "key_required": return "Enter an API key to continue."
        case "invalid_url": return "Enter a valid server address."
        case "invalid_provider": return "Check the provider details and try again."
        case "invalid_models": return "Choose at least one valid model before saving."
        case "missing_cli": return "Install the required provider command, then try again."
        case "auth_failed", "authentication_failed": return "Sign-in did not complete. Try again."
        case "discovery_failed": return "Models could not be discovered. Check the connection and try again."
        case "external_credential": return "This connection uses credentials managed outside Harness Gateway."
        case "last_provider": return "Keep at least one connection in this gateway."
        case "draft_invalid": return "This setup session is no longer valid. Start the connection again."
        case "cancelled": return "The connection operation was cancelled."
        case "timed_out": return "The connection operation took too long. Try again."
        default: return "The gateway could not complete that connection change."
        }
    }
}

// Provider-type predicates live in GatewayConnectionScope.swift.
