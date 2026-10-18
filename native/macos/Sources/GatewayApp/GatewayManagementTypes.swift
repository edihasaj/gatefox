import Foundation

struct ProviderInput: Codable, Sendable, Equatable {
    var id: String?
    var label: String
    var type: String
    var baseUrl: String?
    var apiKey: String?
    var useExistingLogin: Bool?
    var accountEmail: String?

    init(
        id: String? = nil,
        label: String,
        type: String,
        baseUrl: String? = nil,
        apiKey: String? = nil,
        useExistingLogin: Bool? = nil,
        accountEmail: String? = nil
    ) {
        self.id = id
        self.label = label
        self.type = type
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.useExistingLogin = useExistingLogin
        self.accountEmail = accountEmail
    }
}

struct ManagedModel: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let alias: String?
    let label: String
    let enabled: Bool

    init(id: String, alias: String? = nil, label: String, enabled: Bool) {
        self.id = id
        self.alias = alias
        self.label = label
        self.enabled = enabled
    }
}

struct ManagedProvider: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let label: String
    let type: String
    let baseUrl: String?
    let authState: String
    let authDetail: String
    let models: [ManagedModel]
    let canDiscover: Bool
    let canReconnect: Bool

    init(
        id: String,
        label: String,
        type: String,
        baseUrl: String? = nil,
        authState: String,
        authDetail: String,
        models: [ManagedModel],
        canDiscover: Bool,
        canReconnect: Bool
    ) {
        self.id = id
        self.label = label
        self.type = type
        self.baseUrl = baseUrl
        self.authState = authState
        self.authDetail = authDetail
        self.models = models
        self.canDiscover = canDiscover
        self.canReconnect = canReconnect
    }
}

struct ManagementPrerequisite: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let label: String
    let available: Bool
    let downloadURL: String?
}

struct ManagedDraft: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let provider: ManagedProvider
    let revision: String?
    let configPath: String
    let isNewConfiguration: Bool
}

struct ManagementRequest: Codable, Sendable, Equatable {
    let operation: String
    let configPath: String
    let draftId: String?
    let providerId: String?
    let provider: ProviderInput?
    let selectedModels: [String]?
    let manualModels: [String]?
    let revision: String?
    let label: String?

    init(
        operation: String,
        configPath: String,
        draftId: String? = nil,
        providerId: String? = nil,
        provider: ProviderInput? = nil,
        selectedModels: [String]? = nil,
        manualModels: [String]? = nil,
        revision: String? = nil,
        label: String? = nil
    ) {
        self.operation = operation
        self.configPath = configPath
        self.draftId = draftId
        self.providerId = providerId
        self.provider = provider
        self.selectedModels = selectedModels
        self.manualModels = manualModels
        self.revision = revision
        self.label = label
    }
}

struct ManagementResult: Codable, Sendable, Equatable {
    let configPath: String?
    let revision: String?
    let providers: [ManagedProvider]?
    let prerequisites: [ManagementPrerequisite]?
    let draft: ManagedDraft?
    let models: [ManagedModel]?
    let changed: Bool?
    let removed: Bool?
}

struct ManagementError: Codable, Sendable, Equatable {
    let code: String
    let message: String
}

struct ManagementResponse: Codable, Sendable, Equatable {
    let ok: Bool
    let result: ManagementResult?
    let error: ManagementError?

    static func failure(_ code: String, message: String) -> ManagementResponse {
        ManagementResponse(ok: false, result: nil, error: ManagementError(code: code, message: message))
    }
}

protocol GatewayManagementRunning: Sendable {
    func request(_ request: ManagementRequest, timeoutSeconds: Double) async -> ManagementResponse
    func cancel() async
}
