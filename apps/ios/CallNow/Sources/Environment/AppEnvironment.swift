import Foundation

/// Server connection settings, switched per build configuration (Debug/
/// Release) via CALLNOW_API_BASE_URL / CALLNOW_PUBLIC_ORIGIN build settings
/// injected into Info.plist by project.yml — never hardcoded to a
/// production URL. See docs/ios/step-01-shell-implementation-results.md.
enum AppEnvironment {
    /// Where this app sends API requests.
    static var apiBaseURL: URL {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "CALLNOW_API_BASE_URL") as? String,
            let url = URL(string: raw),
            url.scheme == "http" || url.scheme == "https"
        else {
            return developmentDefault
        }
        return url
    }

    /// The value the backend expects on the `Origin` header for mutating
    /// requests (see apps/api/src/modules/auth/primary-auth-routes.ts and
    /// device-push-routes.ts `requireSameOrigin`/`authenticate`). This is
    /// the *web frontend's* origin, not necessarily the same host/port as
    /// the API server — in local development they differ (API on :8080,
    /// static frontend on :5500; see apps/api/.env.example PUBLIC_ORIGIN).
    static var publicOrigin: String {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "CALLNOW_PUBLIC_ORIGIN") as? String,
            !raw.isEmpty
        else {
            return developmentDefaultPublicOrigin
        }
        return raw
    }

    private static let developmentDefault = URL(string: "http://127.0.0.1:8080")!
    private static let developmentDefaultPublicOrigin = "http://127.0.0.1:5500"
}
