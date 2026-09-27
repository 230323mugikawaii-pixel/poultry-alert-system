import Foundation

struct AlertHistoryResponse: Decodable { let alerts: [AlertSummary] }
struct AlertSummary: Decodable, Identifiable {
  struct Source: Decodable { let provider: String }
  let id: String
  let kind: String
  let status: String
  let detectedAt: String
  let matchedKeyword: String
  let readAt: String?
  let source: Source
}

@MainActor final class AlertHistory: ObservableObject {
  @Published private(set) var alerts: [AlertSummary] = []
  @Published private(set) var loading = false
  @Published private(set) var message: String?
  private let api: any APIRequesting
  private var generation = UUID()
  init(api: any APIRequesting) { self.api = api }
  func clear() {
    generation = UUID()
    alerts = []
    loading = false
    message = nil
  }
  func load(for principal: Principal) async {
    let operation = UUID()
    generation = operation
    guard let path = principal.alertsPath else {
      alerts = []
      message = "Web画面でOWNERの初回セットアップを完了してください。"
      return
    }
    loading = true
    defer { if operation == generation { loading = false } }
    do {
      let result: AlertHistoryResponse = try await api.get(path)
      guard operation == generation else { return }
      alerts = result.alerts
      message = nil
    } catch {
      guard operation == generation else { return }
      // Do not leave another account's or stale history on screen after auth failure.
      alerts = []
      message = "履歴を取得できません。接続とログイン状態を確認してください。"
    }
  }
}
