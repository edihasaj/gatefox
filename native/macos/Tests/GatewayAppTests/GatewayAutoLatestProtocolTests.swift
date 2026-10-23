import Foundation
import XCTest
@testable import GatewayApp

@MainActor
final class GatewayAutoLatestProtocolTests: XCTestCase {
    func testValidationBoundsAndSanitizesTheResponse() {
        let tooMany = AutoLatestStatus(enabled: true, intervalMinutes: 5,
            families: (0...AutoLatestLimits.maxGroups).map { AutoLatestFamilyGroup(providerId: "p\($0)", label: "L", families: ["A"]) },
            nativeFamilies: [], scheduled: true, lastCheckedAt: nil, lastOutcome: nil)
        XCTAssertNil(AutoLatestStatus.validated(tooMany))
        let badInterval = AutoLatestStatus(enabled: true, intervalMinutes: 0, families: [], nativeFamilies: [], scheduled: nil, lastCheckedAt: nil, lastOutcome: nil)
        XCTAssertNil(AutoLatestStatus.validated(badInterval))
        let duplicate = AutoLatestStatus(enabled: true, intervalMinutes: 5,
            families: [AutoLatestFamilyGroup(providerId: "a", label: "A", families: ["x"]), AutoLatestFamilyGroup(providerId: "a", label: "B", families: ["y"])],
            nativeFamilies: [], scheduled: nil, lastCheckedAt: nil, lastOutcome: nil)
        XCTAssertNil(AutoLatestStatus.validated(duplicate))

        let messy = AutoLatestStatus(enabled: true, intervalMinutes: 5,
            families: [AutoLatestFamilyGroup(providerId: "a", label: "  Claude\u{0007} ", families: [" Opus ", "", String(repeating: "z", count: 200)])],
            nativeFamilies: ["  ", "Astra"], scheduled: true, lastCheckedAt: .infinity, lastOutcome: "Secret token: abc def")
        let clean = AutoLatestStatus.validated(messy)
        XCTAssertEqual(clean?.families.first?.label, "Claude")
        XCTAssertEqual(clean?.families.first?.families.first, "Opus")
        XCTAssertEqual(clean?.families.first?.families.last?.count, AutoLatestLimits.maxText)
        XCTAssertEqual(clean?.nativeFamilies, ["Astra"])
        XCTAssertNil(clean?.lastCheckedAt)
        XCTAssertNil(clean?.lastOutcome)
    }

    func testEpochSecondsAndMillisecondsBothNormalize() {
        XCTAssertEqual(AutoLatestTime.date(fromEpoch: 1_800_000_000)?.timeIntervalSince1970, 1_800_000_000)
        XCTAssertEqual(AutoLatestTime.date(fromEpoch: 1_800_000_000_000)?.timeIntervalSince1970, 1_800_000_000)
        XCTAssertNil(AutoLatestTime.date(fromEpoch: 0))
        XCTAssertNil(AutoLatestTime.date(fromEpoch: -1))
        XCTAssertNil(AutoLatestTime.date(fromEpoch: .nan))
    }

    func testModelProviderDateIsOptionalAndNeverInvented() throws {
        let json = #"{"id":"m","label":"M","enabled":false,"releasedAt":1800000000000}"#
        let model = try JSONDecoder().decode(ManagedModel.self, from: Data(json.utf8))
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(model.providerDate?.timeIntervalSince1970, 1_800_000_000)
        let bare = try JSONDecoder().decode(ManagedModel.self, from: Data(#"{"id":"m","label":"M","enabled":true}"#.utf8))
        XCTAssertNil(bare.releasedAt)
        XCTAssertNil(bare.providerDate)
    }

    func testAppliedModelSelectionRefreshesTheFollowedFamilies() async throws {
        let fixture = try AutoLatestFixture()
        defer { fixture.remove() }
        let narrowed = AutoLatestStatus(enabled: true, intervalMinutes: 5,
                                        families: [AutoLatestFamilyGroup(providerId: "a", label: "Claude", families: ["Opus"])],
                                        nativeFamilies: [], scheduled: true, lastCheckedAt: nil, lastOutcome: nil)
        let bridge = AutoLatestBridge(responses: [
            fixture.inspected(revision: "r1", status: fixture.status(enabled: true)),
            fixture.inspected(revision: "r2", status: narrowed),
        ])
        let model = GatewayConnectionsModel(gateway: fixture.gateway, bridge: bridge)
        await model.refresh()
        model.beginEditing(fixture.provider("a"))

        let saved = await model.saveModels(providerID: "a")

        XCTAssertTrue(saved)
        XCTAssertEqual(model.autoLatest, narrowed)
        XCTAssertEqual(model.autoLatest?.familyLines, ["Claude · Opus"])
    }

    func testRequestEncodesTheFlagAndResultDecodesTheStatus() throws {
        let request = ManagementRequest(operation: "auto-latest", configPath: "/tmp/g.json", revision: "r1", enabled: true)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(object["operation"] as? String, "auto-latest")
        XCTAssertEqual(object["enabled"] as? Bool, true)
        XCTAssertEqual(object["revision"] as? String, "r1")
        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(ManagementRequest(operation: "inspect", configPath: "/tmp/g.json"))) as? [String: Any])
        XCTAssertNil(plain["enabled"])

        let json = #"""
        {"configPath":"/tmp/g.json","revision":"r","providers":[],"autoLatest":{"enabled":true,"intervalMinutes":5,
        "families":[{"providerId":"codex","label":"Codex Main","families":["Astra","Sol"]}],"nativeFamilies":["Astra"],
        "scheduled":false,"lastCheckedAt":1800000000,"lastOutcome":"updated"}}
        """#
        let result = try JSONDecoder().decode(ManagementResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.autoLatest?.families.first?.label, "Codex Main")
        XCTAssertEqual(result.validAutoLatest?.polling, .notScheduled)
        let old = try JSONDecoder().decode(ManagementResult.self, from: Data(#"{"configPath":"/tmp/g.json","revision":"r","providers":[]}"#.utf8))
        XCTAssertNil(old.autoLatest)
    }
}
