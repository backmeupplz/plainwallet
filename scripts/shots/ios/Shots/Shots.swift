import XCTest

// The installed Plain Wallet in one language, from a fresh install, for the store screenshots: scripts/shots/ios.sh
// runs it once per language. SHOTS_LANG is the app's language, SHOTS_DIR where the PNGs go:
// 1 the wallet with favorite sites, 2 a site's permit approval, 3 a site in the browser, 4 sending, 5 the password that
// keeps the keys on the device. SHOTS_ONLY=3 takes just shot 3, starring only its site.
final class Shots: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    lazy var dir = URL(fileURLWithPath: env["SHOTS_DIR"]!)
    let app = XCUIApplication(bundleIdentifier: "com.borodutch.plainwallet")
    let sites = ["app.uniswap.org", "app.aave.com", "veydrift.com", "metamask.github.io/test-dapp/"]

    /// The wallet's page: the app adds it after the browser's, which lies under it while it shows, and VoiceOver skips
    /// whichever is hidden
    var web: XCUIElement { app.webViews.element(boundBy: max(app.webViews.count - 1, 0)) }

    func save(_ name: String) {
        sleep(2)
        try! XCUIScreen.main.screenshot().pngRepresentation.write(to: dir.appendingPathComponent(name + ".png"))
        try! app.debugDescription.write(to: dir.appendingPathComponent(name + ".txt"), atomically: true, encoding: .utf8)
    }

    func wait(_ e: XCUIElement, _ what: String, _ timeout: TimeInterval = 20) -> XCUIElement {
        XCTAssert(e.waitForExistence(timeout: timeout), what)
        return e
    }

    /// Loads a site from the address bar, typing it again while the bar shows another one: on a busy machine the typing
    /// can miss the field and leave the last site loaded
    func open(_ site: String) {
        let host = String(site.split(separator: "/")[0])
        for _ in 0..<3 {
            let field = wait(app.textFields.firstMatch, "address bar")
            field.tap()
            if !app.keyboards.firstMatch.waitForExistence(timeout: 3) { field.tap() } // the first tap can land while the wallet still has it
            type(field, site + "\n")
            sleep(10)
            if ((app.textFields.firstMatch.value as? String) ?? "").contains(host) { return }
        }
    }

    /// Types a key at a time: in Arabic one fast typeText only gets its first few characters into the field
    func type(_ field: XCUIElement, _ text: String) {
        for c in text { field.typeText(String(c)) }
    }

    /// Taps the address bar's star (just past the address's end) or wallet button (at the screen's end edge), mirrored
    /// right to left. By position: listing a busy site's elements to find them takes minutes.
    func tapBar(star: Bool) {
        let field = app.textFields.firstMatch.frame, width = app.windows.firstMatch.frame.width
        let x = star ? (rtl ? field.minX - 22 : field.maxX + 22) : (rtl ? 30 : width - 30)
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: field.midY)).tap()
    }

    var rtl: Bool { env["SHOTS_LANG"] == "ar" }

    /// veydrift.com's strip about its token sale, which ends November 5, 2026: dated, and in English on every locale
    static let siteCSS = ".auction-banner { display: none !important } :root { --auction-banner-h: 0px !important }"

    func testShots() throws {
        let lang = env["SHOTS_LANG"] ?? "en"
        // an English keyboard: the language's own one (Arabic's) can't type the password and addresses
        app.launchArguments = ["-AppleLanguages", "(\(lang))", "-AppleLocale", lang.replacingOccurrences(of: "-", with: "_"),
                               "-AppleKeyboards", "(en_US@sw=QWERTY;hw=Automatic)", "-AppleKeyboardsExpanded", "1"]
        app.launchEnvironment["SHOTS_SITE_CSS"] = Self.siteCSS // ios.sh's build puts it on every site (PlainWallet.swift)
        app.launch()
        let only3 = env["SHOTS_ONLY"] == "3"
        let starred = only3 ? [sites[2]] : Array(sites.prefix(3))
        wait(web.buttons.firstMatch, "start", 90).tap() // a new wallet (the first launch is slow while other simulators run)
        for i in 0..<2 {
            let field = wait(web.secureTextFields.element(boundBy: i), "password \(i)")
            field.tap()
            type(field, "correct horse battery staple")
            XCTAssertEqual((field.value as? String)?.count, 28, "password \(i) typed")
        }
        // put the keyboard away (its bar's last button) and scroll back to the top
        if let done = app.toolbars.firstMatch.buttons.allElementsBoundByIndex.last { done.tap() }
        sleep(1)
        web.swipeDown()
        save("5")
        web.buttons.element(boundBy: web.buttons.count - 1).tap() // the seed phrase
        sleep(2)
        web.buttons.element(boundBy: web.buttons.count - 2).tap() // saved it: create the wallet
        sleep(3)

        // Favorite sites, starred in the browser
        for site in starred {
            open(site)
            tapBar(star: true)
            sleep(1)
        }
        // the wallet with the three favorites: a star tapped while a site still settles can go unheard, so the missing
        // ones are starred again. A favorite is a tile: a button labeled with just the site (any text containing it, as
        // before, passed with a tile missing and starred a found one off again)
        let favorite = { (site: String) in self.web.buttons.matching(NSPredicate(format: "label == %@", site)).firstMatch.exists }
        for _ in 0..<3 {
            tapBar(star: false)
            sleep(3)
            let missing = starred.filter { !favorite($0) }
            if missing.isEmpty { break }
            tapBar(star: false) // back to the browser
            sleep(2)
            for site in missing {
                open(site)
                tapBar(star: true)
                sleep(2)
            }
        }
        XCTAssert(starred.allSatisfy(favorite), "favorites")
        // the last favorite, loaded, with its star filled (taken before the check, it could catch the site mid-load
        // with a star that hadn't registered yet)
        open(sites[2])
        sleep(8)
        save("3")
        if only3 { return }
        tapBar(star: false)
        sleep(3)
        XCTAssert(starred.allSatisfy(favorite), "favorites")
        save("1")

        // Sending
        let buttons = web.buttons
        buttons.element(boundBy: buttons.count - 1).tap()
        sleep(2)
        save("4-empty")
        let fields = web.textFields
        if fields.count >= 2 {
            fields.element(boundBy: 0).tap()
            type(fields.element(boundBy: 0), "0x8ba1f109551bD432803012645Ac136ddd64DBA72")
            fields.element(boundBy: 1).tap()
            type(fields.element(boundBy: 1), "0.25")
            web.staticTexts.firstMatch.tap()
        }
        save("4")
        web.buttons.allElementsBoundByIndex.max { $0.frame.minY < $1.frame.minY }!.tap() // close: the sheet's lowest button
        sleep(1)

        // A permit a site asks for
        open(sites[3])
        save("2-site")
        wait(app.buttons.matching(NSPredicate(format: "label ==[c] 'connect'")).firstMatch, "Connect").tap()
        sleep(3)
        save("2-connect")
        web.buttons.element(boundBy: web.buttons.count - 1).tap() // approve the connection
        sleep(3)
        // the Sign button under the dapp's "Sign Permit" heading
        let heading = wait(app.staticTexts["Sign Permit"], "Sign Permit").frame.minY
        app.buttons.matching(NSPredicate(format: "label ==[c] 'sign'")).allElementsBoundByIndex
            .filter { $0.frame.minY > heading }.min { $0.frame.minY < $1.frame.minY }!.tap()
        sleep(4)
        save("2")
    }
}
