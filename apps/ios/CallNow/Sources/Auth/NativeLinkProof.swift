import CryptoKit
import Foundation
import Security

/// Per-attempt S256 verifier stays in memory. Never log or persist it.
struct NativeLinkProof {
    let verifier: String
    var challenge: String { Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    static func generate() throws -> NativeLinkProof {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw APIError.transport
        }
        return NativeLinkProof(verifier: base64URL(Data(bytes)))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func bootstrapURL(_ raw: String, provider: String, apiBase: URL) throws -> URL {
        guard let url = URL(string: raw), url.scheme == apiBase.scheme,
              url.host == apiBase.host, url.port == apiBase.port,
              url.user == nil, url.password == nil, url.fragment == nil,
              url.path == "/api/v1/auth/identities/\(provider)/link/browser" else {
            throw APIError.invalidURL
        }
        return url
    }

    static func completionCode(_ url: URL, provider: String) throws -> String {
        guard url.scheme == "com.callnow.app", url.host == "auth-callback",
              url.path.isEmpty, url.user == nil, url.password == nil, url.port == nil,
              url.fragment == nil,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIError.decoding
        }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count,
              items.first(where: { $0.name == "loginProvider" })?.value == provider.uppercased() else {
            throw APIError.decoding
        }
        let result = items.first(where: { $0.name == "result" })?.value
        if result == "error" {
            throw APIError.codedServer(status: 400, code: items.first(where: { $0.name == "errorCode" })?.value ?? "PRIMARY_LOGIN_INVALID_OR_EXPIRED")
        }
        guard result == "link_pending", let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw APIError.decoding
        }
        return code
    }
}
