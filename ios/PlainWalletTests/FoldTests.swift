import UIKit
import WebKit
import XCTest
@testable import Plain_Wallet

/*
 Folding an iPhone Duo (or resizing the app on a tablet) changes its width and size class while it runs. The app's state
 lives in the wallet page (the unlocked session, a send form, an approval waiting for you) and in the browser, and only
 survives if nothing reloads or replaces them; and the page has to use a wide screen rather than stretch its column.
 These flip one window between a phone's width and an unfolded one's, and check both.
 */
@MainActor
final class FoldTests: WalletPageTestCase {
    static let phone = CGSize(width: 390, height: 844), unfolded = CGSize(width: 669, height: 951) // a Duo's inner display
    // What covers the inner display, which no simulator shows: the status pill as on the cover, in its top right corner.
    static let innerPill = CGRect(x: unfolded.width - 84, y: 0, width: 84, height: 174)

    override func tearDown() async throws {
        main?.covering = nil
        window?.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        try await super.tearDown()
    }

    func testFoldingMidTransactionKeepsTheUnlockedWalletAndTheSendForm() async throws {
        // A watch-only wallet (no keys at all), set up through the page as you would.
        try await js("""
            const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
            ;(await until(() => document.querySelectorAll('#app > button')[2])).click() // Watch an address
            const inputs = await until(() => document.querySelectorAll('#app input').length === 3 && document.querySelectorAll('#app input'))
            type(inputs[0], '0x000000000000000000000000000000000000dEaD')
            type(inputs[1], 'fold test password'); type(inputs[2], 'fold test password')
            document.querySelector('#app button.primary').click()
            await until(() => document.querySelector('#app > .wallet'))
            """)
        try await fold(.compact)
        try snapshot("home-compact")
        try await fold(.regular)
        try snapshot("home-regular")

        // Sending: the form filled in, then folded and unfolded with it open.
        try await js("""
            document.querySelector('.wallet button.primary').click()
            const [to, amount] = await until(() => document.querySelector('dialog[open]')?.querySelectorAll('input'))
            to.value = '0x000000000000000000000000000000000000bEEF'; amount.value = '0.25'
            """)
        try snapshot("send-regular")
        for size in [UIUserInterfaceSizeClass.compact, .regular, .compact] {
            try await fold(size)
            let form = try await js("return [...document.querySelector('dialog[open]')?.querySelectorAll('input') ?? []].map((i) => i.value).join()")
            let unlocked = try await js("return String(!!document.querySelector('#app > .wallet'))")
            XCTAssertEqual(form, "0x000000000000000000000000000000000000bEEF,0.25", "the send form closed or lost what was typed")
            XCTAssertEqual(unlocked, "true", "the wallet locked or left its home screen")
        }
        try snapshot("send-compact")
    }

    func testFoldingKeepsTheWalletPageTheBrowserAndTheAddressBar() async throws {
        let wallet = main.wallet!, browser = main.browser!
        try await fold(.compact)
        // A send form being filled in and a confirmation open over it, as they'd be mid-transaction.
        try await js("""
            window.folded = 'still here'
            const form = document.createElement('input'); form.id = 'draft'; form.value = '0.25'; document.getElementById('app').append(form)
            const dialog = document.createElement('dialog'); dialog.id = 'confirm'; document.body.append(dialog); dialog.showModal()
            """)
        main.setup(true) // the address bar, which only shows once there is a wallet
        main.address.becomeFirstResponder()
        main.address.text = "example.co"

        for size in [UIUserInterfaceSizeClass.regular, .compact, .regular] {
            try await fold(size)
            XCTAssert(main.wallet === wallet && main.browser === browser, "the web views were replaced")
            let marker = try await js("return folded"), draft = try await js("return document.getElementById('draft').value")
            let open = try await js("return String(document.getElementById('confirm').open)")
            XCTAssertEqual(marker, "still here", "the wallet page reloaded")
            XCTAssertEqual(draft, "0.25", "the form lost what was typed")
            XCTAssertEqual(open, "true", "the confirmation closed")
            XCTAssertEqual(main.address.text, "example.co")
            XCTAssert(main.address.isFirstResponder)
        }
        main.address.resignFirstResponder()
        main.setup(false)
    }

