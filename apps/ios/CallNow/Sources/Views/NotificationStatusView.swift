import SwiftUI

struct NotificationStatusView: View {
    @EnvironmentObject private var authSession: AuthSession
    @EnvironmentObject private var pushRegistrationCenter: PushRegistrationCenter

    var body: some View {
        VStack(spacing: 20) {
            if case .signedIn(let user) = authSession.state {
                Text(user.displayName ?? user.email)
                    .font(.headline)
            }

            permissionSection

            ReceivedAlertsPlaceholderView(count: pushRegistrationCenter.receivedCount)

            Button("ログアウト") {
                authSession.signOut()
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .task {
            await pushRegistrationCenter.requestPermissionAndRegister()
        }
    }

    @ViewBuilder
    private var permissionSection: some View {
        switch pushRegistrationCenter.permissionState {
        case .notRequested, .requesting:
            ProgressView("通知の許可を確認しています…")
        case .granted:
            registrationSection
        case .denied:
            // 再許可への誘導UIは作らない(プロンプト範囲外) — 状態表示のみ。
            Text("通知が許可されていません。設定アプリから通知を有効にしてください。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        case .failed(let message):
            Text("通知の許可確認でエラーが発生しました: \(message)")
                .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var registrationSection: some View {
        switch pushRegistrationCenter.registrationState {
        case .idle, .registering:
            ProgressView("端末を登録しています…")
        case .registered:
            Text("端末登録済み")
                .foregroundStyle(.green)
        case .failed(let message):
            // 自動リトライはしない(プロンプト範囲外) — エラー表示のみ。
            Text("端末登録に失敗しました: \(message)")
                .foregroundStyle(.red)
        }
    }
}
