import AppKit
import SafariServices
import WebKit

/*
 The Mac app: the mobile apps' wallet page (entrypoints/android*, the extension's background and popup in one page) in a
 window, with no browser of its own; dapps in Safari use the Safari extension that ships inside this app. The page is
 served from the bundle under a `plainwallet://` scheme that only its web view knows. Its storage.local is the file it
 shares with the Safari extension (Shared/Storage.swift), so both show the same wallet; each unlocks on its own. The
 wallet locks when the Mac sleeps or its screen locks, and after 15 minutes without use unless that's turned off.
 */

@main
final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate,
    WKUIDelegate {
    static let scheme = "plainwallet"
    static let walletPage = URL(string: "plainwallet://app/android.html?view=tab")!
    static let safariExtension = "com.borodutch.plainwallet.extension"

    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 720),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    var wallet: WKWebView!
    var ready = false, queued: [String] = [] // for the wallet page until it's ready

    static func main() {
        let delegate = App()
        NSApplication.shared.delegate = delegate
        NSApplication.shared.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = menu()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(Assets(), forURLScheme: Self.scheme)
        // What entrypoints/android-shim.ts talks to; answers come back through its onmessage (see deliver).
        config.userContentController.addUserScript(WKUserScript(source: """
            window.plainwalletNative = { platform: 'macos', postMessage: (s) => webkit.messageHandlers.plainwalletNative.postMessage(s),
              storage: (msg) => webkit.messageHandlers.plainwalletStorage.postMessage(msg) }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "plainwalletNative")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "plainwalletStorage")
        wallet = WKWebView(frame: .zero, configuration: config)
        wallet.navigationDelegate = self
        wallet.uiDelegate = self
        wallet.allowsLinkPreview = false
        wallet.load(URLRequest(url: Self.walletPage))

        window.title = "Plain Wallet"
        window.contentView = wallet
        window.contentMinSize = NSSize(width: 380, height: 480)
        window.setFrameAutosaveName("Wallet")
        if !window.setFrameUsingName("Wallet") { window.center() }
        window.makeKeyAndOrderFront(nil)

        // Lock when the Mac sleeps or its screen locks: the page's own 15-minute timer doesn't run while asleep.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.toWallet(["type": "lock"]) }
        }
        DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.toWallet(["type": "lock"]) }
        }
    }

    // The page holds the unlocked session and pending approvals: closing its window quits, which locks the wallet.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === wallet, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == Self.scheme,
              let data = (message.body as? String)?.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch msg["type"] as? String {
        case "ready":
            ready = true
            queued.forEach(deliver)
            queued = []
        case "show": // an approval
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
        case "open":
            if let link = msg["url"] as? String { open(link) }
        default: // the phones' browser and fingerprint messages: there's neither here
            break
        }
    }

    // The page's storage.local (lib/shared-storage.ts).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard message.webView === wallet, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == Self.scheme else {
            return replyHandler(nil, "Not the wallet page")
        }
        replyHandler(Storage.handle(message.body), nil)
    }

    /** `msg` as JSON, for entrypoints/android-shim.ts. */
    func toWallet(_ msg: [String: Any]) {
        let data = String(decoding: try! JSONSerialization.data(withJSONObject: msg), as: UTF8.self)
        if ready { deliver(data) } else { queued.append(data) }
    }

    func deliver(_ data: String) {
        wallet.callAsyncJavaScript("plainwalletNative.onmessage({ data })", arguments: ["data": data], in: nil, in: .page)
    }

    // Links (Settings, DeBank, chainlist.org) open in the default browser: the wallet page never navigates away.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let link = action.request.url, link.scheme != Self.scheme else { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        open(link.absoluteString)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let link = action.request.url?.absoluteString { open(link) }
        return nil
    }

    func open(_ link: String) {
        guard let url = URL(string: link), ["https", "http"].contains(url.scheme?.lowercased()) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func safariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: Self.safariExtension)
    }

    func menu() -> NSMenu {
        let bar = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            bar.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
        }
        let safari = NSMenuItem(title: "Safari Extension Settings…", action: #selector(safariSettings), keyEquivalent: "")
        safari.target = self
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        add("Plain Wallet", [
            NSMenuItem(title: "About Plain Wallet", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            safari, .separator(),
            NSMenuItem(title: "Hide Plain Wallet", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit Plain Wallet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        add("Edit", [
            NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"), redo, .separator(),
            NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
        ])
        add("Window", [
            NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
            NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
        ])
        return bar
    }
}

/** Serves the wallet page (`web`, the Android build) from the bundle, and nothing outside it. */
final class Assets: NSObject, WKURLSchemeHandler {
    let root = Bundle.main.resourceURL!.appendingPathComponent("web").standardizedFileURL
    static let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                        "json": "application/json", "png": "image/png", "svg": "image/svg+xml"]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let file = root.appendingPathComponent(task.request.url?.path ?? "").standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": Self.types[file.pathExtension] ?? "application/octet-stream"])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
