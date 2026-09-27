import SwiftUI

struct LoginView: View {
  @EnvironmentObject private var auth: AuthSession
  @State private var member = false
  @State private var loginId = ""
  @State private var password = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("ログイン方法", selection: $member) {
            Text("OWNER").tag(false)
            Text("通知メンバー").tag(true)
          }.pickerStyle(.segmented).accessibilityIdentifier("loginKind")
        }
        if member {
          Section("通知メンバーのログイン") {
            TextField("Call Now ID", text: $loginId).textInputAutocapitalization(.never)
              .autocorrectionDisabled().accessibilityIdentifier("memberId")
            SecureField("パスワード", text: $password).accessibilityIdentifier("memberPassword")
            Button("メンバーとしてログイン") {
              let transient = password
              password = ""
              Task { await auth.signInMember(id: loginId, password: transient) }
            }.disabled(auth.busy || loginId.isEmpty || password.isEmpty).accessibilityIdentifier(
              "memberLogin")
          }
        } else {
          Section("OWNERのログイン") {
            ForEach(["google", "microsoft"], id: \.self) { provider in
              Button("\(provider == "google" ? "Google" : "Microsoft")でログイン") {
                Task { await auth.signIn(provider: provider) }
              }
              .disabled(auth.busy || !auth.providers.contains(provider)).accessibilityIdentifier(
                "\(provider)Login")
            }
          }
        }
        if auth.busy { ProgressView("ログイン中") }
        if let message = auth.message { Text(message).foregroundStyle(.secondary) }
        Section { Text("通知をOFFにしていても、ログイン後に通知履歴を閲覧できます。") }
      }.navigationTitle("Call Now").task { await auth.loadProviders() }
    }
  }
}
