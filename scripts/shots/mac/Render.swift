import AppKit
import WebKit

/*
 Render <url> <script> <out dir>   (built and run by scripts/shots/mac.sh, with -AppleLanguages to pick the language)
 One WebKit view, the engine of the Mac app's window and of Safari's extension popup, in a window nobody sees, from
 fresh storage. <script> runs at the start of every page it loads and drives
 it through `webkit.messageHandlers.shots`: {type: 'size', width, height} sizes the view in points, {type: 'shot', name}
 writes what it shows to <out dir>/<name>.png at twice that (Retina), {type: 'log', text} prints, and {type: 'done',
 error?} ends the run, failing it on an error. A run that hasn't ended after five minutes fails.
 */

final class Render: NSObject, NSApplicationDelegate, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let args = CommandLine.arguments
    lazy var out = URL(fileURLWithPath: args[3])
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 720), styleMask: [.borderless], backing: .buffered, defer: false)
    var web: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let script = try! String(contentsOfFile: args[2], encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "shots")
        web = WKWebView(frame: window.contentLayoutRect, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.contentView = web
        // WebKit holds back the timers of a page it can't see, off screen or under another window: this one is above
        // every other, at the screen's corner, and fully transparent, so it neither shows nor takes clicks
        window.alphaValue = 0
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.setFrameOrigin(NSScreen.main?.frame.origin ?? .zero)
        window.orderFrontRegardless()
        web.load(URLRequest(url: URL(string: args[1])!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { self.finish("no done after five minutes") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { print("loaded", webView.url?.absoluteString ?? "") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish("loading: \(error)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish("loading: \(error)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish("the page's process ended") }

    func finish(_ error: String?) {
        if let error { FileHandle.standardError.write(Data((error + "\n").utf8)) }
        exit(error == nil ? 0 : 1)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let body = message.body as? [String: Any] ?? [:]
        switch body["type"] as? String {
        case "log":
            print(body["text"] as? String ?? "")
            replyHandler(nil, nil)
        case "size":
            window.setContentSize(NSSize(width: body["width"] as! Double, height: body["height"] as! Double))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { replyHandler(nil, nil) } // the page lays out again
        case "shot":
            shot(body["name"] as! String) { replyHandler($0 == nil ? true : nil, $0) }
        case "done":
            replyHandler(nil, nil)
            finish(body["error"] as? String)
        default:
            replyHandler(nil, "unknown message")
        }
    }

    /// The view at twice its size in points, drawn into a bitmap of exactly that size
    func shot(_ name: String, _ done: @escaping (String?) -> Void) {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = true
        web.takeSnapshot(with: config) { image, error in
            guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return done("snapshot: \(String(describing: error))") }
            let size = self.web.bounds.size, w = Int(size.width * 2), h = Int(size.height * 2)
            guard cg.width >= w else { return done("snapshot is \(cg.width) px wide, not \(w): not Retina") }
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                       isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSGraphicsContext.current!.imageInterpolation = .high
            NSGraphicsContext.current!.cgContext.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            NSGraphicsContext.restoreGraphicsState()
            do {
                try rep.representation(using: .png, properties: [:])!.write(to: self.out.appendingPathComponent(name + ".png"))
                print("shot", name)
                done(nil)
            } catch {
                done("writing \(name).png: \(error)")
            }
        }
    }
}

setlinebuf(stdout)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.appearance = NSAppearance(named: .aqua) // light, as on the phones' shots, whatever the Mac is set to
let render = Render()
app.delegate = render
app.run()
