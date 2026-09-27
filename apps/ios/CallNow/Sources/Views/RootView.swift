import SwiftUI

struct RootView: View {
  @EnvironmentObject private var auth: AuthSession
  @EnvironmentObject private var push: PushRegistrationCenter
  @EnvironmentObject private var history: AlertHistory
  @Environment(\.scenePhase) private var phase
  var body: some View {
    Group {
      if let principal = auth.principal {
        TabView {
          NavigationStack {
            List {
              if let message = history.message { Text(message).foregroundStyle(.secondary) }
              if history.alerts.isEmpty && !history.loading {
                Text("通知履歴はありません").accessibilityIdentifier("emptyHistory")
              }
              ForEach(history.alerts) { alert in
                VStack(alignment: .leading, spacing: 6) {
                  Text(alert.matchedKeyword).font(.headline)
                  Text("\(alert.kind == "TEST" ? "テスト" : "メール検知") ・ \(alert.source.provider)")
                  Text(alert.detectedAt).font(.caption)
                  Text("\(alert.readAt == nil ? "未読" : "既読") ・ \(alert.status)").font(.caption)
                }.accessibilityIdentifier("alert-\(alert.id)")
              }
            }
            .overlay { if history.loading { ProgressView() } }
            .navigationTitle("通知履歴")
            .refreshable { await history.load(for: principal) }
            .toolbar {
              Button("更新") { Task { await history.load(for: principal) } }.accessibilityIdentifier(
                "refreshHistory")
            }
          }.tabItem { Label("履歴", systemImage: "tray") }
          NotificationStatusView().tabItem { Label("設定", systemImage: "gearshape") }
        }
      } else {
        LoginView()
      }
    }
    .task(id: auth.principal?.scope) {
      history.clear()
      push.bind(auth.principal)
      if let current = auth.principal { await history.load(for: current) }
    }
    .onChange(of: phase) { _, new in
      if new == .active, let current = auth.principal { Task { await history.load(for: current) } }
    }
  }
}
