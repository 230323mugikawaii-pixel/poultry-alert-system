import SwiftUI

/// Placeholder design — see prompt scope: only a Google/Microsoft choice is
/// required here, not a finished login screen.
struct LoginView: View {
    @EnvironmentObject private var authSession: AuthSession

    var body: some View {
        VStack(spacing: 24) {
            Text("Call Now")
                .font(.largeTitle.bold())

            if case .failed(let message) = authSession.state {
                Text(message)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button {
                    authSession.signIn(with: .google)
                } label: {
                    Text("Googleでログイン")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(authSession.state == .signingIn)

                Button {
                    authSession.signIn(with: .microsoft)
                } label: {
                    Text("Microsoftでログイン")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(authSession.state == .signingIn)
            }
            .padding(.horizontal, 32)

            if authSession.state == .signingIn {
                ProgressView("サインイン中…")
            }
        }
        .padding()
    }
}
