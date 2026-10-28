use crate::{
    dto::Response,
    error::{AppError, Result},
};
use tauri_plugin_updater::{Update, UpdaterExt};
pub fn configured(config: &tauri::Config) -> Result<tauri_plugin_updater::Config> {
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(config.plugins.0.get("updater").cloned().unwrap_or_default())
            .map_err(|_| AppError::new("update", "Bundled updater configuration is invalid"))?;
    if config.pubkey.trim().is_empty() && config.endpoints.is_empty() {
        return Err(AppError::new(
            "unavailable",
            "Updates are unavailable in this development build. A release must embed an authorized public key and HTTPS endpoint.",
        ));
    }
    if config.pubkey.trim().is_empty()
        || config.endpoints.is_empty()
        || !config.require_signed_version
        || config.allow_downgrades
        || config.dangerous_insecure_transport_protocol
        || config.dangerous_accept_invalid_certs
        || config.dangerous_accept_invalid_hostnames
        || config.endpoints.iter().any(|url| {
            url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
        })
    {
        return Err(AppError::new(
            "update",
            "Bundled updater requires an authorized key, public HTTPS endpoint, signed version and downgrade refusal",
        ));
    }
    Ok(config)
}
pub async fn check(app: &tauri::AppHandle) -> Result<(Response, Option<Update>)> {
    let config = configured(app.config())?;
    let updater = app
        .updater_builder()
        .restart_after_install(false)
        .pubkey(config.pubkey)
        .endpoints(config.endpoints)
        .map_err(|_| AppError::new("update", "Updater configuration rejected"))?
        .build()
        .map_err(|_| AppError::new("update", "Updater initialization failed"))?;
    let update = updater.check().await.map_err(|_| {
        AppError::new(
            "update",
            "Update check failed; verification remains enabled",
        )
    })?;
    let message=update.as_ref().map(|u|format!("Update available: {}. Its signature and signed version will be verified before installation. Review and stop all project activity before installation.",u.version)).unwrap_or_else(||"No newer update is available".into());
    Ok((Response::Text { text: message }, update))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn product() -> tauri::Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }
    #[test]
    fn development_updates_are_explicitly_unavailable() {
        assert_eq!(configured(&product()).unwrap_err().code, "unavailable");
    }
    #[test]
    fn release_uses_the_embedded_config_without_compile_environment_switches() {
        let mut config = product();
        let updater = config.plugins.0.get_mut("updater").unwrap();
        updater["pubkey"] = "fixture-key".into();
        updater["endpoints"] = serde_json::json!(["https://updates.example.invalid/{{target}}"]);
        assert!(configured(&config).is_ok());
        for (field, value) in [
            ("requireSignedVersion", false),
            ("allowDowngrades", true),
            ("dangerousAcceptInvalidCerts", true),
            ("dangerousAcceptInvalidHostnames", true),
            ("dangerousInsecureTransportProtocol", true),
        ] {
            let mut unsafe_config = config.clone();
            unsafe_config.plugins.0.get_mut("updater").unwrap()[field] = value.into();
            assert!(configured(&unsafe_config).is_err(), "{field}");
        }
        for url in [
            "http://updates.example.invalid",
            "https://user:secret@updates.example.invalid",
            "https://updates.example.invalid?token=secret",
        ] {
            config.plugins.0.get_mut("updater").unwrap()["endpoints"] = serde_json::json!([url]);
            assert!(configured(&config).is_err());
        }
    }
}
pub async fn install(update: Update) -> Result<Response> {
    update.download_and_install(|_,_|{},||{}).await.map_err(|_|AppError::new("update","Update was not installed successfully. Signature verification remains mandatory; inspect installation state before retrying."))?;
    Ok(Response::Text{text:"Verified update installed. Restart explicitly when ready; this app does not automatically restart a running task.".into()})
}
