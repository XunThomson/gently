//! 插件返回值的**形状适配**：从返回的 JSON 里取出条目数组（ADR-0006 待完成第 2 项）。
//!
//! 自有 ABI 的形状是我们自己定的（裸数组），但兼容插件按社区协议返回**包裹形状**，
//! 而且不同方法包的名字还不一样。这里集中处理「列表从哪来」，
//! 让上层（`catalog`、将来的详情命令）只管归一化字段，不必各自 `match` 一遍。
//!
//! 依据 MusicFree 插件协议（`search` / `getArtistWorks` / `getRecommendSheetsByTag` /
//! `getMusicComments` → `{isEnd, data}`；`getAlbumInfo` / `getMusicSheetInfo` /
//! `getTopListDetail` → `{isEnd, musicList}`；自有 ABI 与部分社区插件直接返回裸数组）：
//!
//! | 形状 | 出处 |
//! |---|---|
//! | `[...]` | 我们的 ABI、部分社区插件 |
//! | `{items: [...]}` | 我们的 ABI |
//! | `{isEnd?, data: [...]}` | MusicFree 搜索 / 歌手作品 / 推荐歌单 / 评论 |
//! | `{isEnd?, musicList: [...]}` | MusicFree 专辑 / 歌单 / 排行榜详情 |
//!
//! **不做泛化猜测**（不接受 `list`、`result` 这类未在协议里出现的键名）：
//! 清单外的形状一律按「没有列表」处理，由调用方计数并丢弃。

use serde_json::Value;

/// 列表可能出现的键名（顺序即优先级）。
const LIST_KEYS: [&str; 3] = ["items", "data", "musicList"];

/// 取出条目数组；拿不到返回 `None`（调用方据此「丢弃并计数」，而不是让整次调用失败）。
///
/// 注：MusicFree 的 `isEnd` 表示「还有下一页」。M2 的搜索只取第一页，
/// 因此这里**暂时忽略**它——分页落地时在同一处读取即可。
pub fn list_items(value: &Value) -> Option<&[Value]> {
    match value {
        Value::Array(items) => Some(items),
        Value::Object(map) => LIST_KEYS
            .iter()
            .find_map(|key| map.get(*key).and_then(|value| value.as_array()).map(Vec::as_slice)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_bare_arrays_and_known_wrappers() {
        let bare = json!([{"id": "1"}]);
        assert_eq!(list_items(&bare).map(<[Value]>::len), Some(1));

        let items = json!({"items": [{"id": "1"}, {"id": "2"}]});
        assert_eq!(list_items(&items).map(<[Value]>::len), Some(2));

        // MusicFree 搜索：`{isEnd, data}`
        let musicfree = json!({"isEnd": false, "data": [{"id": "a"}]});
        assert_eq!(list_items(&musicfree).and_then(|items| items[0]["id"].as_str()), Some("a"));

        // 兼容「省略 isEnd」的写法
        let no_flag = json!({"data": []});
        assert_eq!(list_items(&no_flag).map(<[Value]>::len), Some(0));

        // MusicFree 详情：`{isEnd, musicList}`
        let detail = json!({"isEnd": true, "musicList": [{"id": "a"}, {"id": "b"}]});
        assert_eq!(list_items(&detail).map(<[Value]>::len), Some(2));
    }

    #[test]
    fn rejects_unrelated_shapes_instead_of_guessing() {
        // 协议里没出现过的键名：不猜
        assert!(list_items(&json!({"list": [1, 2]})).is_none());
        assert!(list_items(&json!({"result": [1, 2]})).is_none());
        // 包裹里不是数组（例如 getMusicInfo 返回的对象片段）
        assert!(list_items(&json!({"data": {"id": "a"}})).is_none());
        // 空对象、null、字符串、数字
        assert!(list_items(&json!({})).is_none());
        assert!(list_items(&Value::Null).is_none());
        assert!(list_items(&json!("[]")).is_none());
        assert!(list_items(&json!(3)).is_none());
    }
}
