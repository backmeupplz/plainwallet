package com.github.backmeupplz.plainwallet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
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
import android.window.OnBackInvokedDispatcher;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
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
 */
@SuppressLint("RequiresFeature") // onCreate checks for both WebView features before using either
public class MainActivity extends Activity {
    // The wallet page's origin, served from the APK's assets; the browser never loads it (see web()).
    static final String WALLET_HOST = "appassets.androidplatform.net";
    static final String WALLET = "https://" + WALLET_HOST;

    WebView wallet, browser;
    LinearLayout bar; // hidden until there is a wallet
    EditText address;
    ImageButton star;
    String icon; // the browser page's favicon, as a PNG data URL
    ProgressBar progress;
    JavaScriptReplyProxy walletPort, pagePort; // pagePort: the page in the browser, once its script said hello
    final List<String> queued = new ArrayList<>(); // for the wallet page until it's ready
    final Map<Integer, JavaScriptReplyProxy> waiting = new HashMap<>(); // request number -> the page that asked
    int requests;
    boolean approving; // the wallet came up for an approval, not because you opened it
    boolean prompting; // a fingerprint prompt is showing

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            TextView update = new TextView(this);
            update.setText("Plain Wallet needs a newer Android System WebView. Update it from the Play Store.");
            setContentView(update);
            return;
        }

        // Debug builds only: lets Chrome DevTools (chrome://inspect) attach to both WebViews for testing.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        wallet = webView();
        wallet.setWebViewClient(new Client() {
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
        });
        WebViewCompat.addWebMessageListener(wallet, "plainwalletNative", Set.of(WALLET), (view, message, origin, mainFrame, reply) -> {
            if (mainFrame) fromWallet(message.getData(), reply);
        });

        browser = webView();
        browser.setWebViewClient(new Client() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame() && !web(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                icon = null;
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                page();
            }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView view, String title) {
                page();
            }

            // For favorites: re-encoded here, so the wallet page only ever gets a small PNG.
            @Override
            public void onReceivedIcon(WebView view, Bitmap favicon) {
                ByteArrayOutputStream png = new ByteArrayOutputStream();
                Bitmap.createScaledBitmap(favicon, 64, 64, true).compress(Bitmap.CompressFormat.PNG, 100, png);
                icon = "data:image/png;base64," + Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP);
                page();
            }

            @Override
            public void onProgressChanged(WebView view, int percent) {
                progress.setProgress(percent);
                progress.setVisibility(percent < 100 ? View.VISIBLE : View.GONE);
            }
        });
        WebViewCompat.addDocumentStartJavaScript(browser, asset("android-inpage.js"), Set.of("*"));
        // Every frame gets the object; only top-level pages are heard, as in the extension. The origin is the
        // WebView's; the page only supplies the request, which goes to the wallet as-is.
        WebViewCompat.addWebMessageListener(browser, "plainwalletNative", Set.of("*"), (view, message, origin, mainFrame, reply) -> {
            String data = message.getData();
            if (!mainFrame || data == null || origin.toString().equals(WALLET)) return;
            try {
                if (new JSONObject(data).optBoolean("hello")) {
                    pagePort = reply;
                    return;
                }
            } catch (JSONException e) {
                return;
            }
            waiting.put(++requests, reply);
            toWallet(json("type", "request", "n", requests, "origin", origin.toString(), "title", view.getTitle(), "data", data));
        });

        // A browser's address bar: a rounded field showing the page without https:// (all of it while you edit),
        // the star inside it; empty on the wallet, which is the new-tab page here.
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
            if (wallet.getVisibility() == View.VISIBLE && browser.getUrl() != null) showWallet(false);
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
        FrameLayout views = new FrameLayout(this);
        views.addView(browser);
        views.addView(wallet);
        views.addView(progress, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(4), Gravity.TOP));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFocusableInTouchMode(true); // somewhere for focus to go when the address field lets go of it
        root.addView(bar);
        root.addView(views, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        // Edge to edge on every version (Android 15+ insists anyway): the bars show the wallet's paper color.
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        showWallet(true);
        wallet.loadUrl(WALLET + "/android.html?view=tab");

        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (wallet != null) fingerprint(null); // you may have set up a fingerprint meanwhile; a locked wallet asks again
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
        } else if (approving) { // like closing the extension's approval window: rejects what's waiting
            approving = false;
            toWallet(json("type", "back"));
            showWallet(false);
        } else if (browser.getUrl() != null) showWallet(false);
        else moveTaskToBack(true); // not finish(): that would drop the unlocked session
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
                    if (page != null && msg.getString("origin").equals(origin(browser.getUrl()))) page.postMessage(msg.getString("data"));
                    break;
                case "event":
                    if (pagePort != null && msg.getString("origin").equals(origin(browser.getUrl()))) pagePort.postMessage(msg.getString("data"));
                    break;
                case "show":
                    if (wallet.getVisibility() != View.VISIBLE) {
                        approving = true;
                        showWallet(true);
                    }
                    break;
                case "hide":
                    if (approving) {
                        approving = false;
                        showWallet(false);
                    }
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

    /** The browser shows a new address or title. */
    void page() {
        String url = browser.getUrl();
        if (url == null) return;
        if (!address.hasFocus()) showAddress();
        toWallet(json("type", "page", "url", url, "title", browser.getTitle(), "icon", icon));
    }

    void showAddress() {
        String url = browser.getUrl();
        boolean home = wallet.getVisibility() == View.VISIBLE || url == null;
        address.setText(home ? "" : address.hasFocus() ? url : url.replaceFirst("^https://", "").replaceFirst("/$", ""));
        star.setVisibility(home ? View.GONE : View.VISIBLE);
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

    void enableFingerprint(String key) {
        try {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(FINGERPRINT, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setUserAuthenticationRequired(true)
                    .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                    .setInvalidatedByBiometricEnrollment(true)
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
            fingerprint(e.getMessage());
        }
    }

    void unlockWithFingerprint() {
        // Only for the wallet you're looking at: never a prompt over a site.
        if (prompting || wallet.getVisibility() != View.VISIBLE || !stored().contains("data")) return;
        try {
            KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, (SecretKey) keys.getKey(FINGERPRINT, null),
                    new GCMParameterSpec(128, Base64.decode(stored().getString("iv", ""), Base64.NO_WRAP)));
            prompt("Unlock Plain Wallet", cipher, done -> toWallet(json("type", "fingerprint-key",
                    "key", new String(done.doFinal(Base64.decode(stored().getString("data", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8))));
        } catch (KeyPermanentlyInvalidatedException e) {
            forgetFingerprint();
            fingerprint("Fingerprints on this phone changed, so fingerprint unlock is off. Unlock with your password and turn it on again in Settings.");
        } catch (GeneralSecurityException | IOException e) {
            fingerprint(e.getMessage());
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
                                    fingerprint(e.getMessage());
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
        // An address, or else a search
        open(t.matches("(?i)https?://\\S+") ? t : !t.contains(" ") && t.contains(".") ? "https://" + t : "https://duckduckgo.com/?q=" + Uri.encode(t));
        address.clearFocus();
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(address.getWindowToken(), 0);
    }

    void open(String url) {
        if (!web(Uri.parse(url))) return;
        browser.loadUrl(url);
        showWallet(false);
    }

    void openWallet() {
        showWallet(true);
        toWallet(json("type", "shown"));
    }

    void showWallet(boolean on) {
        wallet.setVisibility(on ? View.VISIBLE : View.GONE);
        browser.setVisibility(on ? View.GONE : View.VISIBLE);
        if (on) progress.setVisibility(View.GONE);
        address.clearFocus();
        showAddress();
    }

    /** Only http(s) sites, never the wallet page's own origin. */
    static boolean web(Uri uri) {
        return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) && !WALLET_HOST.equals(uri.getHost());
    }

    /** Serialized like the WebView reports origins: scheme://host[:port], the default port left out. */
    static String origin(String url) {
        if (url == null) return "";
        Uri u = Uri.parse(url);
        return u.getScheme() + "://" + u.getHost() + (u.getPort() == -1 ? "" : ":" + u.getPort());
    }

    /** Both WebViews share one renderer process: if it dies (a site can run it out of memory), start over, locked. */
    class Client extends WebViewClient {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (!isChangingConfigurations()) recreate();
            return true;
        }
    }

    WebView webView() {
        WebView view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false);
        view.getSettings().setAllowContentAccess(false);
        return view;
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
