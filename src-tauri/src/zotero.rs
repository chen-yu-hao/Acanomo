use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ZoteroExportRecord {
    key: String,
    citation_key: String,
    bibtex: String,
    csl_item: Value,
    citation_html: Option<String>,
    bibliography_html: Option<String>,
}

struct StyledCslItem {
    csl_item: Value,
    citation_html: Option<String>,
    bibliography_html: Option<String>,
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
pub(crate) async fn zotero_items(
    keys: Vec<String>,
    style: String,
) -> Result<Vec<ZoteroRecord>, String> {
    if style != "nature" && style != "apa" {
        return Err("不支持的文献样式".into());
    }
    let keys: Vec<_> = keys
        .into_iter()
        .filter(|key| {
            key.len() == 8
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        })
        .collect();
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let response = client()?
        .get(format!("{API_BASE}/users/0/items/top"))
        .query(&[
            ("itemKey", keys.join(",")),
            ("include", "data,citation".into()),
            ("style", style),
            ("limit", "100".into()),
        ])
        .send()
        .await
        .map_err(|error| format!("无法读取 Zotero 文献：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Zotero 请求失败：{error}"))?;
    response
        .json()
        .await
        .map_err(|error| format!("Zotero 响应无效：{error}"))
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
    response
        .json()
        .await
        .map_err(|error| format!("Zotero 响应无效：{error}"))
}

#[tauri::command]
pub(crate) async fn zotero_export_items(
    keys: Vec<String>,
    citation_style: String,
) -> Result<Vec<ZoteroExportRecord>, String> {
    let zotero_style = zotero_style_for_citation_style(&citation_style)?;
    let mut unique_keys = Vec::new();
    for key in keys {
        if !is_item_key(&key) {
            return Err(format!("无效的 Zotero item key：{key}"));
        }
        if !unique_keys.contains(&key) {
            unique_keys.push(key);
        }
    }
    if unique_keys.is_empty() {
        return Ok(Vec::new());
    }
    if unique_keys.len() > 100 {
        return Err("一次最多导出 100 条 Zotero 文献".into());
    }

    let client = client()?;
    let styled_response = client
        .get(format!("{API_BASE}/users/0/items/top"))
        .query(&[
            ("itemKey", unique_keys.join(",")),
            ("format", "json".into()),
            ("include", "data,csljson,citation,bib".into()),
            ("style", zotero_style.into()),
            ("limit", "100".into()),
        ])
        .send()
        .await
        .map_err(|error| format!("无法读取 Zotero 导出数据：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Zotero 导出请求失败：{error}"))?;
    let api_rows: Vec<Value> = styled_response
        .json()
        .await
        .map_err(|error| format!("Zotero 导出响应无效：{error}"))?;
    let mut styled_by_key = HashMap::new();
    for row in api_rows {
        if let Some((key, item)) = styled_csl_item_from_api(&row) {
            styled_by_key.insert(key, item);
        }
    }

    let mut records = Vec::with_capacity(unique_keys.len());
    for key in unique_keys {
        let Some(styled_item) = styled_by_key.remove(&key) else {
            continue;
        };
        let bibtex = client
            .get(format!("{API_BASE}/users/0/items/{key}"))
            .query(&[("format", "bibtex")])
            .send()
            .await
            .map_err(|error| format!("无法读取 Zotero BibTeX（{key}）：{error}"))?
            .error_for_status()
            .map_err(|error| format!("Zotero BibTeX 请求失败（{key}）：{error}"))?
            .text()
            .await
            .map_err(|error| format!("Zotero BibTeX 响应无效（{key}）：{error}"))?;
        let citation_key = extract_bibtex_citation_key(&bibtex)
            .ok_or_else(|| format!("无法从 Zotero BibTeX 提取 citekey：{key}"))?;
        records.push(ZoteroExportRecord {
            key,
            citation_key,
            bibtex: bibtex.trim().to_string(),
            csl_item: styled_item.csl_item,
            citation_html: styled_item.citation_html,
            bibliography_html: styled_item.bibliography_html,
        });
    }
    Ok(records)
}

fn zotero_style_for_citation_style(citation_style: &str) -> Result<&'static str, String> {
    match citation_style {
        "numeric" => Ok("nature"),
        "author-year" => Ok("apa"),
        _ => Err("不支持的引用样式".into()),
    }
}

