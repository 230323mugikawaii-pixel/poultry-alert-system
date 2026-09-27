import Foundation

struct CurrentTeamResponse: Decodable { let team: TeamSummary }
struct TeamSummary: Decodable, Equatable {
  let id: String
  let role: String?
}
struct MemberResponse: Decodable {
  struct Member: Decodable {
    let id: String
    let displayName: String
    let status: String
  }
  let member: Member
  let team: TeamSummary
}
struct Principal: Equatable {
  enum Kind: String { case owner, member }
  let kind: Kind
  let id: String
  let teamId: String?
  let displayName: String
  var scope: String { "\(kind.rawValue):\(id):\(teamId ?? "unconfigured")" }
  var alertsPath: String? {
    if kind == .member { return "/api/v1/notification-members/alerts" }
    return teamId.map { "/api/v1/teams/\($0)/alerts" }
  }
  var devicesPath: String? {
    if kind == .member { return "/api/v1/notification-members/push-devices" }
    return teamId.map { "/api/v1/teams/\($0)/push-devices" }
  }
}
