import CryptoKit
import Foundation
import Security

struct NativePKCE {
  static let clientId = "callnow-ios"
  static let callbackScheme = "com.callnow.poultryalert"
  static let redirectURI = "\(callbackScheme):/oauth/callback"
  let verifier: String
  let state: String
  init(verifier: String? = nil, state: String? = nil) throws {
    self.verifier = try verifier ?? Self.random()
    self.state = try state ?? Self.random()
  }
  static func random() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw APIError.transport
    }
    return base64url(Data(bytes))
  }
  static func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
  var challenge: String { Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }
  func startURL(base: URL, provider: String) throws -> URL {
    guard ["google", "microsoft"].contains(provider), AppEnvironment.isAllowedAPIURL(base),
      var url = URLComponents(
        url: base.appendingPathComponent("api/v1/auth/native/\(provider)/start"),
        resolvingAgainstBaseURL: false)
    else { throw APIError.invalidURL }
    url.queryItems = [
      "client_id": Self.clientId, "redirect_uri": Self.redirectURI, "response_type": "code",
      "code_challenge_method": "S256", "code_challenge": challenge, "state": state,
    ].map { URLQueryItem(name: $0.key, value: $0.value) }
    guard let result = url.url else { throw APIError.invalidURL }
    return result
  }
  func code(from url: URL) throws -> String {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme == Self.callbackScheme, parts.host == nil,
      parts.path == "/oauth/callback", parts.fragment == nil
    else { throw APIError.invalidURL }
    let values = parts.queryItems ?? []
    guard values.filter({ $0.name == "state" }).count == 1,
      values.first(where: { $0.name == "state" })?.value == state,
      !values.contains(where: { $0.name == "error" }),
      values.filter({ $0.name == "code" }).count == 1,
      let code = values.first(where: { $0.name == "code" })?.value,
      code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    else { throw APIError.decoding }
    return code
  }
  struct Exchange: Encodable {
    let grant_type = "authorization_code"
    let client_id = NativePKCE.clientId
    let redirect_uri = NativePKCE.redirectURI
    let code: String
    let code_verifier: String
  }
}
