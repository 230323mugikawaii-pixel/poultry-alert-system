import SwiftUI

struct RootView: View {
    @EnvironmentObject private var authSession: AuthSession

    var body: some View {
        switch authSession.state {
        case .signedOut, .signingIn, .failed:
            LoginView()
        case .signedIn:
            NotificationStatusView()
        }
    }
}
