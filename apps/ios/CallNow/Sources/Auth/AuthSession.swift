import AuthenticationServices
import UIKit

/// Drives login against the existing web OAuth endpoints
/// (`GET /api/v1/auth/:provider/start?client=native` → Google/Microsoft →
/// the server's own `/api/v1/auth/:provider/callback`, see
/// primary-auth-routes.ts).
///
/// Design note: an earlier version of this class tried to detect login
/// completion by polling `GET /auth/me`, on the theory that the httpOnly
/// session cookie Fastify sets on the web callback would already be visible
/// to APIClient's URLSession.shared once the (non-ephemeral)
/// ASWebAuthenticationSession finished. That theory was wrong —
/// ASWebAuthenticationSession renders its web content out-of-process, and
/// its cookies are never visible to the app's own URLSession/
/// HTTPCookieStorage no matter how long polling is given to run. Confirmed
/// by live testing against staging on 2026-09-28: zero /auth/me successes
/// across 8 real logins, even after extending the poll window from 2 to 5
/// minutes and trying to manually copy WKWebsiteDataStore cookies into
/// HTTPCookieStorage.shared.
///
/// This version uses the standard native-app OAuth pattern instead (RFC
/// 8252, "OAuth 2.0 for Native Apps"):
///  1. `/start` is called with `?client=native`, which tells the backend to
///     redirect the OAuth callback to this app's own registered URL scheme
///     (`com.callnow.app://auth-callback`, see project.yml's
///     CFBundleURLTypes) instead of the web PUBLIC_ORIGIN, carrying a
///     short-lived one-time exchange `code` query parameter rather than
///     setting a cookie.
///  2. ASWebAuthenticationSession's own completion handler receives that
///     callback URL directly — this is exactly what `callbackURLScheme` is
///     designed for, so no polling or manual timeout is needed.
///  3. The app extracts `code` from the callback URL and POSTs it to
///     `/api/v1/auth/native/exchange` via APIClient — an ordinary
///     URLSession request the app itself makes, so the session cookie that
///     response sets *does* land in HTTPCookieStorage.shared correctly,
///     unlike anything set during the out-of-process web auth session.
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

    init(api: APIClient) {
        self.api = api
    }

    func signIn(with provider: Provider) {
        guard state != .signingIn else { return }
        state = .signingIn

        guard
            var components = URLComponents(
                string: AppEnvironment.apiBaseURL.absoluteString
                    + "/api/v1/auth/\(provider.rawValue)/start"
            )
        else {
            state = .failed("接続先の設定を確認してください。")
            return
        }
        components.queryItems = [URLQueryItem(name: "client", value: "native")]
        guard let startURL = components.url else {
            state = .failed("接続先の設定を確認してください。")
            return
        }

        // Must match project.yml's CFBundleURLTypes > CFBundleURLSchemes
        // entry exactly, or the OS will never route the callback into the
        // completion handler below.
        let session = ASWebAuthenticationSession(
            url: startURL,
            callbackURLScheme: "com.callnow.app"
        ) { [weak self] callbackURL, error in
            Task { @MainActor in
                await self?.handleWebAuthenticationCompletion(
                    callbackURL: callbackURL,
                    error: error
                )
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        webAuthSession = session
        session.start()
    }

    func signOut() {
        webAuthSession?.cancel()
        webAuthSession = nil
        currentTeamId = nil
        state = .signedOut
    }

    private func handleWebAuthenticationCompletion(
        callbackURL: URL?,
        error: Error?
    ) async {
        webAuthSession = nil
        guard state == .signingIn else { return }

        if let error {
            let nsError = error as NSError
            let isUserCancelled = nsError.domain == ASWebAuthenticationSessionError.errorDomain
                && nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
            state = isUserCancelled
                ? .signedOut
                : .failed("ログインに失敗しました。もう一度お試しください。")
            return
        }

        guard
            let callbackURL,
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
        else {
            state = .failed(Self.errorMessage(for: nil))
            return
        }

        guard
            components.queryItems?.first(where: { $0.name == "result" })?.value == "success",
            let code = components.queryItems?.first(where: { $0.name == "code" })?.value
        else {
            let errorCode = components.queryItems?.first(where: { $0.name == "errorCode" })?.value
            state = .failed(Self.errorMessage(for: errorCode))
            return
        }

        await exchangeCodeForSession(code)
    }

    /// Maps the backend's AppError code — passed through the native
    /// callback's `errorCode` query param, see primary-auth-routes.ts's
    /// nativeCallbackUrl — to the same user-facing message the web flow
    /// shows, instead of a generic "try again" that hides an actionable
    /// cause (most commonly: an account with this email already exists via
    /// another login method).
    static func errorMessage(for errorCode: String?) -> String {
        switch errorCode {
        case "LOGIN_IDENTITY_LINK_REQUIRED":
            return "同じメールアドレスの利用者が既に存在します。以前使ったログイン方法でサインインしてから、この方法を追加してください。"
        case "LOGIN_IDENTITY_REVOKED":
            return "このログイン方法は解除されています。別の方法でログインしてください。"
        case "LOGIN_IDENTITY_ALREADY_IN_USE":
            return "このログイン方法はすでに別のCall Nowアカウントに接続されています。"
        case "LOGIN_PROVIDER_ALREADY_LINKED":
            return "このログイン方法はすでに別のアカウントで追加されています。"
        case "LOGIN_PROVIDER_NOT_CONFIGURED":
            return "このログイン方法は現在準備中です。"
        case "PRIMARY_LOGIN_INVALID_OR_EXPIRED", "NATIVE_LINK_PKCE_REQUIRED":
            return "認証が無効または期限切れです。もう一度最初からお試しください。"
        default:
            return "ログインに失敗しました。もう一度お試しください。"
        }
    }

    private func exchangeCodeForSession(_ code: String) async {
        do {
            let response: CurrentUserResponse = try await api.post(
                "/api/v1/auth/native/exchange",
                body: NativeExchangeRequest(code: code)
            )
            // POST /teams/bootstrap, not GET /teams/current: a brand-new
            // account has no team yet, and nothing earlier in the login flow
            // provisions one. bootstrap is idempotent — ensureInitialTeamForUser
            // returns the existing team when the user already has one (see
            // team-service.ts) — so it's safe to call on every login, new or
            // returning. A failure here isn't fatal to showing the user as
            // signed in — push registration will simply report an error
            // until retried (see PushRegistrationCenter.didReceiveDeviceToken).
            currentTeamId = (try? await api.post(
                "/api/v1/teams/bootstrap",
                body: TeamBootstrapRequest()
            ) as CurrentTeamResponse)?.team.id
            state = .signedIn(response.user)
        } catch {
            state = .failed("ログインに失敗しました。もう一度お試しください。")
        }
    }
}

/// Body for POST /api/v1/auth/native/exchange (primary-auth-routes.ts).
private struct NativeExchangeRequest: Encodable {
    let code: String
}

/// Body for POST /api/v1/teams/bootstrap (team-routes.ts). No fields are
/// required here — this shell doesn't collect initial keywords during
/// onboarding, it just needs a team to exist.
private struct TeamBootstrapRequest: Encodable {}

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
