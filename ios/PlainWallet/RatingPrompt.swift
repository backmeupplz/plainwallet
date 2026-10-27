import StoreKit
import UIKit

/*
 The App Store's own rating prompt, and nothing of ours around it, as on Android (android/app/src/play/.../RatingPrompt.java,
 whose test covers the same rule): asked for when you close a transaction's success screen, once 3 transactions were
 confirmed there and the app was used on 3 different days, the first at least 3 days ago. At most twice per install, the
 second time at least 120 days after the first and on a newer build: iOS never says whether you rated, so this cap is
 how a no counts. The counts stay on the phone.
 */
@MainActor
enum RatingPrompt {
    static let stored = UserDefaults.standard

    static func day() -> Int { Calendar.current.ordinality(of: .day, in: .era, for: Date()) ?? 0 }

    static func n(_ s: [String: Any], _ key: String) -> Int { s["rating." + key] as? Int ?? 0 }

    /** The app came on screen: today is a day it was used. */
    static func opened() {
        let today = day(), s = stored.dictionaryRepresentation()
        guard s["rating.last"] as? Int != today else { return }
        if s["rating.first"] == nil { stored.set(today, forKey: "rating.first") }
        stored.set(today, forKey: "rating.last")
        stored.set(n(s, "days") + 1, forKey: "rating.days")
    }

    /** You closed the success screen of a confirmed transaction. */
    static func confirmed(in scene: UIWindowScene?) {
        stored.set(n(stored.dictionaryRepresentation(), "confirmed") + 1, forKey: "rating.confirmed")
        // The build number, which is the Android versionCode, so it only grows.
        let today = day(), version = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
        let s = stored.dictionaryRepresentation()
        guard let scene, due(s, today: today, version: version) else { return }
        stored.set(n(s, "asked") + 1, forKey: "rating.asked")
        stored.set(today, forKey: "rating.askedOn")
        stored.set(version, forKey: "rating.askedVersion")
        AppStore.requestReview(in: scene)
    }

    /** Whether to ask now, on `today` (a day number) with this build. */
    static func due(_ s: [String: Any], today: Int, version: Int) -> Bool {
        let asked = n(s, "asked")
        return n(s, "days") >= 3 && today - n(s, "first") >= 3 && n(s, "confirmed") >= 3
            && (asked == 0 || asked == 1 && today - n(s, "askedOn") >= 120 && version > n(s, "askedVersion"))
    }
}
