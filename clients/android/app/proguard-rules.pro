# JavaScript can call only methods explicitly annotated for the local WebView bridge.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
