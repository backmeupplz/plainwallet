package com.github.backmeupplz.plainwallet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.text.TextUtils;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Scanner;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * An address bar over two WebViews: the browser, where sites get Plain Wallet's provider, and the wallet page (the
 * extension's background and popup in one page, entrypoints/android), shown over it as the home screen and for
 * approvals. This class only relays between them; it tells the wallet each request's origin as the WebView reports it.
 * The browser has a WebView profile of its own, which gives sites their own renderer process and storage, apart from
 * the unlocked wallet's.
 */
@SuppressLint("RequiresFeature") // onCreate checks for the WebView features before using any of them
public class MainActivity extends Activity {
    // The wallet page's origin, served from the APK's assets; the browser never loads it (see web()).
    static final String WALLET_HOST = "appassets.androidplatform.net";
    static final String WALLET = "https://" + WALLET_HOST;
    // Older WebViews have renderer bugs that are public by now. Raise this with each release.
    static final int MIN_WEBVIEW = 140;
    // Away from the app longer than this (the screen off counts), the wallet locks.
    static final long LOCK_AFTER_MS = 60_000;
    // What entrypoints/android-inpage.ts sends first, exactly; and the most a site may send at once.
    static final String HELLO = "{\"hello\":true}";
    static final int MAX_MESSAGE = 1_000_000;

    WebView wallet, browser;
    LinearLayout root, bar; // bar: hidden until there is a wallet
    FrameLayout views;
    EditText address;
    ImageButton star;
    ProgressBar progress;
    String url; // the page the browser shows: its committed address, never one still loading
    String icon, iconFor; // that page's favicon as a PNG data URL, and the page it came from
    JavaScriptReplyProxy walletPort, pagePort; // pagePort: the page in the browser, once its script said hello
    final List<String> queued = new ArrayList<>(); // for the wallet page until it's ready
    final Map<Integer, JavaScriptReplyProxy> waiting = new HashMap<>(); // request number -> the page that asked
    int requests;
    boolean approving; // the wallet came up for an approval, not because you opened it
    boolean prompting; // a fingerprint prompt is showing
    long hiddenAt; // SystemClock.elapsedRealtime() when the app left the screen; 0 while it's on it

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(this);
        if (webView == null || major(webView.versionName) < MIN_WEBVIEW
                || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            TextView update = new TextView(this);
            update.setText("Plain Wallet needs Android System WebView " + MIN_WEBVIEW + " or newer. Update it from the Play Store.");
            setContentView(update);
            return;
        }

