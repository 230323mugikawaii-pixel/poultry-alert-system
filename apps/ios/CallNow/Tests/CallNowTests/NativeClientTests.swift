import XCTest

@testable import CallNow

private final class MockAPI: APIRequesting {
  var requests: [(String, String, Data?)] = []
  var cleared = 0
  var handler: (String, String, Data?) async throws -> Data = { _, _, _ in
    throw APIError.server(status: 404)
  }
  func perform(_ path: String, method: String, body: Data?) async throws -> Data {
    requests.append((path, method, body))
    return try await handler(path, method, body)
  }
  func clearSession() { cleared += 1 }
}
@MainActor private final class MockBrowser: OAuthBrowsing {
  var count = 0
  var wrongState = false
  func authenticate(url: URL) async throws -> URL {
    count += 1
    let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first {
      $0.name == "state"
    }!.value!
    var reply = URLComponents(string: NativePKCE.redirectURI)!
    reply.queryItems = [
      .init(name: "state", value: wrongState ? "wrong" : state),
      .init(name: "code", value: String(repeating: "a", count: 43)),
    ]
    return reply.url!
  }
  func cancel() {}
}
@MainActor private final class MockDevice: NotificationDeviceControlling {
  var allowed = true
  var registered = 0
  var unregistered = 0
  func requestPermission() async throws -> Bool { allowed }
  func register() { registered += 1 }
  func unregister() { unregistered += 1 }
}
private final class MockRegistry: PushDeviceRegistering {
  var registrations = 0
  var revocations = 0
  var fails = false
  let result = PushDeviceRegistrationResponse(
    targetKey: "00000000-0000-4000-8000-000000000001",
    installationId: "00000000-0000-4000-8000-000000000002", platform: "APNS", tokenVersion: 1,
    status: "ACTIVE")
  func register(principal: Principal, installationId: String, token: String) async throws
    -> PushDeviceRegistrationResponse
  {
    registrations += 1
    if fails { throw APIError.transport }
    return result
  }
  func revoke(principal: Principal, registration: PushDeviceRegistrationResponse) async throws {
    revocations += 1
    if fails { throw APIError.transport }
  }
}
private let owner = Principal(kind: .owner, id: "owner", teamId: "team", displayName: "OWNER")
private let member = Principal(kind: .member, id: "member", teamId: "team", displayName: "MEMBER")
private let historyJSON = Data(
  #"{"alerts":[{"id":"alert","kind":"REAL","status":"ACTIVE","detectedAt":"2026-09-27T00:00:00Z","matchedKeyword":"検証","readAt":null,"source":{"provider":"GOOGLE"},"subject":"ignored","body":"ignored"}]}"#
    .utf8)
