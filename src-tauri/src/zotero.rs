use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const API_BASE: &str = "http://127.0.0.1:23119/api";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZoteroRecord {
    key: String,
    version: Option<u64>,
    data: Value,
    citation: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("Zotero 客户端初始化失败：{error}"))
}

#[tauri::command]
pub(crate) async fn zotero_status() -> Result<bool, String> {
    let response = client()?
        .get(format!("{API_BASE}/"))
        .send()
        .await
        .map_err(|error| format!("无法连接本机 Zotero：{error}"))?;
    Ok(response.status().is_success())
}

#[tauri::command]
pub(crate) async fn zotero_items(keys: Vec<String>, style: String) -> Result<Vec<ZoteroRecord>, String> {
    if style != "nature" && style != "apa" {
        return Err("不支持的文献样式".into());
    }
    let keys: Vec<_> = keys.into_iter().filter(|key| {
        key.len() == 8 && key.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    }).collect();
    if keys.is_empty() { return Ok(Vec::new()); }
    let response = client()?
        .get(format!("{API_BASE}/users/0/items/top"))
        .query(&[("itemKey", keys.join(",")), ("include", "data,citation".into()), ("style", style), ("limit", "100".into())])
        .send()
        .await
        .map_err(|error| format!("无法读取 Zotero 文献：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Zotero 请求失败：{error}"))?;
    response.json().await.map_err(|error| format!("Zotero 响应无效：{error}"))
}

#[tauri::command]
pub(crate) async fn zotero_search(query: String) -> Result<Vec<ZoteroRecord>, String> {
    let query = query.trim();
    if query.chars().count() > 200 {
        return Err("搜索文本过长".into());
    }
    let response = client()?
        .get(format!("{API_BASE}/users/0/items/top"))
        .query(&[("q", query), ("include", "data"), ("limit", "30")])
        .send()
        .await
        .map_err(|error| format!("无法搜索本机 Zotero：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Zotero 搜索失败：{error}"))?;
    response.json().await.map_err(|error| format!("Zotero 响应无效：{error}"))
}