        // Debug builds only: lets Chrome DevTools (chrome://inspect) attach to both WebViews for testing.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        wallet = new WebView(this) {
            // Nothing typed into the wallet (seed phrases, passwords, addresses) is for the keyboard to learn.
            @Override
            public InputConnection onCreateInputConnection(EditorInfo info) {
                InputConnection connection = super.onCreateInputConnection(info);
                info.imeOptions |= EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
                return connection;
            }
        };
        setUp(wallet);
        // Kept from autofill (which could offer to save the wallet password to an online account), from accessibility
        // services that aren't accessibility tools (Android 14+), and from taps passed through another app's window.
        wallet.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        if (Build.VERSION.SDK_INT >= 34) wallet.setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES);
        wallet.setFilterTouchesWhenObscured(true);
        wallet.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            // Links (Settings, DeBank, chainlist.org) open in the browser: this page holds the unlocked session and
            // pending approvals, so it never navigates away.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                open(request.getUrl().toString());
                return true;
            }

            // The wallet's own renderer died: start over, locked.
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (!isChangingConfigurations()) recreate();
                return true;
            }
        });
        WebViewCompat.addWebMessageListener(wallet, "plainwalletNative", Set.of(WALLET), (view, message, origin, mainFrame, reply) -> {
            if (mainFrame && message.getType() == WebMessageCompat.TYPE_STRING) fromWallet(message.getData(), reply);
        });
        browser = newBrowser();

        // A browser's address bar: a rounded field showing whose page it is (all of the address while you edit), the
        // star inside it; empty on the wallet, which is the new-tab page here.
        address = new EditText(this);
        address.setBackground(null);
        address.setSingleLine();
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        address.setHint("Search or type web address");
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setOnEditorActionListener((v, action, event) -> {
            go(v.getText().toString());
            return true;
        });
        address.setOnFocusChangeListener((v, focused) -> {
            showAddress();
            if (focused) address.selectAll();
        });
        address.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
            if (r - l != oldR - oldL && !address.hasFocus()) v.post(this::showAddress); // re-fit the host
        });
        star = new ImageButton(this, null, android.R.attr.borderlessButtonStyle);
        star.setScaleType(ImageButton.ScaleType.CENTER);
        star.setContentDescription("Favorite this site");
        star.setOnClickListener(v -> toWallet(json("type", "star")));
        starred(false);
        LinearLayout field = new LinearLayout(this);
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(getColor(R.color.sheet));
        pill.setCornerRadius(dp(22));
        field.setBackground(pill);
        field.setGravity(Gravity.CENTER_VERTICAL);
        field.setPadding(dp(16), 0, 0, 0);
        field.addView(address, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        field.addView(star, new LinearLayout.LayoutParams(dp(44), dp(44)));
        ImageButton home = new ImageButton(this, null, android.R.attr.borderlessButtonStyle);
        home.setImageResource(R.mipmap.icon);
        home.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        home.setPadding(dp(8), dp(8), dp(8), dp(8));
        home.setContentDescription("Wallet");
        home.setOnClickListener(v -> {
            if (wallet.getVisibility() == View.VISIBLE && url != null) showWallet(false);
            else openWallet();
        });
        bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(12), dp(6), dp(4), dp(6));
        bar.setVisibility(View.GONE);
        bar.addView(field, new LinearLayout.LayoutParams(0, dp(44), 1));
        bar.addView(home, new LinearLayout.LayoutParams(dp(52), dp(52)));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(getColor(R.color.pen)));
        progress.setVisibility(View.GONE);
        views = new FrameLayout(this);
        views.setBackgroundColor(getColor(R.color.paper));
        views.addView(browser);
        views.addView(wallet);
        views.addView(progress, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(4), Gravity.TOP));
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFocusableInTouchMode(true); // somewhere for focus to go when the address field lets go of it
        root.addView(bar);
        root.addView(views, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        // Edge to edge on every version (Android 15+ insists anyway). The status bar and address bar take the
        // wallet's blue while it shows (see showWallet); below, the pages take the keyboard and navigation bar space.
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, 0);
            views.setPadding(0, 0, 0, i.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        showWallet(true);
        wallet.loadUrl(WALLET + "/android.html?view=tab");

        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    }

    @Override
    protected void onStart() {
        super.onStart();
        // Away longer than a minute, by the phone's uptime clock (the date setting doesn't move it): locked.
        if (wallet != null && hiddenAt != 0 && SystemClock.elapsedRealtime() - hiddenAt > LOCK_AFTER_MS) toWallet(json("type", "lock"));
        hiddenAt = 0;
    }

    @Override
    protected void onStop() {
        super.onStop();
        hiddenAt = SystemClock.elapsedRealtime();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (wallet != null) fingerprint(null); // you may have set up a fingerprint meanwhile; a locked wallet asks again
    }

    // Nothing of the unlocked wallet page lingers once the activity is gone.
    @Override
    protected void onDestroy() {
        if (wallet != null) {
            wallet.destroy();
            browser.destroy();
        }
        super.onDestroy();
    }

    @Override
    @SuppressLint("GestureBackNavigation") // Android 11 and 12 only; newer ones use the callback in onCreate
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        back();
    }

    void back() {
        if (wallet.getVisibility() != View.VISIBLE) {
            if (browser.canGoBack()) browser.goBack();
            else openWallet();
        } else if (url != null) showWallet(false); // which rejects what's waiting there (see showWallet)
        else if (approving) toWallet(json("type", "back"));
        else moveTaskToBack(true); // not finish(): that would drop the unlocked session
    }

    /** The browser WebView, in a profile of its own: its own renderer process and storage, apart from the wallet's. */
    WebView newBrowser() {
        ProfileStore.getInstance().getOrCreateProfile("web");
        WebView view = new WebView(this);
        WebViewCompat.setProfile(view, "web"); // before anything else is done with it
        setUp(view);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return request.isForMainFrame() && !web(request.getUrl());
            }

            // The wallet's origin only exists in the wallet WebView: nothing in the browser may load it, frames and
            // fetches included.
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return WALLET_HOST.equalsIgnoreCase(request.getUrl().getHost())
                        ? new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]))
                        : null;
            }

            @Override
            public void doUpdateVisitedHistory(WebView v, String committed, boolean reload) {
                url = committed;
                page();
            }

            // Only the sites' renderer died (a site can run it out of memory): a fresh browser, the wallet as it was.
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                replaceBrowser();
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView v, String title) {
                page();
            }

            // For favorites: re-encoded here, so the wallet page only ever gets a small PNG, and tied to its page.
            @Override
            public void onReceivedIcon(WebView v, Bitmap favicon) {
                ByteArrayOutputStream png = new ByteArrayOutputStream();
                Bitmap.createScaledBitmap(favicon, 64, 64, true).compress(Bitmap.CompressFormat.PNG, 100, png);
                icon = "data:image/png;base64," + Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP);
                iconFor = url;
                page();
            }

            @Override
            public void onProgressChanged(WebView v, int percent) {
                progress.setProgress(percent);
                progress.setVisibility(percent < 100 && wallet.getVisibility() != View.VISIBLE ? View.VISIBLE : View.GONE);
            }

            // Sites get no dialogs: Android would draw them over the wallet too, titled with whatever frame asked.
            @Override
            public boolean onJsAlert(WebView v, String frame, String message, JsResult result) {
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String frame, String message, JsResult result) {
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String frame, String message, String value, JsPromptResult result) {
                result.cancel();
                return true;
            }

            @Override
            public boolean onJsBeforeUnload(WebView v, String frame, String message, JsResult result) {
                result.confirm();
                return true;
            }
        });
        WebViewCompat.addDocumentStartJavaScript(view, asset("android-inpage.js"), Set.of("*"));
        // Every frame gets the object; only top-level pages are heard, as in the extension, and only with text of a
        // sane size. The origin is the WebView's; the page only supplies the request, which goes to the wallet as-is.
        WebViewCompat.addWebMessageListener(view, "plainwalletNative", Set.of("*"), (v, message, origin, mainFrame, reply) -> {
            if (!mainFrame || message.getType() != WebMessageCompat.TYPE_STRING) return;
            String data = message.getData();
            if (data == null || data.length() > MAX_MESSAGE || WALLET.equalsIgnoreCase(origin.toString())) return;
            if (data.equals(HELLO)) {
                pagePort = reply;
                return;
            }
            waiting.put(++requests, reply);
            toWallet(json("type", "request", "n", requests, "origin", origin.toString(), "title", v.getTitle(), "data", data));
        });
        return view;
    }

    /** A fresh, blank browser in place of one whose renderer died; the wallet keeps its session and approvals. */
    void replaceBrowser() {
        views.removeView(browser);
        browser.destroy();
        pagePort = null;
        waiting.clear();
        url = icon = iconFor = null;
        browser = newBrowser();
        views.addView(browser, 0);
        toWallet(json("type", "page", "url", "", "title", ""));
        openWallet();
    }

    void fromWallet(String data, JavaScriptReplyProxy reply) {
        try {
            JSONObject msg = new JSONObject(data);
            switch (msg.getString("type")) {
                case "ready":
                    walletPort = reply;
                    setup(msg.getBoolean("setup"));
                    fingerprint(null);
                    for (String m : queued) reply.postMessage(m);
                    queued.clear();
                    break;
                case "reply": // to the page that asked, unless the browser has moved on to another site since
                    JavaScriptReplyProxy page = waiting.remove(msg.getInt("n"));
                    if (page != null && msg.getString("origin").equals(origin(url))) page.postMessage(msg.getString("data"));
                    break;
                case "event":
                    if (pagePort != null && msg.getString("origin").equals(origin(url))) pagePort.postMessage(msg.getString("data"));
                    break;
                case "show":
                    if (wallet.getVisibility() != View.VISIBLE) {
                        approving = true;
                        showWallet(true);
                    }
                    break;
                case "hide":
                    if (approving) showWallet(false);
                    break;
                case "open":
                    open(msg.getString("url"));
                    break;
                case "starred":
                    starred(msg.getBoolean("on"));
                    break;
                case "setup":
                    setup(msg.getBoolean("done"));
                    break;
                case "fingerprint-enable":
                    enableFingerprint(msg.getString("key"));
                    break;
                case "fingerprint-disable":
                    forgetFingerprint();
                    fingerprint(null);
                    break;
                case "fingerprint-unlock":
                    unlockWithFingerprint();
                    break;
            }
        } catch (JSONException ignored) {
        }
    }

    void toWallet(String msg) {
        if (walletPort == null) queued.add(msg);
        else walletPort.postMessage(msg);
    }

    /** The browser shows a new page, or learned its title or icon. */
    void page() {
        if (url == null) return;
        if (!address.hasFocus()) showAddress();
        toWallet(json("type", "page", "url", url, "title", browser.getTitle(), "icon", url.equals(iconFor) ? icon : null));
    }

    void showAddress() {
        boolean home = wallet.getVisibility() == View.VISIBLE || url == null;
        star.setVisibility(home ? View.GONE : View.VISIBLE);
        if (home) address.setText("");
        else if (address.hasFocus()) address.setText(url);
        else {
            // Only whose page it is: no user info, path or query, and cut from the left when it doesn't fit, since the
            // end of a hostname is the part that says whose it is.
            Uri u = Uri.parse(url);
            String host = u.getHost() == null ? url
                    : ("https".equals(u.getScheme()) ? "" : u.getScheme() + "://") + u.getHost() + (u.getPort() == -1 ? "" : ":" + u.getPort());
            int width = address.getWidth() - address.getTotalPaddingLeft() - address.getTotalPaddingRight();
            address.setText(width > 0 ? TextUtils.ellipsize(host, address.getPaint(), width, TextUtils.TruncateAt.START) : host);
        }
    }

    void starred(boolean on) {
        star.setImageResource(on ? R.drawable.star : R.drawable.star_border);
        star.setImageTintList(ColorStateList.valueOf(getColor(on ? R.color.pen : R.color.muted)));
    }

    /** Before there is a wallet, there's only the wallet page: no address bar, no browser. */
    void setup(boolean done) {
        bar.setVisibility(done ? View.VISIBLE : View.GONE);
        if (!done) {
            forgetFingerprint(); // a reset wallet's key opens nothing
            showWallet(true);
        }
    }

    // Fingerprint unlock: the vault key (what the wallet page keeps in memory while unlocked), encrypted under an
    // Android Keystore key that needs a strong biometric for every use and dies when fingerprints are added or removed.
    static final String FINGERPRINT = "fingerprint"; // the Keystore alias and the preferences file holding iv + data

    SharedPreferences stored() {
        return getSharedPreferences(FINGERPRINT, MODE_PRIVATE);
    }

    /** Tells the wallet page whether it can offer fingerprint unlock, and why the last attempt failed, if it did. */
    void fingerprint(String error) {
        boolean available = getSystemService(BiometricManager.class).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                == BiometricManager.BIOMETRIC_SUCCESS;
        toWallet(json("type", "fingerprint", "available", available, "enabled", available && stored().contains("data"), "error", error));
    }

    static String why(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    void enableFingerprint(String key) {
        try {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(FINGERPRINT, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(true)
                    .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    .setInvalidatedByBiometricEnrollment(true)
                    .setUnlockedDeviceRequired(true)
                    .build());
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, generator.generateKey());
            prompt("Turn on fingerprint unlock", cipher, done -> {
                byte[] data = done.doFinal(key.getBytes(StandardCharsets.UTF_8));
                stored().edit().putString("iv", Base64.encodeToString(done.getIV(), Base64.NO_WRAP))
                        .putString("data", Base64.encodeToString(data, Base64.NO_WRAP)).apply();
                fingerprint(null);
            });
        } catch (GeneralSecurityException e) {
            fingerprint(why(e));
        }
    }

    void unlockWithFingerprint() {
        // Only for the wallet you're looking at: never a prompt over a site.
        if (prompting || wallet.getVisibility() != View.VISIBLE || !stored().contains("data")) return;
        try {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            SecretKey key = (SecretKey) keys.getKey(FINGERPRINT, null);
            if (key == null) throw new KeyPermanentlyInvalidatedException(); // e.g. the screen lock was removed
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(stored().getString("iv", ""), Base64.NO_WRAP)));
            prompt("Unlock Plain Wallet", cipher, done -> toWallet(json("type", "fingerprint-key",
                    "key", new String(done.doFinal(Base64.decode(stored().getString("data", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8))));
        } catch (KeyPermanentlyInvalidatedException e) {
            forgetFingerprint();
            fingerprint("Fingerprints or the screen lock on this phone changed, so fingerprint unlock is off. Unlock with your password and turn it on again in Settings.");
        } catch (GeneralSecurityException | IOException e) {
            fingerprint(why(e));
        }
    }

    void forgetFingerprint() {
        stored().edit().clear().apply();
        try {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            keys.deleteEntry(FINGERPRINT);
        } catch (GeneralSecurityException | IOException ignored) {
        }
    }

    interface Unlocked {
        void run(Cipher cipher) throws GeneralSecurityException;
    }

    /** The system's fingerprint dialog; the cipher only works once it succeeds. */
    void prompt(String title, Cipher cipher, Unlocked then) {
        prompting = true;
        new BiometricPrompt.Builder(this)
                .setTitle(title)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButton("Use password", getMainExecutor(), (dialog, which) -> prompting = false)
                .build()
                .authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), getMainExecutor(),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                prompting = false;
                                try {
                                    then.run(result.getCryptoObject().getCipher());
                                } catch (GeneralSecurityException e) {
                                    fingerprint(why(e));
                                }
                            }

                            @Override
                            public void onAuthenticationError(int code, CharSequence message) {
                                prompting = false;
                                boolean dismissed = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED
                                        || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                                if (!dismissed) fingerprint(message.toString());
                            }
                        });
    }

    void go(String text) {
        String t = text.trim();
        if (t.isEmpty()) return;
        // A seed phrase or private key must never become a search: typed or pasted here, it would go to a website.
        String[] words = t.split("\\s+");
        if (t.matches("(?i)(0x)?[0-9a-f]{64}")
                || (Set.of(12, 15, 18, 21, 24).contains(words.length) && t.matches("(?i)[a-z]{3,8}(\\s+[a-z]{3,8})*"))) {
            address.setText("");
            Toast.makeText(this, "That looks like a seed phrase or private key. Never type it into a website.", Toast.LENGTH_LONG).show();
            return;
        }
        // An address, or else a search. Backslashes make Android and the WebView read an address differently: search.
        boolean typed = !t.contains("\\") && !t.contains(" ");
        open(typed && t.matches("(?i)https?://\\S+") ? t : typed && t.contains(".") ? "https://" + t : "https://duckduckgo.com/?q=" + Uri.encode(t));
        address.clearFocus();
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(address.getWindowToken(), 0);
    }

    void open(String link) {
        if (link.contains("\\") || !web(Uri.parse(link))) return;
        browser.loadUrl(link);
        showWallet(false);
    }

    void openWallet() {
        showWallet(true);
        toWallet(json("type", "shown"));
    }

    void showWallet(boolean on) {
        boolean was = wallet.getVisibility() == View.VISIBLE;
        wallet.setVisibility(on ? View.VISIBLE : View.GONE);
        browser.setVisibility(on ? View.GONE : View.VISIBLE);
        if (on) progress.setVisibility(View.GONE);
        else approving = false;
        // Leaving the wallet is like closing the extension's approval window: what's waiting there is rejected, so it
        // can't come back later under another site's request. Coming to it, its consent buttons wait a moment again.
        if (was && !on) toWallet(json("type", "back"));
        if (on && !was) toWallet(json("type", "visible"));
        // The wallet's screens (seed phrases, keys, balances) stay out of screenshots, screen recordings and the recents
        // thumbnail, and other apps' overlays are hidden while it shows. The blue band says it is the wallet: a website
        // can draw anything in its own area, but not up there.
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 31) getWindow().setHideOverlayWindows(on);
        root.setBackgroundColor(getColor(on ? R.color.wallet : R.color.paper));
        boolean darkIcons = !on && (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES;
        getWindow().getInsetsController().setSystemBarsAppearance(darkIcons ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
        address.clearFocus();
        showAddress();
    }

    /** Only http(s) sites, never the wallet page's own origin. */
    static boolean web(Uri uri) {
        return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) && !WALLET_HOST.equalsIgnoreCase(uri.getHost());
    }

    /** Serialized like the WebView reports origins: scheme://host[:port], the default port left out. */
    static String origin(String url) {
        if (url == null) return "";
        Uri u = Uri.parse(url);
        return u.getScheme() + "://" + u.getHost() + (u.getPort() == -1 ? "" : ":" + u.getPort());
    }

    static int major(String version) {
        try {
            return Integer.parseInt(version.split("\\.")[0]);
        } catch (RuntimeException e) {
            return 0;
        }
    }

    void setUp(WebView view) {
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
    }

    String asset(String name) {
        try (InputStream in = getAssets().open(name); Scanner s = new Scanner(in, "UTF-8")) {
            return s.useDelimiter("\\A").next();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    static String json(Object... pairs) {
        try {
            JSONObject o = new JSONObject();
            for (int i = 0; i < pairs.length; i += 2) o.put((String) pairs[i], pairs[i + 1]);
            return o.toString();
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }
    }

    int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
