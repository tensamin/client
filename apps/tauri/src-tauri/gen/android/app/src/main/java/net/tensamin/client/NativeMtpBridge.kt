package net.tensamin.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import androidx.annotation.Keep
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import java.security.KeyStore

@Keep
object NativeMtpBridge {
  private const val MESSAGE_CHANNEL = "tensamin-messages"
  private var lastMessageAlertAt = -1000L

  init {
    System.loadLibrary("mobile_lib")
  }

  @JvmStatic external fun nativeAttach(context: Context)
  @JvmStatic external fun nativeSetUiState(visible: Boolean)
  @JvmStatic external fun nativeViewDestroyed()
  @JvmStatic external fun nativeLog(level: Int, message: String, details: String)

  fun log(level: Int, message: String, error: Throwable? = null) {
    val details = error?.stackTraceToString().orEmpty()
    Log.println(if (level == 0) Log.ERROR else Log.INFO, "TensaminAndroid", "$message $details")
    nativeLog(level, message, details)
  }

  fun setCallActive(context: Context, active: Boolean, microphone: Boolean) {
    CallAudioService.update(context, active, microphone)
  }

  fun storeConfig(context: Context, config: String) {
    try {
      MtpSecureStore.saveConfig(context, config)
      log(2, "Stored native MTP credentials")
    } catch (error: Throwable) {
      log(0, "Failed to store native MTP credentials", error)
      throw error
    }
  }

  fun clearConfig(context: Context) {
    MtpSecureStore.clear(context)
  }

  fun loadConfig(context: Context): String? = MtpSecureStore.loadConfig(context)

  fun trustedCertificates(): String {
    val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
    return buildString {
      val aliases = store.aliases()
      while (aliases.hasMoreElements()) {
        val certificate = store.getCertificate(aliases.nextElement()) ?: continue
        append("-----BEGIN CERTIFICATE-----\n")
        Base64.encodeToString(certificate.encoded, Base64.NO_WRAP)
          .chunked(64)
          .forEach { append(it).append('\n') }
        append("-----END CERTIFICATE-----\n")
      }
    }
  }

  fun usageInfo(context: Context): String {
    val memory = android.app.ActivityManager.MemoryInfo()
    context.getSystemService(android.app.ActivityManager::class.java).getMemoryInfo(memory)
    val battery = context.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val app = context.packageManager.getPackageInfo(context.packageName, 0)
    val level = battery?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
    return org.json.JSONObject().apply {
      put("os", "Android")
      put("app_version_name", app.versionName)
      put("app_version_code", if (Build.VERSION.SDK_INT >= 28) app.longVersionCode else app.versionCode.toLong())
      put("os_version", Build.VERSION.RELEASE)
      put("sdk", Build.VERSION.SDK_INT)
      put("os_build", Build.ID)
      if (Build.VERSION.SDK_INT >= 31) put("cpu_model", Build.SOC_MODEL)
      put("security_patch", Build.VERSION.SECURITY_PATCH)
      put("manufacturer", Build.MANUFACTURER)
      put("model", Build.MODEL)
      put("architecture", Build.SUPPORTED_ABIS.firstOrNull())
      put("cpu_cores", Runtime.getRuntime().availableProcessors())
      put("ram_bytes", memory.totalMem)
      if (Build.VERSION.SDK_INT >= 26) put("webview_version", android.webkit.WebView.getCurrentWebViewPackage()?.versionName)
      put("process_cpu_total_ms", android.os.Process.getElapsedCpuTime())
      put("process_pss_kib", android.os.Debug.getPss())
      put("uid_received_bytes", android.net.TrafficStats.getUidRxBytes(android.os.Process.myUid()))
      put("uid_sent_bytes", android.net.TrafficStats.getUidTxBytes(android.os.Process.myUid()))
      put("battery_percent", if (level >= 0 && scale > 0) level * 100 / scale else org.json.JSONObject.NULL)
      put("charging", (battery?.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0)
      put("battery_optimization_exempt", isIgnoringBatteryOptimizations(context))
      put("power_save_mode", context.getSystemService(PowerManager::class.java).isPowerSaveMode)
    }.toString()
  }

  fun hasConfig(context: Context): Boolean = MtpSecureStore.hasConfig(context)

  fun isIgnoringBatteryOptimizations(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)
      .isIgnoringBatteryOptimizations(context.packageName)

  fun requestBatteryExemption(context: Context) {
    val intent = Intent(
      Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
      Uri.parse("package:${context.packageName}"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  @Synchronized
  fun postMessageNotification(
    context: Context,
    senderId: Long,
    sender: String,
    body: String,
    avatar: ByteArray,
    principal: String,
    account: String,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(
          MESSAGE_CHANNEL,
          "Messages",
          NotificationManager.IMPORTANCE_HIGH,
        ).apply { description = "Incoming Tensamin messages" },
      )
    }
    val openIntent = Intent(
      Intent.ACTION_VIEW,
      if (principal.isEmpty()) Uri.parse("tensamin://") else Uri.parse("tensamin://chat?principal=${Uri.encode(principal)}&account=${Uri.encode(account)}"),
      context,
      MainActivity::class.java,
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pendingIntent = PendingIntent.getActivity(
      context,
      senderId.hashCode(),
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val avatarBitmap = avatar.takeIf { it.isNotEmpty() }?.let {
      BitmapFactory.decodeByteArray(it, 0, it.size)
    }
    val avatarIcon = avatarBitmap?.let(IconCompat::createWithAdaptiveBitmap)
    val person = Person.Builder()
      .setName(sender)
      .setKey(senderId.toString())
      .setIcon(avatarIcon)
      .build()
    val shortcutId = "chat-$senderId"
    val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
      .setShortLabel(sender)
      .setLongLived(true)
      .setPerson(person)
      .setIntent(openIntent)
      .apply { if (avatarIcon != null) setIcon(avatarIcon) }
      .build()
    ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)

    val style = NotificationCompat.MessagingStyle(
      Person.Builder().setName("You").build(),
    ).addMessage(body, System.currentTimeMillis(), person)
    val now = android.os.SystemClock.elapsedRealtime()
    val silent = now - lastMessageAlertAt < 1000
    if (!silent) lastMessageAlertAt = now
    val notification = NotificationCompat.Builder(context, MESSAGE_CHANNEL)
      .setSmallIcon(R.drawable.ic_notification_small)
      .setContentTitle(sender)
      .setContentText(body)
      .setStyle(style)
      .setShortcutId(shortcutId)
      .setLocusId(LocusIdCompat(shortcutId))
      .setLargeIcon(avatarBitmap)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setSilent(silent)
      .setContentIntent(pendingIntent)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    context.getSystemService(NotificationManager::class.java)
      .notify(senderId.hashCode(), notification)
  }

  fun cancelMessageNotification(context: Context, senderId: Long) {
    context.getSystemService(NotificationManager::class.java)
      .cancel(senderId.hashCode())
  }

}
