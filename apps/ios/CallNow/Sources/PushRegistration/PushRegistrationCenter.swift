import Foundation
import UIKit
import UserNotifications

@MainActor protocol NotificationDeviceControlling {
  func requestPermission() async throws -> Bool
  func register()
  func unregister()
}
@MainActor struct NotificationDeviceController: NotificationDeviceControlling {
  func requestPermission() async throws -> Bool {
    try await UNUserNotificationCenter.current().requestAuthorization(options: [
      .alert, .sound, .badge,
    ])
  }
  func register() { UIApplication.shared.registerForRemoteNotifications() }
  func unregister() { UIApplication.shared.unregisterForRemoteNotifications() }
}
@MainActor final class PushRegistrationCenter: ObservableObject {
  @Published private(set) var enabled = false
  @Published private(set) var busy = false
  @Published private(set) var message: String?
  private let registry: any PushDeviceRegistering
  private let device: any NotificationDeviceControlling
  private let defaults: UserDefaults
  private let installationId: String
  private var principal: Principal?
  private var registration: PushDeviceRegistrationResponse?
  private var waitingForToken = false
  private var timeout: Task<Void, Never>?
  private var generation = UUID()

  init(
    registry: any PushDeviceRegistering, device: (any NotificationDeviceControlling)? = nil,
    defaults: UserDefaults = .standard
  ) {
    self.registry = registry
    self.device = device ?? NotificationDeviceController()
    self.defaults = defaults
    installationId = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
  }
  private func key(_ principal: Principal) -> String { "callnow.device.\(principal.scope)" }
  func bind(_ principal: Principal?) {
    guard self.principal != principal else { return }
    generation = UUID()
    timeout?.cancel()
    waitingForToken = false
    busy = false
    self.principal = principal
    message = nil
    registration = principal.flatMap { current in
      defaults.data(forKey: key(current)).flatMap {
        try? JSONDecoder().decode(PushDeviceRegistrationResponse.self, from: $0)
      }
    }
    enabled = registration?.status == "ACTIVE"
  }
  func enable() async {
    guard !busy, !enabled, principal != nil else { return }
    busy = true
    message = nil
    let operation = generation
    do {
      let granted = try await device.requestPermission()
      guard generation == operation else { return }
      guard granted else {
        busy = false
        message = "通知が許可されていません。iOSの設定から許可してください。履歴は引き続き閲覧できます。"
        return
      }
      waitingForToken = true
      device.register()
      timeout = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        guard !Task.isCancelled, let self, self.generation == operation, self.waitingForToken else {
          return
        }
        self.waitingForToken = false
        self.busy = false
        self.message = "端末トークンを取得できませんでした。履歴は引き続き閲覧できます。"
      }
    } catch {
      busy = false
      message = "通知の許可を確認できませんでした。"
    }
  }
  func didReceiveDeviceToken(_ token: Data) async {
    // Accept a callback only for an explicit current enable operation, once.
    guard waitingForToken, let current = principal else { return }
    waitingForToken = false
    timeout?.cancel()
    let operation = generation
    do {
      let result = try await registry.register(
        principal: current, installationId: installationId,
        token: DeviceTokenFormatter.hexString(from: token))
      // bind/logout controls are disabled while registering; still persist the
      // handle to permit revocation if an unexpected lifecycle change occurs.
      defaults.set(try JSONEncoder().encode(result), forKey: key(current))
      guard operation == generation else { return }
      registration = result
      enabled = result.status == "ACTIVE"
      message = nil
    } catch {
      guard operation == generation else { return }
      enabled = false
      message = "端末登録できません。PR06のAPI設定・接続を確認してください。"
    }
    if operation == generation { busy = false }
  }
  @discardableResult func disable() async -> Bool {
    guard !busy else { return false }
    guard let current = principal, let registration else {
      enabled = false
      return true
    }
    busy = true
    message = nil
    defer { busy = false }
    do {
      try await registry.revoke(principal: current, registration: registration)
      device.unregister()
      defaults.removeObject(forKey: key(current))
      self.registration = nil
      enabled = false
      return true
    } catch {
      message = "通知OFFをサーバーに反映できませんでした。再試行してください。"
      return false
    }
  }
  func didFailToRegisterForRemoteNotifications(_ error: Error) {
    guard waitingForToken else { return }
    timeout?.cancel()
    waitingForToken = false
    busy = false
    message = "端末トークンを取得できませんでした。実機・署名設定の確認が必要です。"
  }
}
