package cn.remoteterminal.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.JavascriptInterface
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private class SecureTokenStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("secure_credentials", Context.MODE_PRIVATE)
    private val keyAlias = "remote-terminal-token-v1"

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    keyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    fun write(token: String) {
        if (token.length > 4096) return
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        preferences.edit()
            .putString("ciphertext", Base64.encodeToString(cipher.doFinal(token.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun read(): String {
        return try {
            val ciphertext = preferences.getString("ciphertext", null) ?: return ""
            val iv = preferences.getString("iv", null) ?: return ""
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            }
            String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) {
            clear()
            ""
        }
    }

    fun clear() {
        preferences.edit().clear().apply()
    }
}

private class NativeBridge(
    private val activity: Activity,
    private val rootView: View,
    private val webView: WebView,
) {
    private val context: Context = activity
    private val secureTokenStore = SecureTokenStore(activity)

    @JavascriptInterface
    fun readClipboardText(): String {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
    }

    @JavascriptInterface
    fun supportsSecureCredentials(): Boolean = true

    @JavascriptInterface
    fun readCredential(): String = secureTokenStore.read()

    @JavascriptInterface
    fun writeCredential(token: String) = secureTokenStore.write(token)

    @JavascriptInterface
    fun clearCredential() = secureTokenStore.clear()

    @JavascriptInterface
    @Suppress("DEPRECATION")
    fun setSystemBarStyle(style: String) {
        activity.runOnUiThread {
            val light = style == "light"
            val statusColor = Color.parseColor(if (light) "#F5F6F8" else "#151A21")
            val navigationColor = Color.parseColor(if (light) "#FFFFFF" else "#20262F")
            activity.window.statusBarColor = statusColor
            activity.window.navigationBarColor = navigationColor
            activity.window.decorView.setBackgroundColor(statusColor)
            rootView.setBackgroundColor(statusColor)
            webView.setBackgroundColor(statusColor)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                    WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                activity.window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
            } else {
                var flags = activity.window.decorView.systemUiVisibility
                flags = if (light) {
                    flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                } else {
                    flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv() and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                }
                activity.window.decorView.systemUiVisibility = flags
            }
        }
    }
}

class MainActivity : Activity() {
    private lateinit var rootView: FrameLayout
    private lateinit var webView: WebView
    private var predictiveBackCallback: OnBackInvokedCallback? = null
    private var lastImeBottom = -1

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        rootView = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F5F6F8"))
        }
        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#F5F6F8"))
            overScrollMode = View.OVER_SCROLL_NEVER
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setSupportZoom(false)
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            addJavascriptInterface(NativeBridge(this@MainActivity, rootView, this), "RemoteTerminalNative")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return request.url.scheme != "file"
                }
            }
            if (savedInstanceState == null || restoreState(savedInstanceState) == null) {
                loadUrl("file:///android_asset/www/index.html")
            }
        }
        rootView.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        configureSystemInsets()
        setContentView(rootView)
        rootView.requestApplyInsets()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback = OnBackInvokedCallback { handleBackRequest() }.also { callback ->
                onBackInvokedDispatcher.registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    callback,
                )
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun configureSystemInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.setDecorFitsSystemWindows(false)
        rootView.setOnApplyWindowInsetsListener { view, insets ->
            val systemBars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            val bottom = maxOf(systemBars.bottom, ime.bottom)
            if (
                view.paddingLeft != systemBars.left || view.paddingTop != systemBars.top ||
                view.paddingRight != systemBars.right || view.paddingBottom != bottom
            ) {
                view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottom)
            }
            if (lastImeBottom != ime.bottom) {
                lastImeBottom = ime.bottom
                view.post {
                    webView.evaluateJavascript(
                        "window.RemoteTerminalApp && window.RemoteTerminalApp.onViewportChanged(${ime.bottom > 0})",
                        null,
                    )
                }
            }
            WindowInsets.CONSUMED
        }
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback?.let(onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
            predictiveBackCallback = null
        }
        webView.destroy()
        super.onDestroy()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    private fun handleBackRequest() {
        if (!::webView.isInitialized) {
            finishAfterTransition()
            return
        }
        webView.evaluateJavascript(
            "(function(){return !!(window.RemoteTerminalApp && window.RemoteTerminalApp.handleBack());})()",
        ) { handled ->
            if (handled != "true") finishAfterTransition()
        }
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        handleBackRequest()
    }
}
