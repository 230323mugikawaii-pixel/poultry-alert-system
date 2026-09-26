import Foundation
import UIKit
import UserNotifications

/// Owns notification permission and APNs device-token registration for this
/// shell. Nothing here inspects alert content — see
/// ReceivedAlertsPlaceholderView for the minimal "something arrived" signal
/// this PR is scoped to (real alert fetch/display is a later PR).
@MainActor
final class PushRegistrationCenter: ObservableObject {
    enum PermissionState: Equatable {
        case notRequested
        case requesting
        case granted
        case denied
        case failed(String)
    }

    enum RegistrationState: Equatable {
        case idle
        case registering
        case registered
        case failed(String)
    }

    @Published private(set) var permissionState: PermissionState = .notRequested
    @Published private(set) var registrationState: RegistrationState = .idle
    @Published private(set) var receivedCount: Int = 0

    private let api: APIClient
    private let authSession: AuthSession
    private let installationId: String

    init(api: APIClient, authSession: AuthSession, defaults: UserDefaults = .standard) {
        self.api = api
        self.authSession = authSession
        self.installationId = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
    }

    func requestPermissionAndRegister() async {
        guard permissionState == .notRequested else { return }
        permissionState = .requesting
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            permissionState = granted ? .granted : .denied
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            permissionState = .failed(error.localizedDescription)
        }
    }

    /// Called from AppDelegate once APNs hands back a device token. Sends
    /// exactly one registration attempt — deliberately no automatic retry on
    /// failure (see docs/ios/step-01-shell-implementation-results.md,
    /// "送信失敗時の自動リトライは作らない").
    func didReceiveDeviceToken(_ deviceToken: Data) async {
        guard case .signedIn = authSession.state else {
            registrationState = .failed("ログイン後にもう一度お試しください。")
            return
        }
        guard let teamId = authSession.currentTeamId else {
            registrationState = .failed("チーム情報を取得できませんでした。")
            return
        }
        registrationState = .registering
        let hexToken = DeviceTokenFormatter.hexString(from: deviceToken)
        let request = PushDeviceRegistrationRequest(installationId: installationId, deviceToken: hexToken)
        do {
            let _: PushDeviceRegistrationResponse = try await api.post(
                "/api/v1/teams/\(teamId)/push-devices",
                body: request
            )
            registrationState = .registered
        } catch {
            registrationState = .failed(error.localizedDescription)
        }
    }

    func didFailToRegisterForRemoteNotifications(_ error: Error) {
        registrationState = .failed(error.localizedDescription)
    }

    /// Minimal receipt signal only — see ReceivedAlertsPlaceholderView.
    func didReceiveRemoteNotification() {
        receivedCount += 1
    }
}
