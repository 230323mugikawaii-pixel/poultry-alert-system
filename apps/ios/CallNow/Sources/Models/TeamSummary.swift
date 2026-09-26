import Foundation

/// Mirrors GET /api/v1/teams/current (apps/api/src/modules/teams/team-routes.ts).
/// Only the fields this shell needs are declared; JSONDecoder ignores the
/// rest of the response (seats, subscription, keywords, ...) without error.
struct CurrentTeamResponse: Decodable {
    let team: TeamSummary
}

struct TeamSummary: Decodable, Equatable {
    let id: String
    /// "OWNER" or "MEMBER". Google/Microsoft OAuth login (this shell's only
    /// login path) always resolves to an OWNER account — notification
    /// members log in separately with a Call Now ID/password, which this
    /// shell does not implement.
    let role: String
}
