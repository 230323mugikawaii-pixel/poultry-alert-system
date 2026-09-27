import Foundation

protocol APIRequesting {
  func perform(_ path: String, method: String, body: Data?) async throws -> Data
  func clearSession()
}
extension APIRequesting {
  func get<Response: Decodable>(_ path: String) async throws -> Response {
    try JSONDecoder().decode(Response.self, from: await perform(path, method: "GET", body: nil))
  }
  func send<Body: Encodable, Response: Decodable>(
    _ path: String, method: String = "POST", body: Body
  ) async throws -> Response {
    let data = try await perform(path, method: method, body: JSONEncoder().encode(body))
    if Response.self == EmptyResponse.self { return EmptyResponse() as! Response }
    return try JSONDecoder().decode(Response.self, from: data)
  }
}
struct EmptyBody: Encodable {}
struct EmptyResponse: Decodable {}

/// An independent, memory-only cookie jar. No browser-cookie sharing or disk cache.
/// Only the native code exchange/member login response supplies Set-Cookie.
final class APIClient: NSObject, APIRequesting, URLSessionTaskDelegate {
  private let baseURL: URL
  private let origin: String
  private let configuration: URLSessionConfiguration
  private lazy var session = URLSession(
    configuration: configuration, delegate: self, delegateQueue: nil)
  init(
    baseURL: URL = AppEnvironment.apiBaseURL, origin: String = AppEnvironment.publicOrigin,
    configuration: URLSessionConfiguration = .ephemeral
  ) {
    self.baseURL = baseURL
    self.origin = origin
    self.configuration = configuration
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    super.init()
  }
  func perform(_ path: String, method: String, body: Data?) async throws -> Data {
    guard path.hasPrefix("/api/v1/"), !path.contains(".."),
      let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
      url.host == baseURL.host, url.port == baseURL.port,
      AppEnvironment.isAllowedAPIURL(url)
    else { throw APIError.invalidURL }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
    request.setValue(origin, forHTTPHeaderField: "Origin")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) } catch {
      throw APIError.transport
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.transport }
    guard (200..<300).contains(http.statusCode) else {
      throw APIError.server(status: http.statusCode)
    }
    return data
  }
  func clearSession() {
    configuration.httpCookieStorage?.cookies?.forEach {
      configuration.httpCookieStorage?.deleteCookie($0)
    }
  }
  // Do not forward credentials through unexpected API redirects.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
