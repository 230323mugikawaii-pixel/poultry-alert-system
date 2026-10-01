import SwiftUI

struct LinkedAccountsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var link = IdentityLinkSession()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("同じCall Nowアカウントに、別のログイン方法を追加できます。メール監視の接続とは別の設定です。")
                        .foregroundStyle(.secondary)
                    if link.isLoading { ProgressView("一覧を確認しています…") }
                    ForEach(link.identities, id: \.provider) { identity in
                        VStack(alignment: .leading) {
                            Text("連携済み: \(identity.provider == "GOOGLE" ? "Google" : identity.provider == "MICROSOFT" ? "Microsoft" : identity.provider)")
                                .font(.headline)
                            if let email = identity.email { Text(email).foregroundStyle(.secondary) }
                        }
                    }
                    ForEach([AuthSession.Provider.google, .microsoft], id: \.rawValue) { provider in
                        if !link.identities.contains(where: { $0.provider == provider.rawValue.uppercased() }) {
                            Button("\(provider == .google ? "Google" : "Microsoft")を追加") {
                                Task { await link.startLink(provider: provider) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(link.isLoading || link.isLinking || link.errorMessage != nil)
                        }
                    }
                    if link.isLinking { ProgressView("認証・連携を確認しています…") }
                    if let message = link.successMessage { Text(message).foregroundStyle(.green) }
                    if let message = link.errorMessage { Text(message).foregroundStyle(.red) }
                    Button("一覧を再読み込み") { Task { await link.reload() } }
                        .disabled(link.isLinking || link.isLoading)
                }
                .padding()
            }
            .navigationTitle("ログイン方法を管理")
            .toolbar { Button("閉じる") { dismiss() } }
            .task { await link.reload() }
            .onDisappear { link.cancel() }
        }
    }
}
