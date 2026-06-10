package com.agenthub.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "agenthub_mobile_connection";
    private static final String KEY_HOST = "host";
    private static final String KEY_WEB_PORT = "web_port";
    private static final String KEY_API_PORT = "api_port";

    private FrameLayout root;
    private SharedPreferences prefs;
    private WebView webView;
    private boolean handlingMainFrameError = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(246, 248, 251));
        setContentView(root);

        String host = prefs.getString(KEY_HOST, "");
        if (host == null || host.trim().isEmpty()) {
            showConnectionScreen(null);
        } else {
            loadMobileWeb();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void loadMobileWeb() {
        handlingMainFrameError = false;
        root.removeAllViews();

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame() && !handlingMainFrameError) {
                    handlingMainFrameError = true;
                    String description = error == null ? "无法连接服务" : String.valueOf(error.getDescription());
                    showConnectionScreen("连接失败：" + description);
                }
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        root.addView(createFloatingSettingsButton());
        webView.loadUrl(buildMobileUrl());
    }

    private Button createFloatingSettingsButton() {
        Button button = new Button(this);
        button.setText("设置");
        button.setTextSize(12);
        button.setTextColor(Color.rgb(37, 99, 235));
        button.setBackgroundColor(Color.WHITE);
        button.setAllCaps(false);
        button.setOnClickListener(view -> showConnectionScreen(null));

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(64), dp(38));
        params.gravity = Gravity.BOTTOM | Gravity.RIGHT;
        params.setMargins(0, 0, dp(14), dp(18));
        button.setLayoutParams(params);
        return button;
    }

    private void showConnectionScreen(String errorMessage) {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        root.removeAllViews();

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setGravity(Gravity.CENTER_HORIZONTAL);
        container.setPadding(dp(28), dp(42), dp(28), dp(28));
        scrollView.addView(container, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        ImageView logo = new ImageView(this);
        logo.setImageResource(getResources().getIdentifier("app_logo", "drawable", getPackageName()));
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(82), dp(82));
        logoParams.setMargins(0, dp(18), 0, dp(18));
        container.addView(logo, logoParams);

        TextView title = new TextView(this);
        title.setText("连接 AgentHub");
        title.setTextColor(Color.rgb(16, 24, 40));
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, 1);
        container.addView(title, fullWidthParams(0, 0, 0, dp(6)));

        TextView subtitle = new TextView(this);
        subtitle.setText("输入后端所在机器的 IP 和端口，保存后进入移动端页面。");
        subtitle.setTextColor(Color.rgb(102, 112, 133));
        subtitle.setTextSize(13);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setLineSpacing(dp(2), 1.0f);
        container.addView(subtitle, fullWidthParams(0, 0, 0, dp(22)));

        EditText hostInput = input("服务器 IP 或域名", prefs.getString(KEY_HOST, ""));
        EditText webPortInput = input("Web 端口", prefs.getString(KEY_WEB_PORT, "5173"));
        EditText apiPortInput = input("API 端口，可留空使用 Web 同源 /api", prefs.getString(KEY_API_PORT, ""));
        container.addView(hostInput, fullWidthParams(0, 0, 0, dp(10)));
        container.addView(webPortInput, fullWidthParams(0, 0, 0, dp(10)));
        container.addView(apiPortInput, fullWidthParams(0, 0, 0, dp(14)));

        if (errorMessage != null && !errorMessage.trim().isEmpty()) {
            TextView error = new TextView(this);
            error.setText(errorMessage);
            error.setTextColor(Color.rgb(220, 38, 38));
            error.setTextSize(12);
            error.setGravity(Gravity.LEFT);
            container.addView(error, fullWidthParams(0, 0, 0, dp(12)));
        }

        Button connect = new Button(this);
        connect.setText("保存并连接");
        connect.setTextColor(Color.WHITE);
        connect.setTextSize(15);
        connect.setAllCaps(false);
        connect.setBackgroundColor(Color.rgb(37, 99, 235));
        connect.setOnClickListener(view -> {
            String host = hostInput.getText().toString().trim();
            if (host.isEmpty()) {
                showConnectionScreen("请先输入服务器 IP 或域名。");
                return;
            }
            prefs.edit()
                .putString(KEY_HOST, host)
                .putString(KEY_WEB_PORT, webPortInput.getText().toString().trim())
                .putString(KEY_API_PORT, apiPortInput.getText().toString().trim())
                .apply();
            loadMobileWeb();
        });
        container.addView(connect, fullWidthParams(0, 0, 0, dp(10)));

        TextView hint = new TextView(this);
        hint.setText("示例：59.66.220.206 / Web 5173 / API 3000。若 Web 服务已代理 /api，API 端口可以留空。");
        hint.setTextColor(Color.rgb(123, 135, 152));
        hint.setTextSize(11);
        hint.setGravity(Gravity.CENTER);
        hint.setLineSpacing(dp(2), 1.0f);
        container.addView(hint, fullWidthParams(0, dp(8), 0, 0));

        root.addView(scrollView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
    }

    private EditText input(String hint, String value) {
        EditText editText = new EditText(this);
        editText.setSingleLine(true);
        editText.setText(value == null ? "" : value);
        editText.setHint(hint);
        editText.setTextSize(15);
        editText.setTextColor(Color.rgb(24, 34, 48));
        editText.setHintTextColor(Color.rgb(160, 169, 184));
        editText.setPadding(dp(14), 0, dp(14), 0);
        editText.setBackgroundColor(Color.WHITE);
        editText.setMinHeight(dp(48));
        return editText;
    }

    private String buildMobileUrl() {
        String host = normalizeHost(prefs.getString(KEY_HOST, ""));
        String webPort = normalizePort(prefs.getString(KEY_WEB_PORT, "5173"));
        String apiPort = normalizePort(prefs.getString(KEY_API_PORT, ""));
        Uri.Builder builder = new Uri.Builder()
            .scheme("http")
            .encodedAuthority(webPort.isEmpty() ? host : host + ":" + webPort)
            .path("/mobile/messages")
            .appendQueryParameter("agenthubMobile", "1");
        if (!apiPort.isEmpty()) {
            builder.appendQueryParameter("agenthubApiBase", "http://" + host + ":" + apiPort + "/api");
        }
        return builder.build().toString();
    }

    private String normalizeHost(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.startsWith("http://")) value = value.substring("http://".length());
        if (value.startsWith("https://")) value = value.substring("https://".length());
        int slash = value.indexOf("/");
        if (slash >= 0) value = value.substring(0, slash);
        int colon = value.lastIndexOf(":");
        if (colon > 0 && value.indexOf("]") < 0) value = value.substring(0, colon);
        return value;
    }

    private String normalizePort(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            if (c >= '0' && c <= '9') digits.append(c);
        }
        return digits.toString();
    }

    private LinearLayout.LayoutParams fullWidthParams(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(left, top, right, bottom);
        return params;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
