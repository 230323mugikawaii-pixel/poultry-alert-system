import Foundation

struct LinkedIdentity: Decodable, Equatable {
    let provider: String
    let email: String?
}

struct IdentitiesResponse: Decodable {
    let identities: [LinkedIdentity]
}
