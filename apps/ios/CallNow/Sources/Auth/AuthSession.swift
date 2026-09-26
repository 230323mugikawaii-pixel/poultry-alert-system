import AuthenticationServices
import UIKit

/// Drives login against the existing web OAuth endpoints
/// (`GET /api/v1/auth/:provider/start` → Google/Microsoft → the server's own
/// `/api/v1/auth/:provider/callback`, see primary-auth-routes.ts).
///
/// Design note (see docs/ios/step-01-shell-implementation-results.md for the
/// full writeup): the backend's OAuth callback redirects to the *web
/// frontend* origin (PUBLIC_ORIGIN) with a `?primaryAuth=success` query
/// string. There is no custom URL scheme or Universal Link landing point for
/// a native client to intercept via ASWebAuthenticationSession's
/// `callbackURLScheme` — changing that would be a backend/web change, out of
/// scope for this PR. Instead, this session:
///  1. Starts a *non-ephemeral* ASWebAuthenticationSession, so the httpOnly
///     session cookie Fastify sets on the callback lands in the same shared
///     system cookie storage a Safari tab would use.
///  2. Polls `GET /api/v1/auth/me` through APIClient, which uses
///     URLSession.shared and therefore shares that cookie storage. httpOnly
///     only blocks `document.cookie` access from JavaScript — it does not
///     stop the cookie from being attached to an ordinary URLSession
///     request against the same host.
///  3. Once `/auth/me` succeeds, treats login as complete and cancels the
///     web authentication session itself, since it will never receive a
///     matching callback URL to close on its own.
@MainActor
final class AuthSession: NSObject, ObservableObject {
    enum Provider: String {
        case google
        case microsoft
    }

    enum State: Equatable {
        case signedOut
        case signingIn
        case signedIn(CurrentUser)
        case failed(String)
    }

    @Published private(set) var state: State = .signedOut
    private(set) var currentTeamId: String?

    private let api: APIClient
    private var webAuthSession: ASWebAuthenticationSession?
    private var pollTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    func signIn(with provider: Provider) {
        guard state != .signingIn else { return }
        state = .signingIn

        guard let startURL = URL(
            string: AppEnvironment.apiBaseURL.absoluteString + "/api/v1/auth/\(provider.rawValue)/start"
        ) else {
            state = .failed("接続先の設定を確認してください。")
            return
        }

        // callbackURLScheme is a required initializer parameter but is never
        // actually matched by this flow — see the class doc comment above.
        // Completion is instead detected by polling below, and this session
        // is cancelled once that succeeds.
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: "com.callnow.app"
        ) { [weak self] _, error in
            Task { @MainActor in
                self?.handleWebAuthenticationCompletion(error: error)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webAuthSession = session
        session.start()

        pollTask?.cancel()
        pollTask = Task { [weak self] in
            await self?.pollForCompletedLogin()
        }
    }

    func signOut() {
        pollTask?.cancel()
        webAuthSession?.cancel()
        webAuthSession = nil
        currentTeamId = nil
        state = .signedOut
    }

    private func pollForCompletedLogin() async {
        // The web callback completes almost immediately once the user
        // approves on Google/Microsoft's side. Polling once a second for up
        // to two minutes comfortably covers that without hammering the API;
        // a 401 while the browser flow is still in progress is expected and
        // is not surfaced as an error.
        for _ in 0..<120 {
            if Task.isCancelled { return }
            if let user = try? await api.get("/api/v1/auth/me") as CurrentUserResponse {
                await finishLogin(user: user.user)
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        if state == .signingIn {
            state = .failed("ログインがタイムアウトしました。もう一度お試しください。")
        }
    }

    private func finishLogin(user: CurrentUser) async {
        currentTeamId = (try? await api.get("/api/v1/teams/current") as CurrentTeamResponse)?.team.id
        // A failed team lookup here isn't fatal to showing the user as
        // signed in — push registration will simply report an error until
        // retried (see PushRegistrationCenter.didReceiveDeviceToken).
        state = .signedIn(user)
        webAuthSession?.cancel()
        webAuthSession = nil
    }

    private func handleWebAuthenticationCompletion(error: Error?) {
        guard let error else { return }
        let nsError = error as NSError
        let isUserCancelled = nsError.domain == ASWebAuthenticationSessionError.errorDomain
            && nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
        guard isUserCancelled, state == .signingIn else { return }
        pollTask?.cancel()
        state = .signedOut
    }
}

extension AuthSession: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // This delegate callback runs on the main thread in practice;
        // MainActor.assumeIsolated lets us access main-actor-isolated UIKit
        // state (UIApplication.shared) synchronously without making this
        // protocol requirement itself `async`.
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}
