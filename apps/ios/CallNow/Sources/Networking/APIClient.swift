import Foundation

/// Talks to the existing Call Now API. Deliberately does not read, store, or
/// attach the session cookie itself — it reuses the shared cookie storage
/// (URLSession.shared / HTTPCookieStorage.shared) that AuthSession's
/// non-ephemeral ASWebAuthenticationSession already populated, exactly like
/// a browser tab would. httpOnly only blocks JavaScript's `document.cookie`;
/// it does not stop native URLSession requests from attaching the cookie.
final class APIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(session: URLSession = .shared) {
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    /// GETs never need an Origin header — the existing routes only enforce
    /// it on mutating requests (see requireSameOrigin call sites in
    /// auth-routes.ts / primary-auth-routes.ts / device-push-routes.ts).
    func get<Response: Decodable>(_ path: String) async throws -> Response {
        try await send(path: path, method: "GET", body: Optional<EmptyBody>.none)
    }

    /// Mutating requests (POST/PUT/DELETE) must carry an `Origin` header
    /// matching the API's configured PUBLIC_ORIGIN exactly, or the server
    /// rejects them with 403 ORIGIN_NOT_ALLOWED. A native client never sets
    /// this automatically the way a browser does for cross-origin fetches,
    /// so it is added explicitly here.
    func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body) async throws -> Response {
        try await send(path: path, method: "POST", body: body)
    }

    private func send<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body?
    ) async throws -> Response {
        guard let url = URL(string: AppEnvironment.apiBaseURL.absoluteString + path) else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue(AppEnvironment.publicOrigin, forHTTPHeaderField: "Origin")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode)
        }
        if Response.self == EmptyResponse.self {
            // swiftlint:disable:next force_cast
            return EmptyResponse() as! Response
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }
}

private struct EmptyBody: Encodable {}
struct EmptyResponse: Decodable {}
