package net.tensamin.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object MtpSecureStore {
  private const val KEY_ALIAS = "tensamin-mtp-config"
  private const val PREFS = "tensamin-mtp"
  private const val CONFIG = "config"

  fun saveConfig(context: Context, config: String) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
    val encrypted = cipher.doFinal(config.toByteArray(Charsets.UTF_8))
    val payload = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    preferences(context).edit().putString(CONFIG, payload).apply()
  }

  fun loadConfig(context: Context): String? {
    val payload = preferences(context).getString(CONFIG, null) ?: return null
    val bytes = Base64.decode(payload, Base64.NO_WRAP)
    require(bytes.size > 12)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      getOrCreateKey(),
      GCMParameterSpec(128, bytes.copyOfRange(0, 12)),
    )
    return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
  }

  fun hasConfig(context: Context): Boolean =
    runCatching { loadConfig(context) != null }.getOrDefault(false)

  fun clear(context: Context) {
    preferences(context).edit().clear().commit()
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS)
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun getOrCreateKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

    val generator = KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES,
      "AndroidKeyStore",
    )
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }
}
