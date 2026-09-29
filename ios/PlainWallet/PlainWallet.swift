import ImageIO
import LocalAuthentication
import UIKit
import WebKit

/*
 The iOS app, following the Android one (android/app/src/main/java/com/borodutch/plainwallet/MainActivity.java): an
 address bar over two web views. The browser, where sites get Plain Wallet's provider, and the wallet page (the
 extension's background and popup in one page, entrypoints/android, the same bundle as Android's), shown over it as the
 home screen and for approvals. This only relays between them; it tells the wallet each request's origin as WebKit
 reports it. The browser keeps its own website data store, which gives sites their own web process and storage, apart
 from the unlocked wallet's.
 */

@main
final class App: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = Scene.self
        return config
    }

    // Third-party keyboards can send what's typed to whoever made them: seed phrases and passwords get Apple's.
    func application(_ application: UIApplication,
                     shouldAllowExtensionPointIdentifier id: UIApplication.ExtensionPointIdentifier) -> Bool {
        id != .keyboard
    }
}

final class Scene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    let main = Main()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        window = UIWindow(windowScene: scene as! UIWindowScene)
        window!.rootViewController = main
        window!.makeKeyAndVisible()
    }

    func sceneWillResignActive(_ scene: UIScene) { main.active(false) }
    func sceneDidBecomeActive(_ scene: UIScene) { main.active(true) }
    func sceneDidEnterBackground(_ scene: UIScene) { main.hiddenAt = Main.now() }
    func sceneWillEnterForeground(_ scene: UIScene) { main.returned() }
}

