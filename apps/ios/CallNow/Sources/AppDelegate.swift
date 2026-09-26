import UIKit
import UserNotifications

/// Wires up only what this shell needs from UIApplicationDelegate: the APNs
/// device-token callback, failure reporting, and a minimal "a remote
/// notification arrived" signal. No alert content parsing, no sound or
/// vibration handling — see docs/ios/step-01-shell-implementation-results.md
/// for what's intentionally out of scope for this PR.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var pushRegistrationCenter: PushRegistrationCenter?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await pushRegistrationCenter?.didReceiveDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            pushRegistrationCenter?.didFailToRegisterForRemoteNotifications(error)
        }
    }

    // Minimal "received something" signal only — no alert payload is parsed
    // or displayed (see ReceivedAlertsPlaceholderView).
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            pushRegistrationCenter?.didReceiveRemoteNotification()
            completionHandler(.newData)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor in
            pushRegistrationCenter?.didReceiveRemoteNotification()
        }
        completionHandler([.banner, .sound, .list])
    }
}
