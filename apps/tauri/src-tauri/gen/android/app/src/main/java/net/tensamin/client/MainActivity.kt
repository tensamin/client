package net.tensamin.client

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  override val handleBackNavigation = false
  private var contentRoot: FrameLayout? = null
  private var contentChild: android.view.View? = null
  private var previousUsableHeight = 0
  private var attachLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
  private var mediaWebView: WebView? = null
  private var pendingScreenAudio: Boolean? = null
  @Volatile private var safeAreaJson = "{}"

  private val screenCaptureLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    val includeAudio = pendingScreenAudio
    pendingScreenAudio = null

    if (includeAudio == null) return@registerForActivityResult
    val data = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      MobileMediaEvents.emitError("Screen capture permission was denied")
      return@registerForActivityResult
    }

    MediaProjectionService.start(this, result.resultCode, data, includeAudio)
  }

  private val cameraPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions(),
  ) {
    emitCameraPermission()
  }

  private val screenAudioPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
  ) {
    launchScreenCaptureIntent()
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(getColor(R.color.launch_background))
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }

    NativeAccessibilityBridge.attach(webView)
    mediaWebView = webView
    MobileMediaEvents.attach(webView)
    webView.addJavascriptInterface(MobileMediaJavascriptInterface(), "tensaminMobileMedia")
    webView.addJavascriptInterface(SafeAreaJavascriptInterface(), "tensaminSafeArea")
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Dismiss the top web popup before leaving its underlying page.
        webView.evaluateJavascript(
          """
          (() => {
            const popup = [...document.querySelectorAll(
              '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
            )].find(element => element.getClientRects().length && !element.hasAttribute('data-closed'));
            if (!popup) return false;
            popup.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
            }));
            return true;
          })()
          """.trimIndent(),
        ) { handled ->
          if (handled != "true") {
            if (webView.canGoBack()) {
              webView.goBack()
            } else {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      }
    })
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
    super.onCreate(savedInstanceState)
    // Restore after Wry finishes the previous activity's WebView cleanup.
    android.os.Looper.myQueue().addIdleHandler {
      NativeMtpBridge.nativeAttach(applicationContext)
      false
    }
    org.nonanium.mtp.MtpService.attach(this)
    NativeAccessibilityBridge.nativeAttach(applicationContext)
    installKeyboardResizeWorkaround()
  }

  override fun onResume() {
    super.onResume()
    NativeMtpBridge.nativeSetUiState(true)
  }

  override fun onPause() {
    NativeMtpBridge.nativeSetUiState(false)
    super.onPause()
  }

  override fun onDestroy() {
    attachLayoutListener?.let { listener ->
      contentRoot?.viewTreeObserver?.removeOnGlobalLayoutListener(listener)
    }
    attachLayoutListener = null
    contentRoot = null
    contentChild = null
    mediaWebView?.let {
      NativeAccessibilityBridge.detach(it)
      it.removeJavascriptInterface("tensaminMobileMedia")
      it.removeJavascriptInterface("tensaminSafeArea")
    }
    mediaWebView = null
    MobileMediaEvents.detach()
    super.onDestroy()
    android.os.Looper.myQueue().addIdleHandler {
      NativeMtpBridge.nativeAttach(applicationContext)
      false
    }
  }

  private fun startScreenShare(includeAudio: Boolean) {
    runOnUiThread {
      if (pendingScreenAudio != null) {
        MobileMediaEvents.emitError("Screen capture permission is already pending")
        return@runOnUiThread
      }

      pendingScreenAudio = includeAudio
      if (
        includeAudio &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
          PackageManager.PERMISSION_GRANTED
      ) {
        screenAudioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
      } else {
        launchScreenCaptureIntent()
      }
    }
  }

  private fun launchScreenCaptureIntent() {
    val manager = getSystemService(MediaProjectionManager::class.java)
    screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
  }

  private fun stopScreenShare() {
    runOnUiThread {
      pendingScreenAudio = null
      MediaProjectionService.stop(this)
    }
  }

  private fun requestCameraPermission() {
    runOnUiThread {
      cameraPermissionLauncher.launch(
        arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO),
      )
    }
  }

  private fun emitCameraPermission() {
    val detail = JSONObject()
      .put(
        "camera",
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
          PackageManager.PERMISSION_GRANTED,
      )
      .put(
        "microphone",
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED,
      )
    MobileMediaEvents.emit("tensamin-mobile-camera-permission", detail)
  }

  private inner class MobileMediaJavascriptInterface {
    @JavascriptInterface
    fun startScreenShare(includeAudio: Boolean) {
      this@MainActivity.startScreenShare(includeAudio)
    }

    @JavascriptInterface
    fun stopScreenShare() {
      this@MainActivity.stopScreenShare()
    }

    @JavascriptInterface
    fun requestCameraPermission() {
      this@MainActivity.requestCameraPermission()
    }
  }

  private inner class SafeAreaJavascriptInterface {
    @JavascriptInterface
    fun getInsets(): String = safeAreaJson

    @JavascriptInterface
    fun setLightSystemBars(light: Boolean) {
      runOnUiThread {
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = light
          isAppearanceLightNavigationBars = light
        }
      }
    }
  }

  private fun installKeyboardResizeWorkaround() {
    val content = window.decorView.findViewById<FrameLayout>(android.R.id.content)
    contentRoot = content

    val listener = ViewTreeObserver.OnGlobalLayoutListener {
      attachKeyboardResizeWorkaroundIfReady(content)
    }

    attachLayoutListener = listener
    content.viewTreeObserver.addOnGlobalLayoutListener(listener)
    content.post { attachKeyboardResizeWorkaroundIfReady(content) }
  }

  private fun attachKeyboardResizeWorkaroundIfReady(content: FrameLayout) {
    if (contentChild != null) {
      resizeContentForKeyboard(contentChild ?: return)
      return
    }

    val child = content.getChildAt(0) ?: return
    contentChild = child

    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      resizeContentForKeyboard(child, insets)
      insets
    }

    ViewCompat.requestApplyInsets(content)
    resizeContentForKeyboard(child)
  }

  private fun resizeContentForKeyboard(
    child: android.view.View,
    insets: WindowInsetsCompat? = ViewCompat.getRootWindowInsets(child),
  ) {
    val rootHeight = child.rootView.height
    if (rootHeight <= 0) return

    val imeVisible = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true
    insets?.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
    )?.let { bars ->
      val next = JSONObject()
        .put("top", bars.top)
        .put("right", bars.right)
        .put("bottom", if (imeVisible) 0 else bars.bottom)
        .put("left", bars.left)
        .put("width", child.width)
        .toString()
      if (next != safeAreaJson) {
        safeAreaJson = next
        mediaWebView?.evaluateJavascript(
          "window.dispatchEvent(new Event('tensamin:insets'))",
          null,
        )
      }
    }
    val imeHeight = if (imeVisible) {
      insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    } else {
      0
    }
    val usableHeight = if (imeHeight in 1 until rootHeight) {
      rootHeight - imeHeight
    } else {
      WindowManager.LayoutParams.MATCH_PARENT
    }

    if (previousUsableHeight == usableHeight) return

    val params = child.layoutParams
    params.height = usableHeight
    child.layoutParams = params
    child.requestLayout()
    previousUsableHeight = usableHeight
  }
}
