import Foundation

/// Bounds for the automatic latest models response. A response outside them is treated as unavailable.
enum AutoLatestLimits {
    static let maxGroups = 32
    static let maxFamiliesPerGroup = 32
    static let maxText = 80
    static let maxIntervalMinutes = 1_440
}

extension AutoLatestStatus {
    /// Returns a display-safe copy, or `nil` when the structure is outside protocol bounds. Strings are trimmed,
    /// stripped of control characters and truncated. An unusable last-check time is dropped, not guessed.
    static func validated(_ raw: AutoLatestStatus) -> AutoLatestStatus? {
        guard (1...AutoLatestLimits.maxIntervalMinutes).contains(raw.intervalMinutes),
              raw.families.count <= AutoLatestLimits.maxGroups,
              raw.nativeFamilies.count <= AutoLatestLimits.maxFamiliesPerGroup,
              Set(raw.families.map(\.providerId)).count == raw.families.count else { return nil }
        var groups: [AutoLatestFamilyGroup] = []
        for group in raw.families {
            guard group.families.count <= AutoLatestLimits.maxFamiliesPerGroup else { return nil }
            let label = displayText(group.label)
            let names = group.families.compactMap(displayText)
            guard !group.providerId.isEmpty, let label, !names.isEmpty else { continue }
            groups.append(AutoLatestFamilyGroup(providerId: group.providerId, label: label, families: names))
        }
        let checked = raw.lastCheckedAt.flatMap { AutoLatestTime.date(fromSeconds: $0) == nil ? nil : $0 }
        return AutoLatestStatus(
            enabled: raw.enabled,
            intervalMinutes: raw.intervalMinutes,
            families: groups,
            nativeFamilies: raw.nativeFamilies.compactMap(displayText),
            scheduled: raw.scheduled,
            scheduleReason: raw.scheduled == false ? outcomeToken(raw.scheduleReason) : nil,
            lastCheckedAt: checked,
            lastOutcome: outcomeToken(raw.lastOutcome)
        )
    }

    private static func displayText(_ value: String) -> String? {
        let cleaned = String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(AutoLatestLimits.maxText))
    }

    /// Only short machine-style codes are kept; free text from the engine is never shown.
    private static func outcomeToken(_ value: String?) -> String? {
        guard let value, (1...40).contains(value.count),
              value.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" })
        else { return nil }
        return value
    }

    var lastChecked: Date? { lastCheckedAt.flatMap { AutoLatestTime.date(fromSeconds: $0) } }

    /// Last check outcome as a readable phrase, e.g. `no_change` → "No change".
    var outcomeText: String? {
        guard let token = lastOutcome else { return nil }
        let words = token.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    enum Polling: Equatable { case running, notScheduled, unknown }

    /// Keeps a scheduler failure the toggle response reported when a later inspect omits scheduling. The failure is
    /// dropped when the feature is off; polling is never assumed from a missing field.
    func carryingScheduleFailure(from previous: AutoLatestStatus?) -> AutoLatestStatus {
        guard enabled, scheduled == nil, let previous, previous.enabled, previous.scheduled == false else { return self }
        return AutoLatestStatus(enabled: enabled, intervalMinutes: intervalMinutes, families: families, nativeFamilies: nativeFamilies,
                                scheduled: false, scheduleReason: previous.scheduleReason, lastCheckedAt: lastCheckedAt, lastOutcome: lastOutcome)
    }

    /// Polling is claimed only when the backend job reported it is scheduled.
    var polling: Polling { scheduled == true ? .running : scheduled == false ? .notScheduled : .unknown }

    /// One line per connection, e.g. "Codex Main · Astra, Sol, Terra".
    var familyLines: [String] { families.map { "\($0.label) · \($0.families.joined(separator: ", "))" } }
    var nativeLine: String? { nativeFamilies.isEmpty ? nil : nativeFamilies.joined(separator: ", ") }
    var hasFamilies: Bool { !families.isEmpty || !nativeFamilies.isEmpty }
}

extension ManagementResult {
    var validAutoLatest: AutoLatestStatus? { autoLatest.flatMap(AutoLatestStatus.validated) }
}

enum AutoLatestTime {
    /// UTC epoch seconds → date. Non-finite, non-positive or absurd values are rejected.
    static func date(fromSeconds value: Double) -> Date? {
        guard value.isFinite, value > 0, value < 32_503_680_000 else { return nil }
        return Date(timeIntervalSince1970: value)
    }

    /// Provider-supplied model date, epoch seconds or milliseconds → date. Non-finite, non-positive or absurd values are rejected.
    static func date(fromEpoch value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        let seconds = value > 100_000_000_000 ? value / 1000 : value
        guard seconds < 32_503_680_000 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }
}

extension ManagedModel {
    /// Explicit release date the provider attached to the model, when available.
    /// Never invented; shown as "Provider date".
    var providerDate: Date? { releasedAt.flatMap { AutoLatestTime.date(fromEpoch: $0) } }
}

extension GatewayConnectionsModel {
    /// Editable once a valid reviewed snapshot reported the state and nothing else is in flight.
    var canEditAutoLatest: Bool { !isBusy && revision != nil && autoLatest != nil }
    /// A manual check only makes sense while the feature is on.
    var canCheckAutoLatest: Bool { canEditAutoLatest && autoLatest?.enabled == true }

    /// Turns automatic latest models on or off with the reviewed revision. The state changes only from the saved
    /// response. Allowed for shared-gateway consumers: the engine then covers this Mac's native families only and the
    /// shared catalog is kept. Turning off never re-enables or enables any model.
    @discardableResult
    func setAutoLatest(_ enabled: Bool) async -> Bool {
        guard !isBusy, revision != nil, let current = autoLatest else { return fail("invalid_request") }
        guard current.enabled != enabled else { return true }
        return await saveReviewed({ path, revision in
            ManagementRequest(operation: "auto-latest", configPath: path, revision: revision, enabled: enabled)
        }, keepSharedCatalog: gateway.clientOnly, accepts: { result, _ in result.validAutoLatest?.enabled == enabled })
    }

    /// Runs one metadata-only catalog check (no inference). The response must report a usable last-check time.
    @discardableResult
    func checkAutoLatestNow() async -> Bool {
        guard !isBusy, revision != nil, autoLatest?.enabled == true else { return fail("invalid_request") }
        return await saveReviewed({ path, revision in
            ManagementRequest(operation: "auto-latest-check", configPath: path, revision: revision)
        }, keepSharedCatalog: gateway.clientOnly, accepts: { result, _ in result.validAutoLatest?.lastChecked != nil })
    }
}
