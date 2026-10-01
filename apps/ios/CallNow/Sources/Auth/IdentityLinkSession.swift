import AuthenticationServices
import UIKit

@MainActor
protocol IdentityLinkAPI {
    func identities() async throws -> [LinkedIdentity]
    func start(provider: String, challenge: String) async throws -> String
    func finalize(provider: String, code: String, verifier: String) async throws
}

@MainActor
final class HTTPIdentityLinkAPI: IdentityLinkAPI {
    private let api: APIClient
    init(api: APIClient = APIClient()) { self.api = api }
    func identities() async throws -> [LinkedIdentity] {
        let response: IdentitiesResponse = try await api.get("/api/v1/auth/identities")
        return response.identities
    }
    func start(provider: String, challenge: String) async throws -> String {
        let response: StartResponse = try await api.post(
            "/api/v1/auth/identities/\(provider)/link/start?client=native",
            body: StartRequest(codeChallenge: challenge))
        return response.authorizationUrl
    }
    func finalize(provider: String, code: String, verifier: String) async throws {
        let _: EmptyResponse = try await api.post(
            "/api/v1/auth/identities/\(provider)/link/finalize",
            body: FinalizeRequest(code: code, codeVerifier: verifier))
    }
    private struct StartRequest: Encodable {
        let codeChallenge: String
        let codeChallengeMethod = "S256"
    }
    private struct StartResponse: Decodable { let authorizationUrl: String }
    private struct FinalizeRequest: Encodable { let code: String; let codeVerifier: String }
}

@MainActor
protocol IdentityLinkBrowser: AnyObject {
    func start(url: URL, completion: @escaping (URL?, Error?) -> Void) -> Bool
    func cancel()
}

@MainActor
final class IdentityLinkSession: ObservableObject {
    @Published private(set) var identities: [LinkedIdentity] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLinking = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var successMessage: String?

    private let api: IdentityLinkAPI
    private let browser: IdentityLinkBrowser
    private let apiBase: URL
    private var attempt: UUID?
    private var completingAttempt: UUID?
    private var loadGeneration = UUID()

    init(api: IdentityLinkAPI? = nil, browser: IdentityLinkBrowser? = nil, apiBase: URL = AppEnvironment.apiBaseURL) {
        self.api = api ?? HTTPIdentityLinkAPI()
        self.browser = browser ?? LinkAuthenticationBrowser()
        self.apiBase = apiBase
    }

    func reload() async {
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        errorMessage = nil
        do {
            let result = try await api.identities()
            guard loadGeneration == generation else { return }
            identities = result
        } catch {
            guard loadGeneration == generation else { return }
            errorMessage = "ログイン方法の一覧を取得できませんでした。再読み込みしてください。"
        }
        if loadGeneration == generation { isLoading = false }
    }

    func startLink(provider: AuthSession.Provider) async {
        guard !isLinking else { return }
        let id = UUID()
        attempt = id
        completingAttempt = nil
        isLinking = true
        errorMessage = nil
        successMessage = nil
        do {
            let proof = try NativeLinkProof.generate()
            let rawURL = try await api.start(provider: provider.rawValue, challenge: proof.challenge)
            guard attempt == id else { return }
            let url = try NativeLinkProof.bootstrapURL(rawURL, provider: provider.rawValue, apiBase: apiBase)
            let started = browser.start(url: url) { [weak self] url, error in
                Task { @MainActor in
                    await self?.complete(id: id, provider: provider, proof: proof, url: url, error: error)
                }
            }
            if !started { throw APIError.transport }
        } catch {
            fail(error, id: id)
        }
    }

    func cancel() {
        attempt = nil
        completingAttempt = nil
        loadGeneration = UUID()
        isLinking = false
        isLoading = false
        browser.cancel()
    }

    private func complete(id: UUID, provider: AuthSession.Provider, proof: NativeLinkProof, url: URL?, error: Error?) async {
        guard attempt == id, completingAttempt != id else { return }
        completingAttempt = id
        if let error {
            let ns = error as NSError
            if ns.domain == ASWebAuthenticationSessionError.errorDomain,
               ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                cancel()
            } else { fail(error, id: id) }
            return
        }
        do {
            guard let url else { throw APIError.decoding }
            let code = try NativeLinkProof.completionCode(url, provider: provider.rawValue)
            // A browser callback is only proof collection, not success. Use the
            // original app cookie + verifier; never native/exchange for LINK.
            try await api.finalize(provider: provider.rawValue, code: code, verifier: proof.verifier)
            guard attempt == id else { return }
            attempt = nil
            isLinking = false
            successMessage = "ログイン方法を追加しました。"
            await reload()
        } catch { fail(error, id: id) }
    }

    private func fail(_ error: Error, id: UUID) {
        guard attempt == id else { return }
        attempt = nil
        isLinking = false
        if case APIError.codedServer(_, let code) = error {
            errorMessage = AuthSession.errorMessage(for: code)
        } else {
            errorMessage = "ログイン方法を追加できませんでした。もう一度お試しください。"
        }
    }
}

@MainActor
private final class LinkAuthenticationBrowser: NSObject, IdentityLinkBrowser, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func start(url: URL, completion: @escaping (URL?, Error?) -> Void) -> Bool {
        let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.callnow.app") { [weak self] url, error in
            Task { @MainActor in
                self?.session = nil
                completion(url, error)
            }
        }
        auth.prefersEphemeralWebBrowserSession = false
        auth.presentationContextProvider = self
        session = auth
        return auth.start()
    }
    func cancel() { session?.cancel(); session = nil }
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
