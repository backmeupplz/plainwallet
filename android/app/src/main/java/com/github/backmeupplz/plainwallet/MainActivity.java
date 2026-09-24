package com.github.backmeupplz.plainwallet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
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
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Scanner;
import java.util.Set;
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
    EditText address;
    TextView star;
    JavaScriptReplyProxy walletPort, pagePort; // pagePort: the page in the browser, once its script said hello
    final List<String> queued = new ArrayList<>(); // for the wallet page until it's ready
    final Map<Integer, JavaScriptReplyProxy> waiting = new HashMap<>(); // request number -> the page that asked
    int requests;
    boolean approving; // the wallet came up for an approval, not because you opened it

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
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                page();
            }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView view, String title) {
                page();
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

        address = new EditText(this);
        address.setSingleLine();
        address.setHint("Search or type a site");
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setSelectAllOnFocus(true);
        address.setOnEditorActionListener((v, action, event) -> {
            go(v.getText().toString());
            return true;
        });
        star = new TextView(this);
        star.setText("☆");
        star.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        star.setPadding(dp(12), 0, dp(12), 0);
        star.setGravity(android.view.Gravity.CENTER);
        star.setContentDescription("Favorite this site");
        star.setOnClickListener(v -> toWallet(json("type", "star")));
        ImageButton home = new ImageButton(this, null, android.R.attr.borderlessButtonStyle);
        home.setImageResource(R.mipmap.icon);
        home.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        home.setContentDescription("Wallet");
        home.setOnClickListener(v -> {
            if (wallet.getVisibility() == View.VISIBLE && browser.getUrl() != null) showWallet(false);
            else openWallet();
        });

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(4), dp(4), dp(4));
        bar.addView(address, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        bar.addView(star, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(48)));
        bar.addView(home, new LinearLayout.LayoutParams(dp(48), dp(48)));
        FrameLayout views = new FrameLayout(this);
        views.addView(browser);
        views.addView(wallet);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(bar);
        root.addView(views, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
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
                    star.setText(msg.getBoolean("on") ? "★" : "☆");
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
        if (!address.hasFocus()) address.setText(url);
        toWallet(json("type", "page", "url", url, "title", browser.getTitle()));
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
