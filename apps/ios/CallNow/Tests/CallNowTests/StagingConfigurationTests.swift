import XCTest

@testable import CallNow

final class StagingConfigurationTests: XCTestCase {
  func testBundleAndCallbackAgree() {
    XCTAssertEqual(Bundle.main.bundleIdentifier, "com.callnow.poultryalert")
    XCTAssertEqual(NativePKCE.callbackScheme, "com.callnow.poultryalert")
    XCTAssertEqual(NativePKCE.redirectURI, "com.callnow.poultryalert:/oauth/callback")
    let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
    let schemes = types?.compactMap { $0["CFBundleURLSchemes"] as? [String] }.flatMap { $0 }
    XCTAssertEqual(schemes, [NativePKCE.callbackScheme])
  }

  func testConfirmedInstallationNamespace() {
    let suite = "StagingConfigurationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let id = InstallationIdentifierStore.currentOrCreate(defaults: defaults)
    XCTAssertEqual(defaults.string(forKey: "com.callnow.poultryalert.installationId"), id)
    XCTAssertEqual(InstallationIdentifierStore.currentOrCreate(defaults: defaults), id)
  }

  #if STAGING
    func testStagingConfigurationUsesExactHTTPSOriginAndNativeStartRoutes() throws {
      let origin = "https://call-now-staging-api-404996456750.asia-northeast1.run.app"
      XCTAssertEqual(AppEnvironment.apiBaseURL.absoluteString, origin)
      XCTAssertEqual(AppEnvironment.publicOrigin, origin)
      let pkce = try NativePKCE()
      for provider in ["google", "microsoft"] {
        let url = try pkce.startURL(base: AppEnvironment.apiBaseURL, provider: provider)
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, AppEnvironment.apiBaseURL.host)
        XCTAssertEqual(url.path, "/api/v1/auth/native/\(provider)/start")
        XCTAssertFalse(url.absoluteString.contains(pkce.verifier))
      }
    }
  #endif
}
