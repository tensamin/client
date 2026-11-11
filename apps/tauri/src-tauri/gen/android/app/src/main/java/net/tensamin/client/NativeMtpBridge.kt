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
