import XCTest
@testable import CallNow

final class DeviceTokenFormatterTests: XCTestCase {
    func testEmptyDataProducesEmptyString() {
        XCTAssertEqual(DeviceTokenFormatter.hexString(from: Data()), "")
    }

    func testKnownBytesProduceLowercaseHex() {
        let data = Data([0x00, 0x01, 0x0A, 0xFF])
        XCTAssertEqual(DeviceTokenFormatter.hexString(from: data), "00010aff")
    }

    func testTypical32ByteTokenProducesLowercase64CharHex() {
        let data = Data(repeating: 0xAB, count: 32)
        let hex = DeviceTokenFormatter.hexString(from: data)
        XCTAssertEqual(hex.count, 64)
        XCTAssertTrue(hex.allSatisfy { $0.isHexDigit && !$0.isUppercase })
    }

    func testOutputMatchesServerSideHexPattern() {
        // Mirrors apps/api/src/modules/device-push/device-push-registry.ts
        // protectToken(): /^(?:[0-9a-f]{2})+$/iu, length <= 1024.
        let data = Data((0..<40).map { UInt8($0) })
        let hex = DeviceTokenFormatter.hexString(from: data)
        let pattern = try! NSRegularExpression(pattern: "^(?:[0-9a-f]{2})+$")
        let range = NSRange(hex.startIndex..., in: hex)
        XCTAssertNotNil(pattern.firstMatch(in: hex, range: range))
        XCTAssertLessThanOrEqual(hex.count, 1024)
    }
}