final class Main: UIViewController, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate,
    WKUIDelegate, UITextFieldDelegate {
    // The wallet page's scheme, served from the app's bundle (Assets); only the wallet web view knows it.
    static let scheme = "plainwallet"
    static let walletPage = URL(string: "plainwallet://app/android.html?view=tab")!
    // The browser's website data: apart from the wallet's (the default store), and kept between launches.
    static let sites = UUID(uuidString: "0B5C1D5E-6A0F-4E7B-9C1A-5D0F3A2B8E41")!
    // Away from the app longer than this (the screen off counts), the wallet locks.
    static let lockAfter: UInt64 = 60 * 1_000_000_000
    // What entrypoints/android-inpage.ts sends first, exactly; and the most a site may send at once.
    static let hello = "{\"hello\":true}"
    static let maxMessage = 1_000_000

    var wallet: WKWebView!, browser: WKWebView!
    let bar = UIStackView(), address = UITextField(), star = UIButton(type: .system), home = UIButton()
    let views = UIView(), progress = UIProgressView(progressViewStyle: .bar), cover = UIView()
    var url: URL? // the page the browser shows: its committed address, never one still loading
    var icon: String?, iconFor: URL? // that page's favicon as a PNG data URL, and the page it came from
    var observers: [NSKeyValueObservation] = []
    var ready = false, queued: [String] = [] // for the wallet page until it's ready
    var waiting: [Int: (Any?, String?) -> Void] = [:] // request number -> the page that asked
    var requests = 0
    var approving = false // the wallet came up for an approval, not because you opened it
    var prompting = false // a Face ID prompt is showing
    var inactive = false, returning = false
    var hiddenAt: UInt64 = 0 // Main.now() when the app left the screen; 0 while it's on it

    override func viewDidLoad() {
        super.viewDidLoad()
        wallet = newWallet()
        browser = newBrowser()

        // A browser's address bar: a rounded field showing whose page it is (all of the address while you edit), the
        // star inside it; empty on the wallet, which is the new-tab page here.
        address.placeholder = "Search or type web address"
        address.font = .systemFont(ofSize: 16)
        address.keyboardType = .webSearch
        address.returnKeyType = .go
        address.autocapitalizationType = .none
        address.autocorrectionType = .no
        address.spellCheckingType = .no
        address.clearButtonMode = .whileEditing
        address.delegate = self
        star.accessibilityLabel = "Favorite this site"
        star.addAction(UIAction { [unowned self] _ in toWallet(["type": "star"]) }, for: .primaryActionTriggered)
        starred(false)
        let field = UIStackView(arrangedSubviews: [address, star])
        field.backgroundColor = Self.sheet
        field.layer.cornerRadius = 22
        field.isLayoutMarginsRelativeArrangement = true
        field.directionalLayoutMargins = .init(top: 0, leading: 16, bottom: 0, trailing: 0)
        home.configuration = .plain()
        home.configuration!.image = UIImage(named: "Mark")
        home.configuration!.contentInsets = .init(top: 6, leading: 6, bottom: 6, trailing: 6)
        home.accessibilityLabel = "Wallet"
        home.addAction(UIAction { [unowned self] _ in
            if !wallet.isHidden && url != nil { showWallet(false) } else { openWallet() }
        }, for: .primaryActionTriggered)
        bar.addArrangedSubview(field)
        bar.addArrangedSubview(home)
        bar.spacing = 4
        bar.alignment = .center
        bar.isLayoutMarginsRelativeArrangement = true
        bar.directionalLayoutMargins = .init(top: 6, leading: 12, bottom: 6, trailing: 6)
        bar.isHidden = true // until there is a wallet

        progress.progressTintColor = Self.pen
        progress.isHidden = true
        let mark = UIImageView(image: UIImage(named: "Mark"))
        mark.contentMode = .scaleAspectFit
        cover.addSubview(mark)
        mark.translatesAutoresizingMaskIntoConstraints = false
        cover.backgroundColor = Self.walletBlue
        cover.isHidden = true
        views.backgroundColor = Self.paper
        for v in [browser!, wallet!, cover] { fill(views, with: v) }
        views.addSubview(progress)
        progress.translatesAutoresizingMaskIntoConstraints = false
        let column = UIStackView(arrangedSubviews: [bar, views])
        column.axis = .vertical
        view.addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            field.heightAnchor.constraint(equalToConstant: 44),
            { let c = bar.heightAnchor.constraint(equalToConstant: 56); c.priority = .required - 1; return c }(), // 0 while hidden
            star.widthAnchor.constraint(equalToConstant: 44),
            home.widthAnchor.constraint(equalToConstant: 48), home.heightAnchor.constraint(equalToConstant: 48),
            mark.centerXAnchor.constraint(equalTo: cover.centerXAnchor), mark.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            mark.widthAnchor.constraint(equalToConstant: 96), mark.heightAnchor.constraint(equalToConstant: 96),
            progress.topAnchor.constraint(equalTo: views.topAnchor),
            progress.leadingAnchor.constraint(equalTo: views.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: views.trailingAnchor),
            // The status bar and address bar take the wallet's blue while it shows (see showWallet); the pages go
            // down to the screen's edge and keep clear of the home indicator themselves.
            column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        browser.isHidden = true
        showWallet(true)
        // Screen recording and mirroring show the cover rather than the wallet (iOS can't keep it out of screenshots).
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (self: Main, _: UITraitCollection) in self.covered() }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { wallet?.isHidden == false ? .lightContent : .default }

    func active(_ on: Bool) {
        inactive = !on
        covered()
        // Back in the app: you may have set up Face ID meanwhile; a locked wallet asks again.
        if on && returning {
            returning = false
            fingerprint(nil)
        }
    }

    func returned() {
        // Away longer than a minute, by a clock that counts sleep and that the date setting doesn't move: locked.
        if hiddenAt != 0 && Self.now() - hiddenAt > Self.lockAfter { toWallet(["type": "lock"]) }
        hiddenAt = 0
        returning = true
    }

    static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    /** The wallet's screens (seed phrases, keys, balances) stay out of the app switcher and screen recordings. */
    func covered() {
        #if DEBUG
        let captured = false // debug builds are open to inspection anyway, and get recorded for store screenshots
        #else
        let captured = traitCollection.sceneCaptureState == .active
        #endif
        cover.isHidden = wallet.isHidden || !(captured || (inactive && !prompting))
    }

    func newWallet() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(Assets(), forURLScheme: Self.scheme)
        // What entrypoints/android-shim.ts talks to; answers come back through its onmessage (see deliver).
        config.userContentController.addUserScript(WKUserScript(source: """
            window.plainwalletNative = { platform: 'ios', postMessage: (s) => webkit.messageHandlers.plainwalletNative.postMessage(s) }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "plainwalletNative")
        let view = WKWebView(frame: .zero, configuration: config)
        setUp(view)
        view.allowsLinkPreview = false
        // Down to the screen's edge, dialogs' backdrops too; the page keeps clear of the home indicator (style.css).
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.load(URLRequest(url: Self.walletPage))
        return view
    }

    /** The browser, with a website data store of its own: its own web process and storage, apart from the wallet's. */
    func newBrowser() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.sites)
        // The Android bridge (entrypoints/android-inpage.ts) on WebKit's messaging: requests go up, the answer to each
        // comes back to the page that asked; the app pushes chainChanged / accountsChanged through onmessage.
        let bridge = """
            (() => {
              const handler = window.webkit.messageHandlers.plainwalletNative
              const native = { postMessage: (s) => handler.postMessage(s).then((r) => typeof r === 'string' && native.onmessage?.({ data: r }), () => {}) }
              window.plainwalletNative = native
            })();
            """
        let inpage = try! String(contentsOf: Bundle.main.url(forResource: "android-inpage", withExtension: "js", subdirectory: "web")!, encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: bridge + inpage, injectionTime: .atDocumentStart,
                                                                forMainFrameOnly: true, in: .page))
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "plainwalletNative")
        let view = WKWebView(frame: .zero, configuration: config)
        setUp(view)
        view.allowsBackForwardNavigationGestures = true
        observers = [
            // Same-page changes (history.pushState); a new page counts once it's committed (see didCommit).
            view.observe(\.url) { [unowned self] v, _ in
                if let u = v.url, let o = Self.origin(u), o == Self.origin(url) {
                    url = u
                    page()
                }
            },
            view.observe(\.title) { [unowned self] _, _ in page() },
            view.observe(\.estimatedProgress) { [unowned self] v, _ in
                progress.setProgress(Float(v.estimatedProgress), animated: true)
                progress.isHidden = v.estimatedProgress >= 1 || !wallet.isHidden
            },
        ]
        return view
    }

    /** A fresh, blank browser in place of one whose web process died; the wallet keeps its session and approvals. */
    func replaceBrowser() {
        browser.configuration.userContentController.removeAllScriptMessageHandlers()
        browser.removeFromSuperview()
        observers = []
        for reply in waiting.values { reply(nil, nil) }
        waiting = [:]
        url = nil
        icon = nil
        iconFor = nil
        browser = newBrowser()
        browser.isHidden = true
        fill(views, with: browser, at: 0)
        toWallet(["type": "page", "url": "", "title": ""])
        openWallet()
    }

    // From the wallet page.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === wallet, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == Self.scheme,
              let data = (message.body as? String)?.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch msg["type"] as? String {
        case "ready":
            ready = true
            setup(msg["setup"] as? Bool == true)
            fingerprint(nil)
            queued.forEach(deliver)
            queued = []
        case "reply": // to the page that asked, unless the browser has moved on to another site since
            if let n = msg["n"] as? Int, let reply = waiting.removeValue(forKey: n) {
                reply(msg["origin"] as? String == pageOrigin() ? msg["data"] as? String : nil, nil)
            }
        case "event":
            if let data = msg["data"] as? String, msg["origin"] as? String == pageOrigin() {
                browser.callAsyncJavaScript("window.plainwalletNative?.onmessage?.({ data })", arguments: ["data": data],
                                            in: nil, in: .page)
            }
        case "show":
            if wallet.isHidden {
                approving = true
                showWallet(true)
            }
        case "hide":
            if approving { showWallet(false) }
        case "open":
            if let link = msg["url"] as? String { open(link) }
        case "starred":
            starred(msg["on"] as? Bool == true)
        case "setup":
            setup(msg["done"] as? Bool == true)
        case "fingerprint-enable":
            if let key = msg["key"] as? String { enableFingerprint(key) }
        case "fingerprint-disable":
            forgetFingerprint()
            fingerprint(nil)
        case "fingerprint-unlock":
            unlockWithFingerprint()
        default:
            break
        }
    }

    // From pages in the browser. Top-level pages only, as in the extension, and only text of a sane size. The origin is
    // WebKit's; the page only supplies the request, which goes to the wallet as-is.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === browser, message.frameInfo.isMainFrame, let data = message.body as? String,
              data.utf8.count <= Self.maxMessage, data != Self.hello,
              let origin = Self.origin(message.frameInfo.securityOrigin) else { return replyHandler(nil, nil) }
        requests += 1
        waiting[requests] = replyHandler
        toWallet(["type": "request", "n": requests, "origin": origin, "title": browser.title ?? "", "data": data])
    }

    /** `msg` without its nil values, as JSON, for entrypoints/android-shim.ts. */
    func toWallet(_ msg: [String: Any?]) {
        let data = String(decoding: try! JSONSerialization.data(withJSONObject: msg.compactMapValues { $0 }), as: UTF8.self)
        if ready { deliver(data) } else { queued.append(data) }
    }

    func deliver(_ data: String) {
        wallet.callAsyncJavaScript("plainwalletNative.onmessage({ data })", arguments: ["data": data], in: nil, in: .page)
    }

    /** The browser shows a new page, or learned its title or icon. */
    func page() {
        guard let url else { return }
        if !address.isFirstResponder { showAddress() }
        toWallet(["type": "page", "url": url.absoluteString, "title": browser.title ?? "", "icon": url == iconFor ? icon : nil])
    }

    func pageOrigin() -> String? { Self.origin(url) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let link = action.request.url else { return decisionHandler(.cancel) }
        if webView === wallet {
            // Links (Settings, DeBank, chainlist.org) open in the browser: this page holds the unlocked session and
            // pending approvals, so it never navigates away.
            if link.scheme == Self.scheme { return decisionHandler(.allow) }
            decisionHandler(.cancel)
            open(link.absoluteString)
        } else {
            // Pages are web pages only; frames load what they like, which can't be the wallet (its scheme isn't here).
            decisionHandler(action.targetFrame?.isMainFrame == false || Self.web(link) ? .allow : .cancel)
        }
    }

    // Links that ask for a new window open in the one browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let link = action.request.url?.absoluteString { open(link) }
        return nil
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === browser else { return }
        url = webView.url
        page()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === browser { fetchIcon() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === browser { return replaceBrowser() } // a site can run its process out of memory
        // The wallet's own process died: start over, locked.
        ready = false
        queued = []
        for reply in waiting.values { reply(nil, nil) }
        waiting = [:]
        wallet.load(URLRequest(url: Self.walletPage))
    }

    // Sites get no dialogs: WebKit shows none unless this delegate draws them, and it doesn't.

    /** For favorites: the page's icon, fetched and re-encoded here, so the wallet page only ever gets a small PNG. */
    func fetchIcon() {
        guard let page = url, let host = page.host() else { return }
        let find = "[...document.querySelectorAll('link[rel~=\"apple-touch-icon\" i]'), ...document.querySelectorAll('link[rel~=\"icon\" i]')].map((l) => l.href)"
        browser.evaluateJavaScript(find, in: nil, in: .defaultClient) { [weak self] result in
            let links = ((try? result.get()) as? [String] ?? []) + ["https://\(host)/favicon.ico"]
            Task { @MainActor [weak self] in
                for case let link? in links.prefix(5).map(URL.init(string:)) where link.scheme == "https" {
                    guard let png = await Self.icon(link) else { continue }
                    self?.icon = "data:image/png;base64," + png.base64EncodedString()
                    self?.iconFor = page
                    self?.page()
                    return
                }
            }
        }
    }

    static let fetcher: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = 10
        return URLSession(configuration: config)
    }()

    /** A 64×64 PNG of the image at `link`, reading at most 1 MB of it and never decoding it at full size. */
    static func icon(_ link: URL) async -> Data? {
        guard let (bytes, _) = try? await fetcher.bytes(from: link) else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > 1_000_000 { return nil }
            }
        } catch { return nil }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                                                          kCGImageSourceThumbnailMaxPixelSize: 64] as CFDictionary)
        else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64), format: format).pngData { _ in
            UIImage(cgImage: image).draw(in: CGRect(x: 0, y: 0, width: 64, height: 64))
        }
    }

    // The address bar.
    func textFieldDidBeginEditing(_ field: UITextField) {
        showAddress()
        DispatchQueue.main.async { field.selectAll(nil) }
    }

    func textFieldDidEndEditing(_ field: UITextField) { showAddress() }

    func textFieldShouldReturn(_ field: UITextField) -> Bool {
        go(field.text ?? "")
        return false
    }

    func showAddress() {
        let homeScreen = !wallet.isHidden || url == nil
        star.isHidden = homeScreen
        guard let url, !homeScreen else { return address.text = "" }
        if address.isFirstResponder { return address.text = url.absoluteString }
        // Only whose page it is: no user info, path or query, and cut from the left when it doesn't fit, since the end
        // of a hostname is the part that says whose it is.
        let scheme = url.scheme ?? ""
        let host = url.host().map { (scheme == "https" ? "" : scheme + "://") + $0 + (url.port.map { ":\($0)" } ?? "") } ?? url.absoluteString
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingHead
        address.attributedText = NSAttributedString(string: host, attributes: [.paragraphStyle: style, .font: address.font!])
    }

    func starred(_ on: Bool) {
        star.setImage(UIImage(systemName: on ? "star.fill" : "star"), for: .normal)
        star.tintColor = on ? Self.pen : Self.muted
    }

    func go(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return }
        // A seed phrase or private key must never become a search: typed or pasted here, it would go to a website.
        let words = t.split(whereSeparator: \.isWhitespace).count
        if Self.matches(t, "(0x)?[0-9a-f]{64}") || ([12, 15, 18, 21, 24].contains(words) && Self.matches(t, "[a-z]{3,8}(\\s+[a-z]{3,8})*")) {
            address.text = ""
            let alert = UIAlertController(title: nil, message: "That looks like a seed phrase or private key. Never type it into a website.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            return present(alert, animated: true)
        }
        // An address, or else a search. Backslashes make URL parsers disagree about what an address means: search.
        let typed = !t.contains("\\") && !t.contains(" ")
        open(typed && Self.matches(t, "https?://\\S+") ? t : typed && t.contains(".") ? "https://" + t
             : "https://duckduckgo.com/?q=" + (t.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""))
        address.resignFirstResponder()
    }

    static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: "^(?:\(pattern))$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    func open(_ link: String) {
        guard !link.contains("\\"), let u = URL(string: link), Self.web(u) else { return }
        browser.load(URLRequest(url: u))
        showWallet(false)
    }

    func openWallet() {
        showWallet(true)
        toWallet(["type": "shown"])
    }

    func showWallet(_ on: Bool) {
        let was = !wallet.isHidden
        wallet.isHidden = !on
        browser.isHidden = on
        if on { progress.isHidden = true } else { approving = false }
        // Leaving the wallet is like closing the extension's approval window: what's waiting there is rejected, so it
        // can't come back later under another site's request. Coming to it, its consent buttons wait a moment again.
        if was && !on { toWallet(["type": "back"]) }
        if on && !was { toWallet(["type": "visible"]) }
        // The blue band says it is the wallet: a website can draw anything in its own area, but not up there.
        view.backgroundColor = on ? Self.walletBlue : Self.paper
        setNeedsStatusBarAppearanceUpdate()
        address.resignFirstResponder()
        covered()
        showAddress()
    }

    /** Before there is a wallet, there's only the wallet page: no address bar, no browser. */
    func setup(_ done: Bool) {
        bar.isHidden = !done
        if !done {
            forgetFingerprint() // a reset wallet's key opens nothing
            showWallet(true)
        }
    }

    // Face ID (or Touch ID) unlock: the vault key (what the wallet page keeps in memory while unlocked), kept in the
    // Keychain on this device only, behind the Face ID enrolled now: changing Face ID, or removing the passcode,
    // makes it unreadable.
    static let keychain: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.borodutch.plainwallet.unlock",
                                            kSecAttrAccount: "vault key"]

    func biometry() -> (available: Bool, name: String) {
        let context = LAContext()
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return (available, context.biometryType == .touchID ? "Touch ID" : context.biometryType == .opticID ? "Optic ID" : "Face ID")
    }

    func stored() -> Bool {
        let context = LAContext()
        context.interactionNotAllowed = true
        var query = Self.keychain
        query[kSecUseAuthenticationContext] = context
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    /** Tells the wallet page whether it can offer Face ID unlock, and why the last attempt failed, if it did. */
    func fingerprint(_ error: String?) {
        let (available, name) = biometry()
        toWallet(["type": "fingerprint", "available": available, "enabled": available && stored(), "name": name, "error": error])
    }

    static func why(_ status: OSStatus) -> String { SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)" }

    /** The system's Face ID prompt; `then` runs on the main queue with the context it authenticated, only if it did. */
    func authenticate(_ reason: String, then: @escaping (LAContext) -> Void) {
        prompting = true
        let context = LAContext()
        context.localizedFallbackTitle = "" // no passcode: the wallet's password is the other way in
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
            DispatchQueue.main.async { [self] in
                prompting = false
                covered()
                if ok { return then(context) }
                let code = (error as? LAError)?.code
                if ![.userCancel, .systemCancel, .appCancel, .userFallback].contains(code) { fingerprint(error?.localizedDescription) }
            }
        }
    }

    func enableFingerprint(_ key: String) {
        authenticate("Turn on \(biometry().name) unlock") { [self] _ in
            SecItemDelete(Self.keychain as CFDictionary)
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil)
            else { return fingerprint("This iPhone can't keep a key behind \(biometry().name)") }
            var item = Self.keychain
            item[kSecValueData] = Data(key.utf8)
            item[kSecAttrAccessControl] = access
            let status = SecItemAdd(item as CFDictionary, nil)
            fingerprint(status == errSecSuccess ? nil : Self.why(status))
        }
    }

    func unlockWithFingerprint() {
        // Only for the wallet you're looking at: never a prompt over a site.
        guard !prompting, !wallet.isHidden, stored() else { return }
        let name = biometry().name
        // The Keychain takes the Face ID you just gave (the Secure Enclave checks it's the enrolled one), without asking again.
        authenticate("Unlock Plain Wallet") { [self] context in
            var query = Self.keychain
            query[kSecReturnData] = true
            query[kSecUseAuthenticationContext] = context
            var result: CFTypeRef?
            switch SecItemCopyMatching(query as CFDictionary, &result) {
            case errSecSuccess:
                if let data = result as? Data { toWallet(["type": "fingerprint-key", "key": String(decoding: data, as: UTF8.self)]) }
            case errSecUserCanceled:
                break
            case errSecItemNotFound, errSecAuthFailed:
                forgetFingerprint()
                fingerprint("\(name) or the passcode on this iPhone changed, so \(name) unlock is off. Unlock with your password and turn it on again in Settings.")
            case let status:
                fingerprint(Self.why(status))
            }
        }
    }

    func forgetFingerprint() { SecItemDelete(Self.keychain as CFDictionary) }

    /** Only http(s) sites. */
    static func web(_ u: URL) -> Bool { ["https", "http"].contains(u.scheme?.lowercased()) }

    /** scheme://host[:port] of a web page, the default port left out, as entrypoints/android-shim.ts expects. */
    static func origin(_ o: WKSecurityOrigin) -> String? { origin(o.protocol, o.host, o.port) }
    static func origin(_ u: URL?) -> String? { u.flatMap { origin($0.scheme ?? "", $0.host() ?? "", $0.port ?? 0) } }
    static func origin(_ scheme: String, _ host: String, _ port: Int) -> String? {
        let s = scheme.lowercased()
        guard s == "https" || s == "http", !host.isEmpty else { return nil }
        return "\(s)://\(host.lowercased())" + (port == 0 || port == (s == "https" ? 443 : 80) ? "" : ":\(port)")
    }

    func setUp(_ view: WKWebView) {
        view.navigationDelegate = self
        view.uiDelegate = self
        #if DEBUG
        view.isInspectable = true // Safari's Web Inspector, on debug builds
        #endif
    }

    func fill(_ container: UIView, with v: UIView, at index: Int? = nil) {
        if let index { container.insertSubview(v, at: index) } else { container.addSubview(v) }
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([v.topAnchor.constraint(equalTo: container.topAnchor), v.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                                     v.leadingAnchor.constraint(equalTo: container.leadingAnchor), v.trailingAnchor.constraint(equalTo: container.trailingAnchor)])
    }

    // The wallet page's colors (entrypoints/popup/style.css), as in android/app/src/main/res/values*/themes.xml.
    static func color(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat(c >> 16 & 0xFF) / 255, green: CGFloat(c >> 8 & 0xFF) / 255, blue: CGFloat(c & 0xFF) / 255, alpha: 1)
        }
    }
    static let paper = color(0xF7F8FA, 0x151929), sheet = color(0xE9ECF2, 0x232941), muted = color(0x6A7390, 0x8E97B5)
    static let pen = color(0x2443C4, 0x8FA4FF), walletBlue = color(0x2443C4, 0x2443C4)
}

/** Serves the wallet page (the web build in the app's bundle) to the wallet web view, and nothing outside it. */
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
