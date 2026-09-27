import Foundation

/// PR06 contract boundary. No native view depends on endpoint or version details.
protocol PushDeviceRegistering {
  func register(principal: Principal, installationId: String, token: String) async throws
    -> PushDeviceRegistrationResponse
  func revoke(principal: Principal, registration: PushDeviceRegistrationResponse) async throws
}
struct PushDeviceRegistry: PushDeviceRegistering {
  let api: any APIRequesting
  func register(principal: Principal, installationId: String, token: String) async throws
    -> PushDeviceRegistrationResponse
  {
    guard let path = principal.devicesPath else { throw APIError.server(status: 403) }
    return try await api.send(
      path, body: PushDeviceRegistrationRequest(installationId: installationId, deviceToken: token))
  }
  func revoke(principal: Principal, registration: PushDeviceRegistrationResponse) async throws {
    guard let path = principal.devicesPath else { throw APIError.server(status: 403) }
    // Read the latest token version: do not revoke another principal or guess a version.
    let target = "\(path)/\(registration.targetKey)"
    let current: PushDeviceRegistrationResponse
    do { current = try await api.get(target) } catch APIError.server(status: 404) { return }
    guard current.status == "ACTIVE" else { return }
    struct Revoke: Encodable { let tokenVersion: Int }
    let _: PushDeviceRegistrationResponse = try await api.send(
      target, method: "DELETE", body: Revoke(tokenVersion: current.tokenVersion))
    // A concurrent rotation returns 409, shown as OFF-not-completed; never forced.
  }
}
