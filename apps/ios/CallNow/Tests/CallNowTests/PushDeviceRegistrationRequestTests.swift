import XCTest
@testable import CallNow

final class PushDeviceRegistrationRequestTests: XCTestCase {
    func testEncodesExpectedKeysAndLiteralPlatform() throws {
        let request = PushDeviceRegistrationRequest(
            installationId: "11111111-1111-4111-8111-111111111111",
            deviceToken: "00010aff"
        )
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])

        // Matches device-push-routes.ts's body schema:
        // { installationId, platform: Literal("APNS"), deviceToken },
        // additionalProperties: false.
        XCTAssertEqual(json["installationId"], "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(json["platform"], "APNS")
        XCTAssertEqual(json["deviceToken"], "00010aff")
        XCTAssertEqual(json.keys.count, 3)
    }

    func testPlatformIsAlwaysAPNSRegardlessOfInput() throws {
        let request = PushDeviceRegistrationRequest(installationId: UUID().uuidString, deviceToken: "ab")
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json["platform"], "APNS")
    }
}
