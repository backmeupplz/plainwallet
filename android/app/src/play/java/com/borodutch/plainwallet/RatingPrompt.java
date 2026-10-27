package com.borodutch.plainwallet;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import java.time.LocalDate;
import java.util.Map;

/**
 * Google Play's own rating card, and nothing of ours around it: asked for when you close a transaction's success
 * screen, once 3 transactions were confirmed there and the app was used on 3 different days, the first at least 3 days
 * ago. At most twice per install, the second time at least 120 days after the first and on a newer version: Play never
 * says whether you rated, so this cap is how a no counts. The counts stay on the phone. The F-Droid
 * build has no Google code, and asks nothing (src/fdroid).
 */
final class RatingPrompt {
    static SharedPreferences stored(Context context) {
        return context.getSharedPreferences("rating", Context.MODE_PRIVATE);
    }

    /** The app came on screen: today is a day it was used. */
    static void opened(Context context) {
        SharedPreferences s = stored(context);
        long today = LocalDate.now().toEpochDay();
        if (s.getLong("last", -1) == today) return;
        s.edit().putLong("first", s.getLong("first", today)).putLong("last", today).putLong("days", s.getLong("days", 0) + 1).apply();
    }

    /** You closed the success screen of a confirmed transaction. */
    static void confirmed(Activity activity) {
        SharedPreferences s = stored(activity);
        s.edit().putLong("confirmed", s.getLong("confirmed", 0) + 1).apply();
        long today = LocalDate.now().toEpochDay(), version;
        try {
            version = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).getLongVersionCode();
        } catch (PackageManager.NameNotFoundException e) {
            return;
        }
        if (!due(s.getAll(), today, version)) return;
        s.edit().putLong("asked", s.getLong("asked", 0) + 1).putLong("askedOn", today).putLong("askedVersion", version).apply();
        ReviewManager manager = ReviewManagerFactory.create(activity);
        manager.requestReviewFlow().addOnSuccessListener(info -> manager.launchReviewFlow(activity, info));
    }

    /** Whether to ask now, on `today` (epoch day) with this versionCode. */
    static boolean due(Map<String, ?> s, long today, long version) {
        long asked = n(s, "asked");
        return n(s, "days") >= 3 && today - n(s, "first") >= 3 && n(s, "confirmed") >= 3
                && (asked == 0 || asked == 1 && today - n(s, "askedOn") >= 120 && version > n(s, "askedVersion"));
    }

    static long n(Map<String, ?> s, String key) {
        Object v = s.get(key);
        return v instanceof Long ? (Long) v : 0;
    }
}