fn styled_csl_item_from_api(row: &Value) -> Option<(String, StyledCslItem)> {
    let key = row.get("key")?.as_str()?;
    if !is_item_key(key) {
        return None;
    }
    let csl_json = row.get("csljson")?;
    let parsed = match csl_json {
        Value::String(value) => serde_json::from_str::<Value>(value).ok()?,
        value => value.clone(),
    };
    let mut csl_item = match parsed {
        Value::Array(items) => items.into_iter().next()?.as_object()?.clone(),
        Value::Object(item) => item,
        _ => return None,
    };
    let uri = canonical_item_uri(row, &csl_item, key);
    csl_item.insert("id".into(), Value::String(uri));
    Some((
        key.to_string(),
        StyledCslItem {
            csl_item: Value::Object(csl_item),
            citation_html: row
                .get("citation")
                .and_then(Value::as_str)
                .map(str::to_string),
            bibliography_html: row.get("bib").and_then(Value::as_str).map(str::to_string),
        },
    ))
}

fn canonical_item_uri(row: &Value, csl_item: &serde_json::Map<String, Value>, key: &str) -> String {
    let candidates = [
        row.pointer("/data/uri").and_then(Value::as_str),
        row.get("uri").and_then(Value::as_str),
        csl_item.get("id").and_then(Value::as_str),
    ];
    for uri in candidates.into_iter().flatten() {
        if item_key_from_csl_id(uri) == Some(key) {
            return uri.trim_end_matches('/').to_string();
        }
    }

    let library = row.get("library");
    let library_type = library
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let library_id = library
        .and_then(|value| value.get("id"))
        .and_then(|value| match value {
            Value::Number(number) => Some(number.to_string()),
            Value::String(id) if id.bytes().all(|byte| byte.is_ascii_digit()) => Some(id.clone()),
            _ => None,
        });
    if let (Some(library_type), Some(library_id)) = (library_type, library_id) {
        let library_segment = match library_type {
            "user" => Some("users"),
            "group" => Some("groups"),
            _ => None,
        };
        if let Some(library_segment) = library_segment {
            return format!("http://zotero.org/{library_segment}/{library_id}/items/{key}");
        }
    }

    // users/0 is Zotero's documented alias for the local user library and is
    // resolvable by the desktop integration even when the library is unsynced.
    format!("http://zotero.org/users/0/items/{key}")
}

fn is_item_key(key: &str) -> bool {
    key.len() == 8
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn item_key_from_csl_id(id: &str) -> Option<&str> {
    let path = id
        .strip_prefix("http://zotero.org/")
        .or_else(|| id.strip_prefix("https://zotero.org/"))?
        .trim_end_matches('/');
    let segments: Vec<_> = path.split('/').collect();
    let key = match segments.as_slice() {
        ["users" | "groups", library_id, "items", key]
            if !library_id.is_empty() && library_id.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            *key
        }
        ["users", "local", local_user_key, "items", key]
            if !local_user_key.is_empty()
                && local_user_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') =>
        {
            *key
        }
        _ => return None,
    };
    is_item_key(key).then_some(key)
}

