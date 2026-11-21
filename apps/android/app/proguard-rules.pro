# The offscreen card renderer calls back into the app through this bridge.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
