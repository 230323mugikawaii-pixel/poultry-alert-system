import AuthenticationServices
import XCTest
@testable import CallNow

final class NativeLinkProofTests: XCTestCase {
    func testRFC7636S256Vector() {
        let proof = NativeLinkProof(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(proof.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testRandomVerifierIsURLSafeAndUnique() throws {
        let first = try NativeLinkProof.generate()
        let second = try NativeLinkProof.generate()
        XCTAssertEqual(first.verifier.count, 43)
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertNotNil(first.verifier.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
    }
    func testBootstrapMustUseConfiguredAPIAndExpectedProviderPath() throws {
        let base = URL(string: "https://api.example")!
        XCTAssertNoThrow(try NativeLinkProof.bootstrapURL("https://api.example/api/v1/auth/identities/google/link/browser?handoff=opaque", provider: "google", apiBase: base))
        for url in ["https://attacker.example/api/v1/auth/identities/google/link/browser", "https://api.example/api/v1/auth/identities/microsoft/link/browser", "http://api.example/api/v1/auth/identities/google/link/browser", "https://user@api.example/api/v1/auth/identities/google/link/browser"] {
            XCTAssertThrowsError(try NativeLinkProof.bootstrapURL(url, provider: "google", apiBase: base))
        }
    }
    func testCallbackBindingAndPendingNotLoginSuccess() throws {
        let code = String(repeating: "a", count: 43)
        let valid = "com.callnow.app://auth-callback?result=link_pending&loginProvider=GOOGLE&code=\(code)"
        XCTAssertEqual(try NativeLinkProof.completionCode(URL(string: valid)!, provider: "google"), code)
        for invalid in [valid.replacingOccurrences(of: "link_pending", with: "success"), valid.replacingOccurrences(of: "GOOGLE", with: "MICROSOFT"), valid.replacingOccurrences(of: "auth-callback", with: "wrong-host"), valid + "&code=duplicate"] {
            XCTAssertThrowsError(try NativeLinkProof.completionCode(URL(string: invalid)!, provider: "google"))
        }
    }
    func testIdentityDecodingIgnoresUnusedFields() throws {
        let data = Data(#"{"identities":[{"provider":"GOOGLE","email":null,"linkedAt":"unused"}]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(IdentitiesResponse.self, from: data).identities, [LinkedIdentity(provider: "GOOGLE", email: nil)])
    }
}

@MainActor
final class IdentityLinkSessionTests: XCTestCase {
    func testSingleStartAndFinalizeThenReload() async {
        let api = MockLinkAPI(); let browser = MockLinkBrowser()
        let model = IdentityLinkSession(api: api, browser: browser, apiBase: URL(string: "https://api.example")!)
        await model.startLink(provider: .google)
        await model.startLink(provider: .google)
        XCTAssertEqual(api.starts, 1)
        XCTAssertTrue(model.isLinking)
        XCTAssertNil(model.successMessage)
        browser.complete()
        browser.complete() // Duplicate callback must not issue a second finalize.
        await settle { !model.isLinking }
        XCTAssertEqual(api.finalizes, 1)
        XCTAssertEqual(api.finalizedChallenge, api.challenge)
        XCTAssertEqual(model.identities.map(\.provider), ["GOOGLE"])
        XCTAssertNotNil(model.successMessage)
        XCTAssertNil(model.errorMessage)
    }
    func testDismissedFlowIgnoresLateCallback() async {
        let api = MockLinkAPI(); let browser = MockLinkBrowser()
        let model = IdentityLinkSession(api: api, browser: browser, apiBase: URL(string: "https://api.example")!)
        await model.startLink(provider: .google)
        model.cancel()
        browser.complete()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(api.finalizes, 0)
        XCTAssertFalse(model.isLinking)
        XCTAssertNil(model.successMessage)
        XCTAssertEqual(browser.cancellations, 1)
    }
    func testProviderMismatchDoesNotFinalize() async {
        let api = MockLinkAPI(); let browser = MockLinkBrowser()
        let model = IdentityLinkSession(api: api, browser: browser, apiBase: URL(string: "https://api.example")!)
        await model.startLink(provider: .google)
        browser.complete(provider: "MICROSOFT")
        await settle { !model.isLinking }
        XCTAssertEqual(api.finalizes, 0)
        XCTAssertNotNil(model.errorMessage)
    }
    func testFinalizeFailureIsNotReportedAsSuccess() async {
        let api = MockLinkAPI(); api.failure = APIError.codedServer(status: 409, code: "LOGIN_IDENTITY_ALREADY_IN_USE")
        let browser = MockLinkBrowser()
        let model = IdentityLinkSession(api: api, browser: browser, apiBase: URL(string: "https://api.example")!)
        await model.startLink(provider: .google)
        browser.complete()
        await settle { !model.isLinking }
        XCTAssertNil(model.successMessage)
        XCTAssertEqual(model.errorMessage, AuthSession.errorMessage(for: "LOGIN_IDENTITY_ALREADY_IN_USE"))
        XCTAssertEqual(api.loads, 0)
    }
    func testUserCancellationDoesNotFinalizeOrShowFailure() async {
        let api = MockLinkAPI(); let browser = MockLinkBrowser()
        let model = IdentityLinkSession(api: api, browser: browser, apiBase: URL(string: "https://api.example")!)
        await model.startLink(provider: .google)
        browser.completion?(nil, NSError(domain: ASWebAuthenticationSessionError.errorDomain, code: ASWebAuthenticationSessionError.canceledLogin.rawValue))
        await settle { !model.isLinking }
        XCTAssertEqual(api.finalizes, 0)
        XCTAssertNil(model.errorMessage)
    }
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Native link mock completion timed out")
    }
}

@MainActor
private final class MockLinkAPI: IdentityLinkAPI {
    var starts = 0; var finalizes = 0; var loads = 0
    var challenge: String?; var finalizedChallenge: String?
    var failure: Error?
    func identities() async throws -> [LinkedIdentity] {
        loads += 1
        return [LinkedIdentity(provider: "GOOGLE", email: "synthetic@example.com")]
    }
    func start(provider: String, challenge: String) async throws -> String {
        starts += 1; self.challenge = challenge
        return "https://api.example/api/v1/auth/identities/\(provider)/link/browser?handoff=synthetic"
    }
    func finalize(provider: String, code: String, verifier: String) async throws {
        finalizes += 1
        finalizedChallenge = NativeLinkProof(verifier: verifier).challenge
        if let failure { throw failure }
    }
}

@MainActor
private final class MockLinkBrowser: IdentityLinkBrowser {
    var completion: ((URL?, Error?) -> Void)?
    var cancellations = 0
    func start(url: URL, completion: @escaping (URL?, Error?) -> Void) -> Bool {
        self.completion = completion
        return true
    }
    func cancel() { cancellations += 1 }
    func complete(provider: String = "GOOGLE") {
        completion?(URL(string: "com.callnow.app://auth-callback?result=link_pending&loginProvider=\(provider)&code=\(String(repeating: "a", count: 43))"), nil)
    }
}
