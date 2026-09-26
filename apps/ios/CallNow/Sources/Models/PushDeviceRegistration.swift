import Foundation

/// Mirrors the request/response contract of
/// POST /api/v1/teams/:teamId/push-devices
/// (apps/api/src/modules/device-push/device-push-routes.ts / device-push-registry.ts).
struct PushDeviceRegistrationRequest: Encodable {
    let installationId: String
    let platform: String
    let deviceToken: String

    init(installationId: String, deviceToken: String) {
        self.installationId = installationId
        self.platform = "APNS"
        self.deviceToken = deviceToken
    }
}

struct PushDeviceRegistrationResponse: Decodable {
    let targetKey: String
    let installationId: String
    let platform: String
    let tokenVersion: Int
    let status: String
}
