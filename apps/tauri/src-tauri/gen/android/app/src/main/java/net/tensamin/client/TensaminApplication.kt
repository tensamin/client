package net.tensamin.client

import android.app.Application

class TensaminApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    // MTP's Android plugin reads this before starting its background service.
    check(getSharedPreferences("mtp-library", 0).edit().putString("name", "mobile_lib").commit())
    // Also runs in a boot-started service process, before any activity exists.
    NativeMtpBridge.nativeAttach(applicationContext)
  }
}
