import XCTest
@testable import GatewayApp

final class ProviderChoiceTests: XCTestCase {
    func testNamedAPIPresetsUseExistingBackendTypes() {
        XCTAssertEqual(ProviderChoice.grokAPI.effectiveBackendType(), "responses-api")
        XCTAssertEqual(ProviderChoice.openRouter.effectiveBackendType(), "chat-completions-api")
        XCTAssertEqual(ProviderChoice.openCodeConsole.effectiveBackendType(for: .responses), "responses-api")
        XCTAssertEqual(ProviderChoice.openCodeConsole.effectiveBackendType(for: .chatCompletions), "chat-completions-api")
        XCTAssertEqual(ProviderChoice.openCodeConsole.effectiveBackendType(for: .anthropic), "anthropic-api")
        XCTAssertEqual(ProviderChoice.openCodeGo.effectiveBackendType(for: .responses), "responses-api")
        XCTAssertEqual(ProviderChoice.openCodeGo.effectiveBackendType(for: .chatCompletions), "chat-completions-api")
        XCTAssertEqual(ProviderChoice.openCodeGo.effectiveBackendType(for: .anthropic), "anthropic-api")
    }

    func testNamedAPIPresetEndpointsIncludeProtocolSpecificOpenCodeRoutes() {
        XCTAssertEqual(ProviderChoice.anthropicAPI.defaultEndpoint, "https://api.anthropic.com/v1")
        XCTAssertEqual(ProviderChoice.grokAPI.defaultEndpoint, "https://api.x.ai/v1")
        XCTAssertEqual(ProviderChoice.openRouter.defaultEndpoint, "https://openrouter.ai/api/v1")
        XCTAssertEqual(ProviderChoice.openCodeConsole.defaultEndpoint(for: .responses), "https://opencode.ai/inference/openai/v1")
        XCTAssertEqual(ProviderChoice.openCodeConsole.defaultEndpoint(for: .chatCompletions), "https://opencode.ai/inference/openai/v1")
        XCTAssertEqual(ProviderChoice.openCodeConsole.defaultEndpoint(for: .anthropic), "https://opencode.ai/inference/anthropic/v1")
        XCTAssertEqual(ProviderChoice.openCodeGo.defaultEndpoint(for: .responses), "https://opencode.ai/inference/go/openai/v1")
        XCTAssertEqual(ProviderChoice.openCodeGo.defaultEndpoint(for: .chatCompletions), "https://opencode.ai/inference/go/openai/v1")
        XCTAssertEqual(ProviderChoice.openCodeGo.defaultEndpoint(for: .anthropic), "https://opencode.ai/inference/go/anthropic/v1")
    }

    func testNamedAPIPresetsRequireKeysAndKeepDistinctChoiceIdentity() {
        let choices: [ProviderChoice] = [.grokAPI, .openCodeConsole, .openCodeGo, .openRouter]
        XCTAssertTrue(choices.allSatisfy(\.requiresKey))
        XCTAssertTrue(choices.allSatisfy(\.requiresEndpoint))
        XCTAssertEqual(Set(choices.map(\.id)).count, choices.count)
        XCTAssertNotEqual(ProviderChoice.grokAPI.id, ProviderChoice.grokAPI.effectiveBackendType())
        XCTAssertNotEqual(ProviderChoice.openRouter.id, ProviderChoice.openRouter.effectiveBackendType())
        XCTAssertNotEqual(ProviderChoice.openCodeConsole.id, ProviderChoice.openCodeConsole.effectiveBackendType(for: .responses))
        XCTAssertNotEqual(ProviderChoice.openCodeConsole, ProviderChoice.openCodeGo)
        XCTAssertEqual(
            ProviderChoice.openCodeConsole.effectiveBackendType(for: .responses),
            ProviderChoice.openCodeGo.effectiveBackendType(for: .responses)
        )
        XCTAssertTrue(ProviderChoice.openCodeConsole.supportsManualModels)
        XCTAssertTrue(ProviderChoice.openCodeGo.supportsManualModels)
    }
}
