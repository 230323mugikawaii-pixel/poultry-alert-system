import XCTest

final class ClientFlowTests: XCTestCase {
  func testMemberLoginHistoryWhileNotificationsOffAndPlaceholderLogout() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-test-fixture"]
    app.launch()
    app.segmentedControls["loginKind"].buttons["通知メンバー"].tap()
    app.textFields["memberId"].tap()
    app.textFields["memberId"].typeText("synthetic")
    app.secureTextFields["memberPassword"].tap()
    app.secureTextFields["memberPassword"].typeText("synthetic-test-only")
    app.buttons["memberLogin"].tap()
    XCTAssertTrue(app.staticTexts["検証キーワード"].waitForExistence(timeout: 5))
    app.tabBars.buttons["設定"].tap()
    XCTAssertEqual(app.switches["notificationsToggle"].value as? String, "0")
    app.buttons["課金・契約"].tap()
    XCTAssertTrue(app.staticTexts["仕様は未確定です。この画面から契約変更・決済・解約は行いません。"].exists)
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.tabBars.buttons["履歴"].tap()
    app.buttons["refreshHistory"].tap()
    XCTAssertTrue(app.staticTexts["検証キーワード"].exists)
    app.tabBars.buttons["設定"].tap()
    app.buttons["logout"].tap()
    XCTAssertTrue(app.segmentedControls["loginKind"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["検証キーワード"].exists)
  }
}
