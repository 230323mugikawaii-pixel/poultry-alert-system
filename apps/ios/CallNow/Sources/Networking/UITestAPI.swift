// Debug-only synthetic UI fixtures. No server, credentials or APNs access.
#if DEBUG
  import Foundation

  final class UITestAPI: APIRequesting {
    func clearSession() {}
    func perform(_ path: String, method: String, body: Data?) async throws -> Data {
      let text: String
      switch path {
      case "/api/v1/auth/native/providers":
        text =
          #"{"providers":[{"provider":"GOOGLE","status":"NOT_CONFIGURED"},{"provider":"MICROSOFT","status":"NOT_CONFIGURED"}]}"#
      case "/api/v1/notification-members/login":
        text =
          #"{"member":{"id":"11111111-1111-4111-8111-111111111111","displayName":"検証メンバー","status":"ACTIVE"},"team":{"id":"22222222-2222-4222-8222-222222222222"}}"#
      case "/api/v1/notification-members/alerts":
        text =
          #"{"alerts":[{"id":"33333333-3333-4333-8333-333333333333","kind":"REAL","status":"ACTIVE","detectedAt":"2026-09-27T00:00:00Z","matchedKeyword":"検証キーワード","readAt":null,"source":{"provider":"GOOGLE"}}]}"#
      case "/api/v1/notification-members/logout": text = ""
      default: throw APIError.server(status: 404)
      }
      return Data(text.utf8)
    }
  }
#endif