    func testTheHomeScreenGetsTwoColumnsWhenUnfolded() async throws {
        // The home screen's shape (main.ts: mainScreen, home), with stand-ins for its rows.
        try await js("""
            const h = (tag, cls, height) => Object.assign(document.createElement(tag), { className: cls, style: `height: ${height}px` })
            document.getElementById('app').replaceChildren(h('header', '', 32), h('nav', 'favorites', 120),
              Object.assign(h('div', 'wallet', 0), { style: '' }))
            document.querySelector('.wallet').append(h('div', '', 60), h('dl', 'balances', 200))
            """)
        // The wallet's first row: on a phone the wallet's block has no box of its own (.wallet { display: contents }).
        let place = "return JSON.stringify(['header', '.favorites', '.wallet > :first-child'].map((s) => document.querySelector(s).getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]))"

        try await fold(.compact)
        try snapshot("compact")
        var r = try JSONDecoder().decode([[Double]].self, from: Data(try await js(place).utf8))
        XCTAssertEqual(r[1][0], r[2][0], "on a phone the favorites and the wallet line up")
        XCTAssertLessThanOrEqual(r[1][3], r[2][1], "on a phone the favorites are above the wallet")

        try await fold(.regular)
        try snapshot("regular")
        XCTAssertEqual(main.edges[3].constant, Self.innerPill.width, "unfolded, the page keeps clear of the status pill")
        let wide = "return String([...document.styleSheets].flatMap((s) => [...s.cssRules]).some((r) => r.media && r.cssText.includes('.favorites') && matchMedia(r.conditionText).matches))"
        let twoColumns = try await js(wide)
        XCTAssertEqual(twoColumns, "true", "beside the pill, the page is still wide enough for two columns")
        r = try JSONDecoder().decode([[Double]].self, from: Data(try await js(place).utf8))
        XCTAssertEqual(r[1][1], r[2][1], "unfolded, the favorites are beside the wallet")
        XCTAssertGreaterThan(r[1][0], r[2][2], "unfolded, the favorites are to the wallet's right")
        XCTAssertLessThanOrEqual(r[2][2] - r[2][0], 400, "the wallet keeps a readable width")
        XCTAssertGreaterThanOrEqual(r[2][2] - r[2][0], 348)
        XCTAssertEqual(r[0][0], r[2][0], "the header lines up with the columns")
        XCTAssertEqual(r[0][2], r[1][2])

        // Right to left, the columns swap sides.
        try await js("document.documentElement.dir = 'rtl'")
        r = try JSONDecoder().decode([[Double]].self, from: Data(try await js(place).utf8))
        XCTAssertLessThan(r[1][2], r[2][0], "right to left, the favorites are to the wallet's left")
        try await js("document.documentElement.dir = ''")

        // At the largest text size the favorites' tiles stay in their column, however narrow it is for them.
        try await js("document.querySelector('.favorites').append(...[1, 2].map(() => Object.assign(document.createElement('button'), { textContent: 'Example' })))")
        try await textSize(.accessibilityExtraExtraExtraLarge)
        let outside = try await js("""
            const column = document.querySelector('.favorites').getBoundingClientRect(), page = document.documentElement
            return [...document.querySelectorAll('.favorites button')].filter((b) => b.getBoundingClientRect().right > column.right + 0.5).length + ' ' + (page.scrollWidth - page.clientWidth)
            """)
        XCTAssertEqual(outside, "0 0", "favorites outside their column, and how far the page scrolls sideways")
    }

