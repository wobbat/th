use serde::{Deserialize, Serialize};
use reqwest::Client;
use std::fs;
use std::path::PathBuf;
use std::env;
use chrono::Utc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthInfo {
    #[serde(rename = "type")]
    pub auth_type: String,
    pub refresh: Option<String>,
    pub access: Option<String>,
    pub expires: Option<i64>,
    pub key: Option<String>,
    pub token: Option<String>,
}

pub fn get_config_path() -> PathBuf {
    let config_dir = env::var("XDG_CONFIG_HOME")
        .unwrap_or_else(|_| format!("{}/.config", env::var("HOME").unwrap_or_else(|_| "/home/user".to_string())));
    PathBuf::from(config_dir).join("008").join("auth.json")
}

pub async fn get_auth_info(provider: &str) -> Option<AuthInfo> {
    let path = get_config_path();
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(info) = data.get(provider) {
                return serde_json::from_value(info.clone()).ok();
            }
        }
    }
    None
}

pub async fn set_auth_info(provider: &str, info: AuthInfo) -> Result<(), Box<dyn std::error::Error>> {
    let path = get_config_path();
    fs::create_dir_all(path.parent().unwrap())?;
    let mut data: serde_json::Value = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path)?).unwrap_or_default()
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };
    data[provider] = serde_json::to_value(&info)?;
    fs::write(&path, serde_json::to_string_pretty(&data)?)?;
    // Set permissions to 600, but in Rust, fs::set_permissions not directly, skip for now
    Ok(())
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i32,
    interval: i32,
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    #[allow(dead_code)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CopilotTokenResponse {
    token: String,
    expires_at: i64,
    #[allow(dead_code)]
    refresh_in: i64,
    #[allow(dead_code)]
    endpoints: serde_json::Value,
}

#[derive(Debug)]
pub struct DeviceAuth {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: i32,
    #[allow(dead_code)]
    pub expires_in: i32,
}

#[derive(Debug)]
pub enum PollResult {
    Pending,
    Complete,
    Failed(String),
    SlowDown,
}

pub async fn authorize() -> Result<DeviceAuth, Box<dyn std::error::Error>> {
    let client = Client::new();
    let response = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .json(&serde_json::json!({
            "client_id": "Iv1.b507a08c87ecfe98",
            "scope": "read:user"
        }))
        .send()
        .await?;

    let data: DeviceCodeResponse = response.json().await?;
    Ok(DeviceAuth {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        interval: data.interval,
        expires_in: data.expires_in,
    })
}

pub async fn poll(device_code: &str) -> Result<PollResult, Box<dyn std::error::Error>> {
    let client = Client::new();
    let response = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .json(&serde_json::json!({
            "client_id": "Iv1.b507a08c87ecfe98",
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }))
        .send()
        .await?;

    let data: AccessTokenResponse = response.json().await?;
    if let Some(token) = data.access_token {
        // Store the GitHub OAuth token
        let info = AuthInfo {
            auth_type: "oauth".to_string(),
            refresh: Some(token),
            access: None,
            expires: None,
            key: None,
            token: None,
        };
        set_auth_info("github-copilot", info).await?;
        Ok(PollResult::Complete)
    } else if data.error.as_deref() == Some("authorization_pending") {
        Ok(PollResult::Pending)
    } else if data.error.as_deref() == Some("slow_down") {
        Ok(PollResult::SlowDown)
    } else {
        let error_msg = data.error.unwrap_or_else(|| "unknown error".to_string());
        Ok(PollResult::Failed(error_msg))
    }
}

async fn validate_github_token(token: &str) -> bool {
    let client = Client::new();
    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .send()
        .await;

    match response {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

pub async fn access() -> Result<Option<String>, Box<dyn std::error::Error>> {
    let info = match get_auth_info("github-copilot").await {
        Some(i) if i.auth_type == "oauth" => i,
        _ => return Ok(None),
    };

    let refresh = info.refresh.as_ref().ok_or("No refresh token")?;

    // Validate the GitHub token
    if !validate_github_token(refresh).await {
        return Ok(None); // Token invalid, need re-auth
    }

    if let (Some(access), Some(expires)) = (&info.access, &info.expires) {
        if *expires > Utc::now().timestamp_millis() {
            return Ok(Some(access.clone()));
        }
    }

    // Get new Copilot API token
    let client = Client::new();
    let response = client
        .get("https://api.github.com/copilot_internal/v2/token")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", refresh))
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .header("Editor-Version", "vscode/1.99.3")
        .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
        .send()
        .await?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let token_data: CopilotTokenResponse = response.json().await?;

    // Store the Copilot API token
    let new_info = AuthInfo {
        auth_type: "oauth".to_string(),
        refresh: Some(refresh.clone()),
        access: Some(token_data.token.clone()),
        expires: Some(token_data.expires_at * 1000),
        key: None,
        token: None,
    };
    set_auth_info("github-copilot", new_info).await?;

    Ok(Some(token_data.token))
}