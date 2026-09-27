import SwiftUI

@main
struct CallNowApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var auth: AuthSession
  @StateObject private var push: PushRegistrationCenter
  @StateObject private var history: AlertHistory
  init() {
    let api: any APIRequesting
    let device: any NotificationDeviceControlling
    #if DEBUG
      let testing =
        ProcessInfo.processInfo.arguments.contains("--ui-test-fixture")
        || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
      api = testing ? UITestAPI() : APIClient()
      device = testing ? UITestNotificationDevice() : NotificationDeviceController()
    #else
      api = APIClient()
      device = NotificationDeviceController()
    #endif
    let session = AuthSession(api: api)
    _auth = StateObject(wrappedValue: session)
    _push = StateObject(
      wrappedValue: PushRegistrationCenter(registry: PushDeviceRegistry(api: api), device: device))
    _history = StateObject(wrappedValue: AlertHistory(api: api))
  }
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(auth).environmentObject(push).environmentObject(history)
        .onAppear { appDelegate.pushRegistrationCenter = push }
    }
  }
}