    func testTheAddressBarAndThePageKeepClearOfTheStatusPill() async throws {
        // The iPhone Duo's: a strip down the top right corner, 84 by 174 points, with the camera in it.
        let duo = CGRect(x: 0, y: 0, width: 466, height: 678), pill = CGRect(x: 382, y: 0, width: 84, height: 174)
        let camera = CGRect(x: 399.67, y: 29.33, width: 37, height: 37)
        XCTAssertEqual(Main.insets(top: 0, clearOf: [camera, pill], in: duo), UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 84),
                       "beside the pill costs less room than below it, and the camera is inside it")
        // Short and wide (a notch, a camera at the top's middle): below it; a phone's status bar alone: below that.
        XCTAssertEqual(Main.insets(top: 20, clearOf: [CGRect(x: 180, y: 10, width: 106, height: 30)], in: duo),
                       UIEdgeInsets(top: 40, left: 0, bottom: 0, right: 0))
        XCTAssertEqual(Main.insets(top: 59, clearOf: [], in: duo), UIEdgeInsets(top: 59, left: 0, bottom: 0, right: 0))
        XCTAssertEqual(Main.insets(top: 0, clearOf: [CGRect(x: 0, y: 600, width: 40, height: 78)], in: duo),
                       UIEdgeInsets(top: 0, left: 40, bottom: 0, right: 0), "at the bottom left: beside it, not below")
        XCTAssertEqual(Main.insets(top: 0, clearOf: [Self.innerPill], in: CGRect(origin: .zero, size: Self.unfolded)),
                       UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 84), "unfolded too")

        // Unfolded, on any simulator: the address bar and the page are clear of the inner display's pill.
        main.setup(true) // the address bar, which only shows once there is a wallet
        defer { main.setup(false) }
        try await fold(.regular)
        try clear(of: [Self.innerPill])
        try snapshot("pill-regular")
        try await fold(.compact)

        // On this simulator's screen, whatever covers it (on an iPhone Duo, iOS 27.1) is clear of the address bar and pages.
        guard #available(iOS 27.1, *) else { throw XCTSkip("Reserved regions are iOS 27.1's") }
        let occluded = main.view.reservedRegions(kind: .occlusion)
        guard !occluded.isEmpty else { throw XCTSkip("Nothing covers this simulator's screen") }
        try clear(of: occluded.map(\.frame))
        try snapshot("pill")
    }

    /** The address bar and the wallet page show, and none of `occluded` covers them. */
    func clear(of occluded: [CGRect]) throws {
        main.view.layoutIfNeeded()
        for v in [main.bar, main.wallet!] {
            let frame = v.convert(v.bounds, to: main.view)
            XCTAssertGreaterThan(frame.height, 0)
            for r in occluded { XCTAssertFalse(r.intersects(frame), "\(r) covers \(v) at \(frame)") }
        }
    }

    /**
     Resizes the window to a folded or unfolded phone's, and waits until the wallet page has the new width. Unfolded is
     a Duo's inner display, with its pill; folded, on a simulator with something covering its screen (the Duo's cover
     display), is that screen as it is, and otherwise a phone's.
     */
    func fold(_ size: UIUserInterfaceSizeClass) async throws {
        let screen = window.windowScene!.coordinateSpace.bounds.size
        var covered = false
        if #available(iOS 27.1, *) { covered = !window.reservedRegions(kind: .occlusion).isEmpty }
        let frame = size == .regular ? Self.unfolded : covered ? screen : Self.phone
        main.covering = size == .regular ? [Self.innerPill] : nil
        window.traitOverrides.horizontalSizeClass = size
        window.frame = CGRect(origin: .zero, size: frame)
        window.layoutIfNeeded()
        XCTAssertEqual(main.traitCollection.horizontalSizeClass, size)
        // The window's width, less what the page keeps clear of (the Duo's status pill)
        let width = String(Int(main.wallet.bounds.width))
        XCTAssertEqual(main.wallet.bounds.width, frame.width - main.edges[1].constant - main.edges[3].constant)
        try await until("the wallet page is \(width) wide") { (try? await self.js("return innerWidth")) == width }
    }
}