fn extract_bibtex_citation_key(bibtex: &str) -> Option<String> {
    for line in bibtex.lines() {
        let trimmed = line.trim_start().trim_start_matches('\u{feff}');
        if !trimmed.starts_with('@') {
            continue;
        }
        let open = trimmed.find(['{', '('])?;
        let entry_type = trimmed[1..open].trim();
        if entry_type.eq_ignore_ascii_case("comment")
            || entry_type.eq_ignore_ascii_case("preamble")
            || entry_type.eq_ignore_ascii_case("string")
        {
            continue;
        }
        let rest = &trimmed[open + 1..];
        let comma = rest.find(',')?;
        let key = rest[..comma].trim();
        if !key.is_empty() {
            return Some(key.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        canonical_item_uri, extract_bibtex_citation_key, item_key_from_csl_id,
        styled_csl_item_from_api, zotero_style_for_citation_style,
    };

    #[test]
    fn extracts_bibtex_key_without_confusing_it_with_zotero_item_key() {
        let bibtex = "\n@article{gagliardi_multiconfiguration_2017,\n  title = {Test},\n}\n";
        assert_eq!(
            extract_bibtex_citation_key(bibtex).as_deref(),
            Some("gagliardi_multiconfiguration_2017")
        );
    }

    #[test]
    fn ignores_bibtex_directives_before_the_entry() {
        let bibtex = "@string{journal = {Nature}}\n@article(Key-2024,\n title={Test}\n)";
        assert_eq!(
            extract_bibtex_citation_key(bibtex).as_deref(),
            Some("Key-2024")
        );
    }

    #[test]
    fn reads_item_key_from_canonical_csl_uri() {
        assert_eq!(
            item_key_from_csl_id("http://zotero.org/users/20774538/items/D9PGQUM4"),
            Some("D9PGQUM4")
        );
        assert_eq!(
            item_key_from_csl_id("http://zotero.org/users/local/a1_B2/items/D9PGQUM4"),
            Some("D9PGQUM4")
        );
        assert_eq!(item_key_from_csl_id("not-a-zotero-uri"), None);
        assert_eq!(
            item_key_from_csl_id("https://example.com/users/20774538/items/D9PGQUM4"),
            None
        );
    }

    #[test]
    fn maps_document_citation_styles_to_matching_zotero_styles() {
        assert_eq!(
            zotero_style_for_citation_style("numeric").unwrap(),
            "nature"
        );
        assert_eq!(
            zotero_style_for_citation_style("author-year").unwrap(),
            "apa"
        );
        assert!(zotero_style_for_citation_style("unknown").is_err());
    }

    #[test]
    fn parses_csl_and_matching_styled_html_from_one_api_record() {
        let row = json!({
            "key": "D9PGQUM4",
            "csljson": "[{\"id\":\"http://zotero.org/users/20774538/items/D9PGQUM4\",\"type\":\"article-journal\"}]",
            "citation": "<sup>1</sup>",
            "bib": "<div class=\"csl-entry\"><i>Journal</i></div>"
        });
        let (key, item) = styled_csl_item_from_api(&row).expect("valid Zotero export row");
        assert_eq!(key, "D9PGQUM4");
        assert_eq!(
            item.csl_item.get("id").and_then(Value::as_str),
            Some("http://zotero.org/users/20774538/items/D9PGQUM4")
        );
        assert_eq!(item.citation_html.as_deref(), Some("<sup>1</sup>"));
        assert!(item
            .bibliography_html
            .as_deref()
            .is_some_and(|value| value.contains("<i>Journal</i>")));
    }

    #[test]
    fn replaces_a_csl_citation_key_id_with_the_data_uri() {
        let row = json!({
            "key": "D9PGQUM4",
            "data": {
                "uri": "http://zotero.org/users/local/a1_B2/items/D9PGQUM4"
            },
            "csljson": [{
                "id": "gagliardi_multiconfiguration_2017",
                "type": "article-journal"
            }]
        });

        let (_, item) = styled_csl_item_from_api(&row).expect("valid Zotero export row");
        assert_eq!(
            item.csl_item.get("id").and_then(Value::as_str),
            Some("http://zotero.org/users/local/a1_B2/items/D9PGQUM4")
        );
    }

    #[test]
    fn builds_a_group_uri_when_csl_json_has_no_canonical_id() {
        let row = json!({
            "key": "D9PGQUM4",
            "library": { "type": "group", "id": 428 },
            "csljson": [{
                "id": "gagliardi_multiconfiguration_2017",
                "type": "article-journal"
            }]
        });

        let (_, item) = styled_csl_item_from_api(&row).expect("valid Zotero export row");
        assert_eq!(
            item.csl_item.get("id").and_then(Value::as_str),
            Some("http://zotero.org/groups/428/items/D9PGQUM4")
        );
    }

    #[test]
    fn falls_back_to_the_local_user_alias_without_library_metadata() {
        let row = json!({
            "key": "D9PGQUM4",
            "csljson": [{ "type": "article-journal" }]
        });
        let item = row["csljson"][0].as_object().expect("CSL JSON object");

        assert_eq!(
            canonical_item_uri(&row, item, "D9PGQUM4"),
            "http://zotero.org/users/0/items/D9PGQUM4"
        );
    }
}
