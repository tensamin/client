package net.tensamin.client

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// The renderer owns the call. This service only maintains Android's audio entitlement.
class CallAudioService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Active calls", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val open = PendingIntent.getActivity(
      this, NOTIFICATION,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification_small)
      .setContentTitle("Call in progress")
      .setContentText("Open Tensamin to return to the call")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(open)
      .build()
    var types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && intent?.getBooleanExtra("microphone", false) == true &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    ServiceCompat.startForeground(this, NOTIFICATION, notification, types)
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL = "tensamin-active-call"
    private const val NOTIFICATION = 60491

    fun update(context: Context, active: Boolean, microphone: Boolean) {
      val intent = Intent(context, CallAudioService::class.java).putExtra("microphone", microphone)
      if (!active) context.stopService(intent)
      else ContextCompat.startForegroundService(context, intent)
    }
  }
}
