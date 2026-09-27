import SwiftUI

struct NotificationStatusView: View {
  @EnvironmentObject private var auth: AuthSession
  @EnvironmentObject private var push: PushRegistrationCenter
  var body: some View {
    NavigationStack {
      Form {
        Section("この端末の通知") {
          Toggle(
            "通知ON",
            isOn: Binding(
              get: { push.enabled },
              set: { value in
                Task { if value { await push.enable() } else { await push.disable() } }
              })
          ).disabled(push.busy || auth.busy || auth.principal?.devicesPath == nil)
            .accessibilityIdentifier("notificationsToggle")
          if push.busy { ProgressView("端末設定を反映しています") }
          Text("OFFにしてもメール監視と通知履歴は継続します。他の端末には影響しません。")
          Text("iOS側の通知許可・音量・集中モードは端末の設定をご確認ください。")
          if let message = push.message {
            Text(message).foregroundStyle(.red).accessibilityIdentifier("pushError")
          }
        }
        Section("アカウント") {
          Text(auth.principal?.displayName ?? "")
          Text(auth.principal?.kind == .owner ? "OWNER" : "通知メンバー")
          if let message = auth.message { Text(message).foregroundStyle(.red) }
          Button("ログアウト", role: .destructive) {
            Task { if await push.disable() { await auth.signOut() } }
          }.disabled(push.busy || auth.busy).accessibilityIdentifier("logout")
        }
        Section("契約") {
          NavigationLink("課金・契約") { ContractPlaceholder(title: "課金・契約") }
          NavigationLink("解約") { ContractPlaceholder(title: "解約") }
        }
      }.navigationTitle("設定")
    }
  }
}
struct ContractPlaceholder: View {
  let title: String
  var body: some View {
    ContentUnavailableView(
      title, systemImage: "doc.text", description: Text("仕様は未確定です。この画面から契約変更・決済・解約は行いません。")
    ).navigationTitle(title)
  }
}
