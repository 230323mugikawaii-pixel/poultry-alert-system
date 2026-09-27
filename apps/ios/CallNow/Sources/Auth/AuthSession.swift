import AuthenticationServices
import UIKit

@MainActor protocol OAuthBrowsing {
  func authenticate(url: URL) async throws -> URL
  func cancel()
}
@MainActor
final class OAuthBrowser: NSObject, OAuthBrowsing, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?
  private var pending: CheckedContinuation<URL, Error>?
  private var generation = UUID()
  func authenticate(url: URL) async throws -> URL {
    cancel()
    let operation = UUID()
    generation = operation
    return try await withCheckedThrowingContinuation { continuation in
      pending = continuation
      let current = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.callnow.app") {
        [weak self] callback, _ in
        Task { @MainActor in
          guard let self, self.generation == operation else { return }
          if let callback {
            self.finish(.success(callback))
          } else {
            self.finish(.failure(APIError.transport))
          }
        }
      }
      current.presentationContextProvider = self
      current.prefersEphemeralWebBrowserSession = false
      session = current
      if !current.start() { finish(.failure(APIError.transport)) }
    }
  }
  private func finish(_ result: Result<URL, Error>) {
    let continuation = pending
    pending = nil
    session = nil
    continuation?.resume(with: result)
  }
  func cancel() {
    generation = UUID()
    let old = session
    finish(.failure(CancellationError()))
    old?.cancel()
  }
  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession)
    -> ASPresentationAnchor
  {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
  }
}

@MainActor final class AuthSession: ObservableObject {
  @Published private(set) var principal: Principal?
  @Published private(set) var busy = false
  @Published private(set) var message: String?
  @Published private(set) var providers: [String] = []
  let api: any APIRequesting
  private let browser: any OAuthBrowsing
  private let baseURL: URL
  private var generation = UUID()
  init(
    api: any APIRequesting, browser: (any OAuthBrowsing)? = nil,
    baseURL: URL = AppEnvironment.apiBaseURL
  ) {
    self.api = api
    self.browser = browser ?? OAuthBrowser()
    self.baseURL = baseURL
  }
  func loadProviders() async {
    struct Reply: Decodable {
      struct Provider: Decodable {
        let provider: String
        let status: String
      }
      let providers: [Provider]
    }
    do {
      let reply: Reply = try await api.get("/api/v1/auth/native/providers")
      providers = reply.providers.filter { $0.status == "AVAILABLE" }.map {
        $0.provider.lowercased()
      }
    } catch {
      providers = []
      message = "OWNERログインは未設定または接続できません。"
    }
  }
  func signIn(provider: String) async {
    guard !busy else { return }
    busy = true
    message = nil
    api.clearSession()
    generation = UUID()
    let operation = generation
    defer { if generation == operation { busy = false } }
    do {
      let pkce = try NativePKCE()
      let callback = try await browser.authenticate(
        url: pkce.startURL(base: baseURL, provider: provider))
      guard generation == operation else { return }
      let reply: CurrentUserResponse = try await api.send(
        "/api/v1/auth/native/token",
        body: NativePKCE.Exchange(code: pkce.code(from: callback), code_verifier: pkce.verifier))
      let team: TeamSummary?
      do {
        team = try await (api.get("/api/v1/teams/current") as CurrentTeamResponse).team
      } catch APIError.server(status: 404) { team = nil }
      guard generation == operation else { return }
      if let role = team?.role, role != "OWNER" { throw APIError.server(status: 403) }
      principal = Principal(
        kind: .owner, id: reply.user.id, teamId: team?.id,
        displayName: reply.user.displayName ?? "OWNER")
    } catch {
      if generation == operation {
        api.clearSession()
        message = "ログインを完了できませんでした。設定・接続を確認してやり直してください。"
      }
    }
  }
  func signInMember(id: String, password: String) async {
    guard !busy else { return }
    struct Credentials: Encodable {
      let callNowId: String
      let password: String
    }
    busy = true
    message = nil
    api.clearSession()
    generation = UUID()
    let operation = generation
    defer { if generation == operation { busy = false } }
    do {
      let reply: MemberResponse = try await api.send(
        "/api/v1/notification-members/login", body: Credentials(callNowId: id, password: password))
      guard generation == operation else { return }
      guard reply.member.status == "ACTIVE" else { throw APIError.server(status: 401) }
      principal = Principal(
        kind: .member, id: reply.member.id, teamId: reply.team.id,
        displayName: reply.member.displayName)
    } catch {
      if generation == operation {
        api.clearSession()
        message = "ログインできませんでした。ID・パスワードと接続を確認してください。"
      }
    }
  }
  func signOut() async {
    guard let current = principal, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: EmptyResponse = try await api.send(
        current.kind == .owner ? "/api/v1/auth/logout" : "/api/v1/notification-members/logout",
        body: EmptyBody())
    } catch APIError.server(status: 401) { /* Already expired. */  } catch {
      message = "ログアウトを完了できません。接続を確認してください。"
      return
    }
    generation = UUID()
    browser.cancel()
    api.clearSession()
    principal = nil
    message = nil
  }
}
