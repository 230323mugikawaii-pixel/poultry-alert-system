import Foundation

/// Persists a per-install UUID used as the `installationId` on every
/// push-device registration call. Generated once and reused so re-
/// registering (e.g. a token rotation) upserts the same registry row
/// instead of creating a duplicate — see device-push-registry.ts `register`,
/// which upserts on (teamId, principalKind, principalId, platform,
/// installationId).
enum InstallationIdentifierStore {
    private static let key = "com.callnow.app.installationId"

    static func currentOrCreate(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        defaults.set(created, forKey: key)
        return created
    }
}