private let memberJSON = Data(
  #"{"member":{"id":"member","displayName":"MEMBER","status":"ACTIVE"},"team":{"id":"team"}}"#.utf8)

final class NativePKCETests: XCTestCase {
  func testRFC7636VectorAndNoVerifierInAuthorizationURL() throws {
    let pkce = try NativePKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    let url = try pkce.startURL(
      base: URL(string: "https://api.example.invalid")!, provider: "google")
    XCTAssertFalse(url.absoluteString.contains(pkce.verifier))
    XCTAssertTrue(url.absoluteString.contains("code_challenge_method=S256"))
  }
  func testRandomVerifierAndStateAreIndependent() throws {
    let a = try NativePKCE()
    let b = try NativePKCE()
    XCTAssertEqual(a.verifier.count, 43)
    XCTAssertEqual(a.state.count, 43)
    XCTAssertNotEqual(a.verifier, a.state)
    XCTAssertNotEqual(a.verifier, b.verifier)
  }
  func testCallbackRejectsHostStateDuplicateErrorAndFragment() throws {
    let pkce = try NativePKCE()
    let code = String(repeating: "a", count: 43)
    let good = "com.callnow.poultryalert:/oauth/callback?state=\(pkce.state)&code=\(code)"
    XCTAssertEqual(try pkce.code(from: URL(string: good)!), code)
    for bad in [
      good.replacingOccurrences(of: "com.callnow.poultryalert", with: "com.callnow.app"),
      good.replacingOccurrences(of: ":/", with: "://evil/"),
      good.replacingOccurrences(of: pkce.state, with: "bad"), good + "&state=" + pkce.state,
      good + "&code=" + code, good + "&error=access_denied", good + "#fragment",
    ] {
      XCTAssertThrowsError(try pkce.code(from: URL(string: bad)!))
    }
  }
  func testDisallowsUnsupportedProviderAndRemoteHTTP() throws {
    let pkce = try NativePKCE()
    XCTAssertThrowsError(
      try pkce.startURL(base: URL(string: "https://api.example.invalid")!, provider: "apple"))
    XCTAssertThrowsError(
      try pkce.startURL(base: URL(string: "http://api.example.invalid")!, provider: "google"))
  }
}

@MainActor final class ClientStateTests: XCTestCase {
  func testOwnerCodeExchangeDoesNotPollOrShareBrowserCookies() async {
    let api = MockAPI()
    let browser = MockBrowser()
    api.handler = { path, _, _ in
      if path.hasSuffix("/native/token") {
        return Data(
          #"{"user":{"id":"owner","email":"owner@example.invalid","displayName":"OWNER"}}"#.utf8)
      }
      if path.hasSuffix("/teams/current") {
        return Data(#"{"team":{"id":"team","role":"OWNER"}}"#.utf8)
      }
      throw APIError.server(status: 404)
    }
    let auth = AuthSession(api: api, browser: browser)
    await auth.signIn(provider: "google")
    XCTAssertEqual(auth.principal, owner)
    XCTAssertEqual(browser.count, 1)
    XCTAssertEqual(
      api.requests.map { $0.0 }, ["/api/v1/auth/native/token", "/api/v1/teams/current"])
    XCTAssertEqual(api.requests.first?.1, "POST")
  }
  func testInvalidCallbackNeverExchangesCode() async {
    let api = MockAPI()
    let browser = MockBrowser()
    browser.wrongState = true
    let auth = AuthSession(api: api, browser: browser)
    await auth.signIn(provider: "google")
    XCTAssertNil(auth.principal)
    XCTAssertTrue(api.requests.isEmpty)
    XCTAssertNotNil(auth.message)
  }
  func testOwnerWithoutTeamShowsSetupStateNotMemberFallback() async {
    let api = MockAPI()
    api.handler = { path, _, _ in
      if path.hasSuffix("/native/token") {
        return Data(#"{"user":{"id":"owner","email":"owner@example.invalid"}}"#.utf8)
      }
      throw APIError.server(status: 404)
    }
    let auth = AuthSession(api: api, browser: MockBrowser())
    await auth.signIn(provider: "microsoft")
    XCTAssertEqual(auth.principal?.kind, .owner)
    XCTAssertNil(auth.principal?.teamId)
    XCTAssertNil(auth.principal?.devicesPath)
  }
  func testMemberSeparateLoginAndLogoutClearMemorySession() async {
    let api = MockAPI()
    api.handler = { path, _, _ in path.hasSuffix("/login") ? memberJSON : Data() }
    let auth = AuthSession(api: api, browser: MockBrowser())
    await auth.signInMember(id: "synthetic", password: "synthetic-only")
    XCTAssertEqual(auth.principal, member)
    await auth.signOut()
    XCTAssertNil(auth.principal)
    XCTAssertEqual(api.cleared, 2)
    XCTAssertEqual(
      api.requests.map { $0.0 },
      ["/api/v1/notification-members/login", "/api/v1/notification-members/logout"])
  }
  func testLogoutFailureDoesNotPretendSessionRevoked() async {
    let api = MockAPI()
    api.handler = { _, _, _ in memberJSON }
    let auth = AuthSession(api: api, browser: MockBrowser())
    await auth.signInMember(id: "synthetic", password: "synthetic-only")
    api.handler = { _, _, _ in throw APIError.transport }
    await auth.signOut()
    XCTAssertEqual(auth.principal, member)
    XCTAssertNotNil(auth.message)
  }
  func testOnlyOneMemberPOSTWhileRequestIsInFlight() async {
    let api = MockAPI()
    var pending: CheckedContinuation<Data, Error>?
    api.handler = { _, _, _ in try await withCheckedThrowingContinuation { pending = $0 } }
    let auth = AuthSession(api: api, browser: MockBrowser())
    let first = Task { await auth.signInMember(id: "synthetic", password: "synthetic-only") }
    while pending == nil { await Task.yield() }
    await auth.signInMember(id: "synthetic", password: "synthetic-only")
    pending?.resume(returning: memberJSON)
    await first.value
    XCTAssertEqual(api.requests.count, 1)
    XCTAssertFalse(auth.busy)
  }
  func testHistoryWorksWithoutNotificationPermissionForBothScopes() async {
    let api = MockAPI()
    api.handler = { _, _, _ in historyJSON }
    let history = AlertHistory(api: api)
    await history.load(for: owner)
    XCTAssertEqual(history.alerts.count, 1)
    await history.load(for: member)
    XCTAssertEqual(history.alerts.first?.matchedKeyword, "検証")
    XCTAssertEqual(
      api.requests.map { $0.0 },
      ["/api/v1/teams/team/alerts", "/api/v1/notification-members/alerts"])
  }
  func testLateHistoryResponseCannotRestorePreviousAccount() async {
    let api = MockAPI()
    var pending: CheckedContinuation<Data, Error>?
    api.handler = { _, _, _ in try await withCheckedThrowingContinuation { pending = $0 } }
    let history = AlertHistory(api: api)
    let task = Task { await history.load(for: owner) }
    while pending == nil { await Task.yield() }
    history.clear()
    pending?.resume(returning: historyJSON)
    await task.value
    XCTAssertTrue(history.alerts.isEmpty)
  }
  func testHistoryAuthFailureClearsStaleRows() async {
    let api = MockAPI()
    api.handler = { _, _, _ in historyJSON }
    let history = AlertHistory(api: api)
    await history.load(for: owner)
    api.handler = { _, _, _ in throw APIError.server(status: 401) }
    await history.load(for: owner)
    XCTAssertTrue(history.alerts.isEmpty)
    XCTAssertNotNil(history.message)
  }
  func testDeviceOffPermissionDeniedAndUnsolicitedCallbackNeverRegister() async {
    let registry = MockRegistry()
    let device = MockDevice()
    device.allowed = false
    let center = PushRegistrationCenter(registry: registry, device: device)
    center.bind(owner)
    await center.didReceiveDeviceToken(Data([1, 2, 3]))
    await center.enable()
    XCTAssertEqual(registry.registrations, 0)
    XCTAssertEqual(device.registered, 0)
    XCTAssertFalse(center.enabled)
    XCTAssertFalse(center.busy)
  }
  func testExplicitEnableRegistersOnceOffRevokesOnlyDeviceAndPersistsNoToken() async throws {
    let name = "callnow-unit-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let registry = MockRegistry()
    let device = MockDevice()
    let center = PushRegistrationCenter(registry: registry, device: device, defaults: defaults)
    center.bind(owner)
    XCTAssertFalse(center.enabled)
    await center.enable()
    XCTAssertFalse(center.enabled)
    XCTAssertTrue(center.busy)
    XCTAssertEqual(device.registered, 1)
    let synthetic = Data(repeating: 91, count: 32)
    await center.didReceiveDeviceToken(synthetic)
    await center.didReceiveDeviceToken(synthetic)
    XCTAssertTrue(center.enabled)
    XCTAssertEqual(registry.registrations, 1)
    let stored = defaults.persistentDomain(forName: name)!
    let serialized = try PropertyListSerialization.data(
      fromPropertyList: stored, format: .xml, options: 0)
    XCTAssertFalse(
      String(data: serialized, encoding: .utf8)!.contains(
        DeviceTokenFormatter.hexString(from: synthetic)))
    let off = await center.disable()
    XCTAssertTrue(off)
    XCTAssertFalse(center.enabled)
    XCTAssertEqual(registry.revocations, 1)
    XCTAssertEqual(device.unregistered, 1)
    let rebound = PushRegistrationCenter(registry: registry, device: device, defaults: defaults)
    rebound.bind(owner)
    XCTAssertFalse(rebound.enabled)
  }
  func testFailedRevocationKeepsOnAndReportsFailure() async {
    let name = "callnow-unit-" + UUID().uuidString
    let registry = MockRegistry()
    let device = MockDevice()
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let center = PushRegistrationCenter(registry: registry, device: device, defaults: defaults)
    center.bind(member)
    await center.enable()
    await center.didReceiveDeviceToken(Data([1, 2]))
    registry.fails = true
    let off = await center.disable()
    XCTAssertFalse(off)
    XCTAssertTrue(center.enabled)
    XCTAssertNotNil(center.message)
    XCTAssertEqual(device.unregistered, 0)
  }
  func testPR06BoundaryUsesPrincipalRouteAndLatestVersion() async throws {
    let api = MockAPI()
    let adapter = PushDeviceRegistry(api: api)
    let result = MockRegistry().result
    api.handler = { _, _, _ in
      Data(
        #"{"targetKey":"key","installationId":"installation","platform":"APNS","tokenVersion":7,"status":"ACTIVE"}"#
          .utf8)
    }
    _ = try await adapter.register(
      principal: member, installationId: "installation", token: "synthetic")
    try await adapter.revoke(principal: owner, registration: result)
    XCTAssertEqual(api.requests[0].0, "/api/v1/notification-members/push-devices")
    XCTAssertTrue(api.requests[1].0.hasPrefix("/api/v1/teams/team/push-devices/"))
    XCTAssertEqual(api.requests[1].1, "GET")
    XCTAssertEqual(api.requests[2].1, "DELETE")
    let json = try JSONSerialization.jsonObject(with: api.requests[2].2!) as! [String: Any]
    XCTAssertEqual(json["tokenVersion"] as? Int, 7)
  }
}
