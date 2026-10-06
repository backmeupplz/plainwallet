import SafariServices

// The extension's storage.local (lib/shared-storage.ts): the wallet the app shares with it.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = (context.inputItems.first as? NSExtensionItem)?.userInfo?[SFExtensionMessageKey]
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: Storage.handle(request)]
        context.completeRequest(returningItems: [response])
    }
}
