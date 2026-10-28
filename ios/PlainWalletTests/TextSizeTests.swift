import UIKit
import WebKit
import XCTest
@testable import Plain_Wallet

/*
 Dynamic Type: the address bar and the wallet page follow your text size as body text does. At the default size they are
 as they were; at the largest accessibility size nothing on the seed screen, the home screen, Send or an approval is cut
 off, overlaps something else or runs off the screen.
 */
@MainActor
final class TextSizeTests: WalletPageTestCase {
    static let largest = UIContentSizeCategory.accessibilityExtraExtraExtraLarge

    func testTheAddressBarAndThePageFollowTheTextSize() async throws {
        main.setup(true) // the address bar, which only shows once there is a wallet
        main.url = URL(string: "https://app.example.com/swap")
        main.showWallet(false)
        defer { main.showWallet(true); main.url = nil; main.setup(false) }

        try await textSize(.large)
        XCTAssertEqual(main.address.font?.pointSize, 16)
        XCTAssertEqual(main.address.text, "app.example.com")
        XCTAssertEqual(main.field.frame.height, 44, "the default size's address bar, as it was")
        XCTAssertEqual(main.bar.frame.height, 60)

        try await textSize(Self.largest)
        let font = try XCTUnwrap(main.address.font)
        XCTAssertGreaterThan(font.pointSize, 40)
        XCTAssertEqual(main.address.text, "app.example.com")
        XCTAssertGreaterThanOrEqual(main.address.frame.height, font.lineHeight, "the address is cut off")
        let field = main.field.convert(main.field.bounds, to: main.bar), home = main.home.convert(main.home.bounds, to: main.bar)
        XCTAssertGreaterThan(field.height, 44, "the field grows to fit the text")
        XCTAssert(main.bar.bounds.contains(field), "the bar grows to fit the field: \(field) in \(main.bar.bounds)")
        XCTAssertFalse(field.intersects(home))
        XCTAssertEqual(main.field.layer.cornerRadius, field.height / 2)
        let bar = main.bar.convert(main.bar.bounds, to: main.view), page = main.views.convert(main.views.bounds, to: main.view)
        XCTAssertLessThanOrEqual(bar.maxY, page.minY, "the bar covers the page")
        try snapshot("address-bar")

        // Changing it while you type keeps what you've typed.
        main.address.becomeFirstResponder()
        main.address.text = "plain wallet"
        try await textSize(.large)
        XCTAssertEqual(main.address.text, "plain wallet")
        XCTAssertEqual(main.address.font?.pointSize, 16)
        main.address.resignFirstResponder()
        try await textSize(Self.largest)

        // A wallet page that loads again (its web process died) starts at your size too.
        main.ready = false
        main.wallet.reload()
        try await until("the wallet page is ready again") { self.main.ready }
        try await pageTextSize()

        try await textSize(.large)
        XCTAssertEqual(main.address.font?.pointSize, 16)
        XCTAssertEqual(main.bar.frame.height, 60)
    }

