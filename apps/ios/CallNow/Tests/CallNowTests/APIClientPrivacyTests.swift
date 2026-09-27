import XCTest

@testable import CallNow

private final class MockHTTP: URLProtocol {
  static var seen: [URLRequest] = []
  static var status = 200
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.seen.append(request)
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: [:])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"private":"synthetic-error-body"}"#.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class APIClientPrivacyTests: XCTestCase {
  private func api() -> APIClient {
    MockHTTP.seen = []
    MockHTTP.status = 200
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockHTTP.self]
    return APIClient(
      baseURL: URL(string: "https://api.example.invalid")!, origin: "https://web.example.invalid",
      configuration: config)
  }
  func testNoCacheExactOriginAndNoBearerToken() async throws {
    let client = api()
    _ = try await client.perform("/api/v1/auth/native/token", method: "POST", body: Data("{}".utf8))
    let request = try XCTUnwrap(MockHTTP.seen.first)
    XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://web.example.invalid")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
  }
  func testRemoteOriginAndPathEscapeNeverReachTransport() async {
    let client = api()
    for path in [
      "https://evil.example.invalid/api/v1/auth/me", "//evil.example.invalid/api/v1/auth/me",
      "/api/v1/../../private",
    ] {
      do {
        _ = try await client.perform(path, method: "GET", body: nil)
        XCTFail("Unexpected request")
      } catch { XCTAssertEqual(error as? APIError, .invalidURL) }
    }
    XCTAssertTrue(MockHTTP.seen.isEmpty)
  }
  func testRawErrorResponseIsNotPropagated() async {
    let client = api()
    MockHTTP.status = 503
    do {
      _ = try await client.perform("/api/v1/auth/me", method: "GET", body: nil)
      XCTFail("Unexpected success")
    } catch {
      XCTAssertEqual(error as? APIError, .server(status: 503))
      XCTAssertFalse(error.localizedDescription.contains("synthetic-error-body"))
    }
  }
  func testIndependentEphemeralCookieStores() {
    let one = URLSessionConfiguration.ephemeral
    let two = URLSessionConfiguration.ephemeral
    let cookie = HTTPCookie(properties: [
      .domain: "example.invalid", .path: "/", .name: "synthetic", .value: "synthetic-only",
      .expires: Date(timeIntervalSinceNow: 3600),
    ])!
    one.httpCookieStorage?.setCookie(cookie)
    XCTAssertEqual(one.httpCookieStorage?.cookies?.count, 1)
    XCTAssertTrue(two.httpCookieStorage?.cookies?.isEmpty ?? true)
    XCTAssertFalse(HTTPCookieStorage.shared.cookies?.contains { $0.name == "synthetic" } ?? false)
    let client = APIClient(baseURL: URL(string: "https://example.invalid")!, configuration: one)
    client.clearSession()
    XCTAssertTrue(one.httpCookieStorage?.cookies?.isEmpty ?? true)
  }
}
