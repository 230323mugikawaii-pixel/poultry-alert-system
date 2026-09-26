import XCTest
@testable import CallNow

final class InstallationIdentifierStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let suiteName = "InstallationIdentifierStoreTests.\(UUID().uuidString)"
        return UserDefaults(suiteName: suiteName)!
    }

    func testCreatesAndPersistsSameIdentifierAcrossCalls() {
        let defaults = freshDefaults()
        let first = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
        let second = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
        XCTAssertEqual(first, second)
    }

    func testCreatedIdentifierMatchesServerUUIDPattern() {
        // Mirrors device-push-registry.ts's uuid pattern
        // (version 1-8, variant 8/9/a/b).
        let defaults = freshDefaults()
        let value = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
        let pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        let regex = try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
        let range = NSRange(value.startIndex..., in: value)
        XCTAssertNotNil(regex.firstMatch(in: value, range: range))
    }

    func testDifferentDefaultsSuitesProduceIndependentIdentifiers() {
        let first = InstallationIdentifierStore.currentOrCreate(defaults: freshDefaults())
        let second = InstallationIdentifierStore.currentOrCreate(defaults: freshDefaults())
        XCTAssertNotEqual(first, second)
    }
}
