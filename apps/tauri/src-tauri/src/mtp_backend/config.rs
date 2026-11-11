use super::*;

pub(crate) fn current_config() -> Result<MtpConfig, String> {
    let config = manager()
        .config
        .read()
        .map_err(|_| "config lock unavailable")?
        .clone();
    #[cfg(target_os = "android")]
    let config = match config {
        Some(config) => Some(config),
        None => load_native_config()?
            .map(|serialized| {
                let mut config =
                    serde_json::from_str(&serialized).map_err(|error| error.to_string())?;
                validate_config(&mut config)?;
                Ok::<_, String>(config)
            })
            .transpose()?,
    };
    #[cfg(not(target_os = "android"))]
    let config = match config {
        Some(config) => Some(config),
        None => crate::mtp_credentials::load()?.map(|record| record.config.clone()),
    };
    config.ok_or_else(|| "discovery configuration unavailable".into())
}

#[cfg(not(target_os = "android"))]
pub(crate) fn native_credential_location() -> Result<(String, std::path::PathBuf), String> {
    use tauri::Manager;
    let app = manager()
        .app
        .read()
        .map_err(|_| "application lock unavailable")?;
    let app = app.as_ref().ok_or("application directory unavailable")?;
    Ok((
        app.config().identifier.clone(),
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("credentials"),
    ))
}
pub(crate) fn validate_config(config: &mut MtpConfig) -> Result<(), String> {
    if config.user_id == 0 {
        return Err("MTP user ID must be positive".into());
    }
    let keyring_bytes = zeroize::Zeroizing::new(
        decode_browser_base64(&config.keyring)
            .map_err(|error| format!("invalid MTP keyring: {error}"))?,
    );
    Keyring::from_bytes(&keyring_bytes).map_err(|error| format!("invalid MTP keyring: {error}"))?;
    let omega_url = normalize_https_url(&config.omega_url, "Omega URL")?;
    let forced_omikron_url = config
        .forced_omikron_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalize_https_url(value, "Forced Omikron URL"))
        .transpose()?;
    let forced_omikron_public_key = config
        .forced_omikron_public_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if forced_omikron_url.is_some() != forced_omikron_public_key.is_some() {
        return Err("Forced Omikron URL and public key must both be set or both be empty".into());
    }
    if let Some(public_key) = forced_omikron_public_key.as_ref() {
        let bytes = decode_sdk_bytes(public_key)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        let key = PublicKeyBundle::from_bytes(&bytes)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        key.validate()
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
    }
    config.omega_url = omega_url;
    config.forced_omikron_url = forced_omikron_url;
    config.forced_omikron_public_key = forced_omikron_public_key;
    Ok(())
}

pub(super) fn normalize_https_url(value: &str, label: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|error| format!("{label} is invalid: {error}"))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(format!("{label} must be a valid HTTPS URL"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} must not contain credentials"));
    }
    Ok(url.to_string())
}

pub(super) async fn resolve_endpoint(config: &MtpConfig) -> Result<(String, String), String> {
    if let (Some(url), Some(key)) = (
        config.forced_omikron_url.as_ref(),
        config.forced_omikron_public_key.as_ref(),
    ) {
        return Ok((url.clone(), key.clone()));
    }
    lookup_omikron(config, None).await
}

#[derive(Deserialize)]
struct OmikronDiscovery {
    id: u64,
    ip_address: String,
    port: u16,
    public_key: String,
}

impl OmikronDiscovery {
    fn endpoint(self, owner: Option<u64>) -> Result<(String, String), String> {
        if self.id == 0 || self.id > i64::MAX as u64 || owner.is_some_and(|owner| owner != self.id)
        {
            return Err("Omikron discovery returned a different or invalid owner".into());
        }
        if self.port == 0
            || self.ip_address.trim() != self.ip_address
            || self.ip_address.contains(['/', '?', '#', '@', '\\'])
        {
            return Err("Omikron discovery returned an invalid endpoint".into());
        }
        let mut url = reqwest::Url::parse("https://localhost").expect("static HTTPS URL");
        if let Ok(ip) = self.ip_address.parse::<std::net::IpAddr>() {
            url.set_ip_host(ip)
                .map_err(|_| "invalid Omikron IP address")?;
        } else {
            url.set_host(Some(&self.ip_address))
                .map_err(|_| "invalid Omikron hostname")?;
        }
        url.set_port(Some(self.port))
            .map_err(|_| "invalid Omikron port")?;
        let key = PublicKeyBundle::from_bytes(&decode_browser_base64(&self.public_key)?)
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        key.validate()
            .map_err(|error| format!("invalid Omikron public key: {error}"))?;
        Ok((url.to_string(), self.public_key))
    }
}

pub(super) async fn lookup_omikron(
    config: &MtpConfig,
    owner: Option<u64>,
) -> Result<(String, String), String> {
    let root = config.omega_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20));
    #[cfg(target_os = "android")]
    let client = {
        let roots = android_root_certificates()?;
        client.tls_certs_only(
            reqwest::Certificate::from_pem_bundle(&roots)
                .map_err(|error| format!("invalid Android root certificates: {error}"))?,
        )
    };
    let path = match owner {
        Some(owner) => format!("{root}/api/get/omikron/{owner}"),
        None => format!("{root}/api/get/user/{}/omikron", config.user_id),
    };
    let mut response = client
        .build()
        .map_err(|error| error.to_string())?
        .get(path)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Omikron lookup failed: {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 192 * 1024 {
            return Err("Omikron discovery exceeds the JSON control budget".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<OmikronDiscovery>(&bytes)
        .map_err(|error| error.to_string())?
        .endpoint(owner)
}
