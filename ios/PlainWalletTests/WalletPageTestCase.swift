import UIKit
import WebKit
import XCTest
@testable import Plain_Wallet

/*
 What the tests that drive the app's wallet page share. Each test starts from a wallet page with no wallet, so they
 never run where they could wipe a real one.

 PLAINWALLET_SCREENSHOTS (passed as TEST_RUNNER_PLAINWALLET_SCREENSHOTS to xcodebuild) names a directory for snapshots
 of the wallet page in each state, on whichever simulator runs the tests.
 */
@MainActor
class WalletPageTestCase: XCTestCase {
    var window: UIWindow!, main: Main!

    override func setUp() async throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("These tests reset the wallet: simulators only")
        #endif
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = try XCTUnwrap(scene.windows.first { $0.rootViewController is Main })
        main = window.rootViewController as? Main
        try await until("the wallet page is ready") { self.main.ready }
        try await js("localStorage.clear()")
        main.ready = false
        main.wallet.reload()
        try await until("the wallet page is ready again") { self.main.ready }
    }

    override func tearDown() async throws {
        window?.traitOverrides.remove(UITraitPreferredContentSizeCategory.self)
        window?.frame = window.windowScene!.coordinateSpace.bounds
    }

    /** Sets the text size, as if in Settings, and waits until the address bar and the wallet page have it. */
    func textSize(_ size: UIContentSizeCategory) async throws {
        window.traitOverrides.preferredContentSizeCategory = size
        window.layoutIfNeeded()
        XCTAssertEqual(main.traitCollection.preferredContentSizeCategory, size)
        try await pageTextSize()
        main.view.layoutIfNeeded()
    }

    /** The wallet page's root font is body text's 14 pt at the current text size. */
    func pageTextSize() async throws {
        let size = UIFontMetrics(forTextStyle: .body).scaledValue(for: 14, compatibleWith: main.traitCollection)
        let root = "return getComputedStyle(document.documentElement).fontSize"
        try await until("the wallet page's text is \(size)px") { abs((Double((try? await self.js(root))?.dropLast(2) ?? "") ?? 0) - size) < 0.01 }
    }

    /** Runs `body` as a function's in the wallet page (whose content security policy rules out eval); what it returns, as text. */
    @discardableResult
    func js(_ body: String) async throws -> String {
        let until = "const until = async (f) => { for (let i = 0; i < 300; i++) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) } throw new Error('timed out') }\n"
        let result = try await main.wallet.callAsyncJavaScript(until + body, contentWorld: .page)
        return result.map { "\($0)" } ?? ""
    }

    func until(_ what: String, _ check: () async -> Bool) async throws {
        for _ in 0..<100 {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("timed out waiting until \(what)")
        throw CancellationError()
    }

    func snapshot(_ name: String) throws {
        guard let dir = ProcessInfo.processInfo.environment["PLAINWALLET_SCREENSHOTS"] else { return }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let traits = window.traitCollection
        let variant = [traits.userInterfaceStyle == .dark ? "dark" : "light", traits.preferredContentSizeCategory.isAccessibilityCategory ? "ax" : nil,
                       traits.layoutDirection == .rightToLeft ? "rtl" : nil].compactMap { $0 }.joined(separator: "-")
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(variant).png"))
    }
}
