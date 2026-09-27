#if DEBUG
  /// Fail closed: UI/unit hosts never register with Apple or request real permission.
  @MainActor struct UITestNotificationDevice: NotificationDeviceControlling {
    func requestPermission() async throws -> Bool { false }
    func register() {}
    func unregister() {}
  }
#endif
