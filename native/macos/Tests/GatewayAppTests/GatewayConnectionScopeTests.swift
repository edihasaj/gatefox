import Foundation
import XCTest
@testable import GatewayApp

final class GatewayConnectionScopeTests: XCTestCase {
    func testLocalHostNameIsNeverEmptyOrLoopback() {
        let name = GatewayConnectionScope.localHostName()
        XCTAssertFalse(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        XCTAssertFalse(["127.0.0.1", "localhost", "::1"].contains(name.lowercased()))
    }

    func testSubscriptionAndAPIPredicates() {
        XCTAssertTrue("grok-subscription".isSubscriptionProviderType)
        XCTAssertFalse("grok-subscription".isAPIProviderType)
        XCTAssertFalse("responses-api".isSubscriptionProviderType)
        XCTAssertTrue("responses-api".isAPIProviderType)
    }

    func testManagementResultDecodesWithoutSharedGatewayForOlderBackends() throws {
        let json = #"{"ok":true,"result":{"configPath":"/tmp/gateway.json","providers":[]}}"#
        let response = try JSONDecoder().decode(ManagementResponse.self, from: Data(json.utf8))
        XCTAssertTrue(response.ok)
        XCTAssertNil(try XCTUnwrap(response.result).sharedGateway)
    }

    func testSharedGatewayDecodesWithOptionalHostnameAndProviders() throws {
        let json = """
        {"ok":true,"result":{"sharedGateway":{"status":"available","hostname":"Edi Studio",\
        "providers":[{"id":"grok","label":"Grok","type":"grok-subscription",\
        "models":[{"id":"grok/grok-4","label":"Grok 4"}]}]}}}
        """
        let snapshot = try XCTUnwrap(XCTUnwrap(JSONDecoder().decode(ManagementResponse.self, from: Data(json.utf8)).result).sharedGateway)
        XCTAssertTrue(snapshot.isAvailable)
        XCTAssertEqual(snapshot.hostname, "Edi Studio")
        let provider = try XCTUnwrap(snapshot.providers?.first)
        XCTAssertEqual(provider.id, "grok")
        XCTAssertEqual(provider.models, [SharedGatewayModel(id: "grok/grok-4", label: "Grok 4")])
    }

    func testUnavailableSharedGatewayKeepsOptionalFieldsAbsent() throws {
        let json = #"{"ok":true,"result":{"sharedGateway":{"status":"unavailable"}}}"#
        let snapshot = try XCTUnwrap(XCTUnwrap(JSONDecoder().decode(ManagementResponse.self, from: Data(json.utf8)).result).sharedGateway)
        XCTAssertFalse(snapshot.isAvailable)
        XCTAssertNil(snapshot.hostname)
        XCTAssertNil(snapshot.providers)
    }
}
