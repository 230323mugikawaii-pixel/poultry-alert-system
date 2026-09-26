import SwiftUI

@main
struct CallNowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var authSession: AuthSession
    @StateObject private var pushRegistrationCenter: PushRegistrationCenter

    init() {
        let api = APIClient()
        let session = AuthSession(api: api)
        let registrationCenter = PushRegistrationCenter(api: api, authSession: session)
        _authSession = StateObject(wrappedValue: session)
        _pushRegistrationCenter = StateObject(wrappedValue: registrationCenter)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authSession)
                .environmentObject(pushRegistrationCenter)
                .onAppear {
                    appDelegate.pushRegistrationCenter = pushRegistrationCenter
                }
        }
    }
}