    func testNothingIsCutOffOrOverlapsAtTheLargestTextSize() async throws {
        try await textSize(Self.largest)
        // A new wallet, made as you'd make one: its seed phrase first.
        try await js("""
            const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
            ;(await until(() => document.querySelector('#app > button.primary'))).click() // Generate new wallet
            const passwords = await until(() => document.querySelectorAll('#app input[type=password]').length === 2 && document.querySelectorAll('#app input[type=password]'))
            for (const input of passwords) type(input, 'text size test password')
            document.querySelector('#app button.primary').click() // Generate seed phrase
            await until(() => document.querySelectorAll('#app ol li').length === 12)
            """)
        try await laidOut("the seed screen")
        try snapshot("seed")

        try await js("""
            document.querySelector('#app button.primary').click() // I saved it, create wallet
            await until(() => document.querySelector('#app > .wallet'))
            """)
        try await laidOut("the home screen")
        try snapshot("home")

        try await js("""
            document.querySelector('.wallet button.primary').click() // Send
            const [to, amount] = await until(() => document.querySelector('dialog[open]')?.querySelectorAll('input'))
            to.value = '0x000000000000000000000000000000000000bEEF'; amount.value = '0.25'
            """)
        try await laidOut("Send")
        try snapshot("send")
        // Its review (main.ts: send), whose fee needs the network: the same slip, with its rows, in the dialog.
        let columns = try await js("""
            const dl = document.createElement('dl')
            for (const [label, value] of [['Network', 'Ethereum (1)'], ['To', '0x000000000000000000000000000000000000bEEF'],
              ['Amount', '0.25 ETH'], ['Estimated max fee', '0.000042 ETH']])
              dl.append(Object.assign(document.createElement('dt'), { textContent: label }), Object.assign(document.createElement('dd'), { textContent: value }))
            const slip = Object.assign(document.createElement('div'), { className: 'slip' })
            slip.append(dl)
            document.querySelector('dialog[open] .dialog-content').replaceChildren(slip)
            return getComputedStyle(dl).gridTemplateColumns.split(' ').length
            """)
        XCTAssertEqual(columns, "1", "in a dialog too, large text puts each label over its value")
        try await laidOut("Send's review")
        try snapshot("send-review")
        try await js("document.querySelector('dialog[open]').close()")

        // A site asks to connect, then to sign a message: the approvals, with their rows and the message.
        main.toWallet(["type": "request", "n": 1, "origin": "https://app.example.com", "title": "Example",
                       "data": #"{"id":1,"method":"eth_requestAccounts"}"#])
        let account = try await js("""
            await until(() => document.querySelector('#app .slip dl'))
            return [...document.querySelectorAll('#app .slip dt')].find((dt) => dt.textContent === 'Account').nextElementSibling.textContent
            """)
        try await laidOut("the connection approval")
        try snapshot("approval-connect")
        try await js("""
            await new Promise((r) => setTimeout(r, 1000)) // consent buttons wait for taps to stop
            ;[...document.querySelectorAll('#app button')].find((b) => b.textContent === 'Approve').click()
            await until(() => document.querySelector('#app > .wallet'))
            """)
        main.toWallet(["type": "request", "n": 2, "origin": "https://app.example.com", "title": "Example",
                       "data": #"{"id":2,"method":"personal_sign","params":["0x4c6f6720696e20746f204578616d706c652061732074686973206163636f756e742e","\#(account)"]}"#])
        try await js("await until(() => document.querySelector('#app .slip pre'))")
        try await laidOut("the signature approval")
        try snapshot("approval-sign")
    }

    /**
     Fails with whatever on the page (or the dialog open over it) runs off the screen or out of the dialog, has its text
     cut off, or overlaps something else: its controls, headings, rows and seed words, and the seed words' numbers.
     */
    func laidOut(_ screen: String) async throws {
        let problems = try await js("""
            const name = (e) => `${e.tagName} "${(e.textContent || e.value || e.placeholder || e.ariaLabel || '').trim().slice(0, 24)}"`
            const problems = [], width = document.documentElement.clientWidth
            if (document.documentElement.scrollWidth > width) problems.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`,
              ...[...document.body.querySelectorAll('*')].filter((e) => !e.matches('input, textarea') && getComputedStyle(e).display !== 'inline' && e.scrollWidth > e.clientWidth + 1)
                .map((e) => `  inside ${name(e)}: ${e.scrollWidth} > ${e.clientWidth}`))
            const scope = document.querySelector('dialog[open]') ?? document.getElementById('app'), within = scope.getBoundingClientRect()
            if (within.left < 0 || within.right > width) problems.push(`${scope.tagName} runs off the screen: ${within.left}–${within.right} of ${width}`)
            const items = [...scope.querySelectorAll('button, input:not([type=checkbox]), select, textarea, h1, h2, h3, li, dt, dd, pre, strong, summary')]
              .filter((e) => e.getClientRects().length && !e.closest('[hidden]'))
            for (const e of items) {
              const r = e.getBoundingClientRect()
              if (r.left < within.left - 0.5 || r.right > within.right + 0.5) problems.push(`${name(e)} runs out: ${r.left}–${r.right} of ${within.left}–${within.right}`)
              // Fields scroll what's typed in them; anything else that's wider inside than out is cut off.
              if (!e.matches('input, select, textarea') && getComputedStyle(e).display !== 'inline' && e.scrollWidth > e.clientWidth + 1) problems.push(`${name(e)} is cut off: ${e.scrollWidth} > ${e.clientWidth}`)
            }
            for (const [i, a] of items.entries()) for (const b of items.slice(i + 1)) {
              if (a.contains(b) || b.contains(a)) continue
              const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()]
              if (Math.min(p.right, q.right) - Math.max(p.left, q.left) > 0.5 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 0.5) problems.push(`${name(a)} and ${name(b)} overlap`)
            }
            // A seed word's number sits left of it: in the list's padding, or after the word before it on its row.
            for (const ol of scope.querySelectorAll('ol')) {
              const words = [...ol.children], start = ol.getBoundingClientRect().left + ol.clientLeft
              words.forEach((li, i) => {
                const probe = Object.assign(document.createElement('span'), { textContent: `${i + 1}. ` })
                probe.style.font = `${getComputedStyle(li, '::marker').fontSize} ${getComputedStyle(li).fontFamily}`
                probe.style.whiteSpace = 'pre'
                document.body.append(probe)
                const number = probe.getBoundingClientRect().width
                probe.remove()
                const left = li.getBoundingClientRect().left, before = words[i - 1]
                const range = document.createRange()
                if (before) range.selectNodeContents(before)
                const end = before && before.getBoundingClientRect().top === li.getBoundingClientRect().top ? range.getBoundingClientRect().right : start
                if (left - number < end - 0.5) problems.push(`seed word ${i + 1}'s number (${number}px) doesn't fit in the ${left - end}px before it`)
              })
            }
            return problems.join('\\n')
            """)
        XCTAssertEqual(problems, "", "on \(screen)")
    }
}
