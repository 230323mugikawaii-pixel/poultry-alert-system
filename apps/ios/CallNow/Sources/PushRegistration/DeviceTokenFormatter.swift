import Foundation

/// Converts the raw APNs device token `Data` handed to
/// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` into
/// the lowercase hex string the backend expects.
///
/// Mirrors the server-side contract in
/// apps/api/src/modules/device-push/device-push-registry.ts (`protectToken`):
/// an even-length, lowercase hex string of at most 1024 characters, matching
/// `/^(?:[0-9a-f]{2})+$/iu`. This does not assume a fixed token length — it
/// just re-encodes whatever bytes the system hands back.
enum DeviceTokenFormatter {
    static func hexString(from deviceToken: Data) -> String {
        deviceToken.map { String(format: "%02x", $0) }.joined()
    }
}
