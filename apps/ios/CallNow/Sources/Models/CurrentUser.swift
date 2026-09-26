import Foundation

/// Mirrors the response of GET /api/v1/auth/me
/// (apps/api/src/modules/auth/auth-routes.ts, `publicUser`).
struct CurrentUserResponse: Decodable {
    let user: CurrentUser
}

struct CurrentUser: Decodable, Equatable {
    let id: String
    let email: String
    let displayName: String?
}
