//! SQLite metadata index. Only filesystem metadata is stored; file contents
//! are never read by the indexer.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

pub const KIND_FILE: i64 = 0;
pub const KIND_DIR: i64 = 1;
pub const KIND_LINK: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS roots (
    id         INTEGER PRIMARY KEY,
    path       TEXT NOT NULL UNIQUE,
    added_at   INTEGER NOT NULL,
    last_scan  INTEGER,
    status     TEXT NOT NULL DEFAULT 'pending',
    message    TEXT
);
CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY,
    root_id     INTEGER NOT NULL,
    parent_id   INTEGER,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL,
    ext         TEXT NOT NULL,
    kind        INTEGER NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    file_count  INTEGER NOT NULL DEFAULT 0,
    dir_count   INTEGER NOT NULL DEFAULT 0,
    modified    INTEGER,
    created     INTEGER,
    category    TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    path        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id, size DESC, name_lower, id);
CREATE INDEX IF NOT EXISTS idx_entries_name ON entries(name_lower);
CREATE INDEX IF NOT EXISTS idx_entries_ext ON entries(ext);
CREATE INDEX IF NOT EXISTS idx_entries_root ON entries(root_id, depth);
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA temp_store=MEMORY;",
    )?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub root_id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: i64,
    pub file_count: i64,
    pub dir_count: i64,
    pub modified: Option<i64>,
    pub created: Option<i64>,
    pub category: String,
    pub depth: i64,
    pub path: String,
}

const ENTRY_COLS: &str =
    "id, root_id, parent_id, name, ext, kind, size, file_count, dir_count, modified, created, category, depth, path";

fn entry_from_row(r: &Row) -> rusqlite::Result<Entry> {
    let kind: i64 = r.get(5)?;
    Ok(Entry {
        id: r.get(0)?,
        root_id: r.get(1)?,
        parent_id: r.get(2)?,
        name: r.get(3)?,
        ext: r.get(4)?,
        kind: match kind {
            KIND_DIR => "dir",
            KIND_LINK => "link",
            _ => "file",
        },
        size: r.get(6)?,
        file_count: r.get(7)?,
        dir_count: r.get(8)?,
        modified: r.get(9)?,
        created: r.get(10)?,
        category: r.get(11)?,
        depth: r.get(12)?,
        path: r.get(13)?,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: i64,
    pub path: String,
    pub added_at: i64,
    pub last_scan: Option<i64>,
    pub status: String,
    pub message: Option<String>,
    /// The root directory's own entry, present once a scan has completed.
    pub entry: Option<Entry>,
}

/// SQL fragment + params that hide disabled categories.
fn visibility(hidden: &[&str]) -> (String, Vec<String>) {
    if hidden.is_empty() {
        return ("1".into(), vec![]);
    }
    let ph = vec!["?"; hidden.len()].join(",");
    (format!("category NOT IN ({ph})"), hidden.iter().map(|s| s.to_string()).collect())
}

pub fn list_roots(conn: &Connection) -> rusqlite::Result<Vec<RootInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, added_at, last_scan, status, message FROM roots ORDER BY path",
    )?;
    let mut roots: Vec<RootInfo> = stmt
        .query_map([], |r| {
            Ok(RootInfo {
                id: r.get(0)?,
                path: r.get(1)?,
                added_at: r.get(2)?,
                last_scan: r.get(3)?,
                status: r.get(4)?,
                message: r.get(5)?,
                entry: None,
            })
        })?
        .collect::<Result<_, _>>()?;
    for root in &mut roots {
        root.entry = conn
            .query_row(
                &format!("SELECT {ENTRY_COLS} FROM entries WHERE root_id = ?1 AND parent_id IS NULL"),
                [root.id],
                entry_from_row,
            )
            .optional()?;
    }
    Ok(roots)
}

pub fn add_root(conn: &Connection, path: &str, now: i64) -> rusqlite::Result<i64> {
    if let Some(id) = conn
        .query_row("SELECT id FROM roots WHERE path = ?1 COLLATE NOCASE", [path], |r| r.get(0))
        .optional()?
    {
        return Ok(id);
    }
    conn.execute("INSERT INTO roots(path, added_at) VALUES (?1, ?2)", params![path, now])?;
    Ok(conn.last_insert_rowid())
}

pub fn root_path(conn: &Connection, root_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT path FROM roots WHERE id = ?1", [root_id], |r| r.get(0)).optional()
}

/// Removes a root from the index. The real folder is never touched.
pub fn remove_root(conn: &mut Connection, root_id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM entries WHERE root_id = ?1", [root_id])?;
    tx.execute("DELETE FROM roots WHERE id = ?1", [root_id])?;
    tx.commit()
}

pub fn set_root_status(
    conn: &Connection,
    root_id: i64,
    status: &str,
    message: Option<&str>,
    last_scan: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE roots SET status = ?2, message = ?3, last_scan = COALESCE(?4, last_scan) WHERE id = ?1",
        params![root_id, status, message, last_scan],
    )?;
    Ok(())
}

pub fn get_entry(conn: &Connection, id: i64) -> rusqlite::Result<Option<Entry>> {
    conn.query_row(&format!("SELECT {ENTRY_COLS} FROM entries WHERE id = ?1"), [id], entry_from_row)
        .optional()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildPage {
    pub parent_id: i64,
    pub offset: i64,
    pub items: Vec<Entry>,
    /// Number of visible children in total.
    pub total: i64,
    /// Visible children after this page, and their combined size.
    pub remaining_count: i64,
    pub remaining_size: i64,
}

/// Children ordered by size (largest first), then name, then id. This order is
/// the basis of the deterministic globe layout and of `rank_in_parent`.
pub fn list_children(
    conn: &Connection,
    parent_id: i64,
    offset: i64,
    limit: i64,
    hidden: &[&str],
) -> rusqlite::Result<ChildPage> {
    let (vis, vis_params) = visibility(hidden);
    let mut p: Vec<rusqlite::types::Value> = vec![parent_id.into()];
    p.extend(vis_params.iter().cloned().map(Into::into));
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ENTRY_COLS} FROM entries WHERE parent_id = ? AND {vis}
         ORDER BY size DESC, name_lower ASC, id ASC LIMIT ? OFFSET ?"
    ))?;
    let mut page_params = p.clone();
    page_params.push(limit.into());
    page_params.push(offset.into());
    let items: Vec<Entry> =
        stmt.query_map(params_from_iter(page_params), entry_from_row)?.collect::<Result<_, _>>()?;

    let (total, total_size): (i64, i64) = conn.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM(size),0) FROM entries WHERE parent_id = ? AND {vis}"),
        params_from_iter(p.iter()),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (before_count, before_size): (i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(size),0) FROM (SELECT size FROM entries WHERE parent_id = ? AND {vis}
             ORDER BY size DESC, name_lower ASC, id ASC LIMIT ?)"
        ),
        params_from_iter(p.iter().cloned().chain(std::iter::once((offset + limit).into()))),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(ChildPage {
        parent_id,
        offset,
        items,
        total,
        remaining_count: total - before_count,
        remaining_size: total_size - before_size,
    })
}

/// Position of `entry` among its visible siblings in `list_children` order.
pub fn rank_in_parent(conn: &Connection, e: &Entry, hidden: &[&str]) -> rusqlite::Result<i64> {
    let Some(parent) = e.parent_id else { return Ok(0) };
    let (vis, vis_params) = visibility(hidden);
    let name_lower = e.name.to_lowercase();
    let mut p: Vec<rusqlite::types::Value> =
        vec![parent.into(), e.size.into(), e.size.into(), name_lower.clone().into(), e.size.into(), name_lower.into(), e.id.into()];
    p.extend(vis_params.into_iter().map(Into::into));
    conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM entries WHERE parent_id = ? AND (
                size > ? OR (size = ? AND name_lower < ?) OR (size = ? AND name_lower = ? AND id < ?)
             ) AND {vis}"
        ),
        params_from_iter(p),
        |r| r.get(0),
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateStep {
    pub entry: Entry,
    pub rank: i64,
}

/// Ancestor chain from the scan root down to `id` (inclusive), with each
/// entry's rank within its parent so the frontend can rebuild the layout.
pub fn locate(conn: &Connection, id: i64, hidden: &[&str]) -> rusqlite::Result<Option<Vec<LocateStep>>> {
    let mut chain = Vec::new();
    let mut cur = get_entry(conn, id)?;
    if let Some(e) = &cur {
        if hidden.contains(&e.category.as_str()) {
            return Ok(None);
        }
    }
    while let Some(e) = cur {
        let rank = rank_in_parent(conn, &e, hidden)?;
        let parent = e.parent_id;
        chain.push(LocateStep { entry: e, rank });
        cur = match parent {
            Some(p) => get_entry(conn, p)?,
            None => None,
        };
    }
    if chain.is_empty() {
        return Ok(None);
    }
    chain.reverse();
    Ok(Some(chain))
}

/// Finds an entry by its exact path (used to restore the view after a rescan,
/// which assigns new ids).
pub fn find_by_path(conn: &Connection, path: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM entries WHERE path = ?1 LIMIT 1", [path], |r| r.get(0)).optional()
}

/// Parsed search query. Supported syntax:
/// `report` (substring), `ext:pdf` / `*.pdf` / `.pdf`, `type:image`,
/// `kind:dir|file`, `in:foldername` (substring of the full path).
#[derive(Debug, Default, PartialEq)]
pub struct Query {
    pub terms: Vec<String>,
    pub exts: Vec<String>,
    pub types: Vec<String>,
    pub kind: Option<i64>,
    pub within: Vec<String>,
}

pub fn parse_query(q: &str) -> Query {
    let mut out = Query::default();
    for tok in q.split_whitespace() {
        let lower = tok.to_lowercase();
        if let Some(v) = lower.strip_prefix("ext:") {
            out.exts.extend(v.split(',').map(|s| s.trim_start_matches('.').to_string()).filter(|s| !s.is_empty()));
        } else if let Some(v) = lower.strip_prefix("type:") {
            out.types.extend(v.split(',').map(str::to_string).filter(|s| !s.is_empty()));
        } else if let Some(v) = lower.strip_prefix("kind:") {
            out.kind = match v {
                "dir" | "folder" | "directory" => Some(KIND_DIR),
                "file" => Some(KIND_FILE),
                _ => out.kind,
            };
        } else if let Some(v) = lower.strip_prefix("in:") {
            if !v.is_empty() {
                out.within.push(v.to_string());
            }
        } else if let Some(v) = lower.strip_prefix("*.") {
            if !v.is_empty() && !v.contains(['*', '?']) {
                out.exts.push(v.to_string());
            }
        } else if lower.len() > 1 && lower.starts_with('.') && !lower[1..].contains('.') {
            out.exts.push(lower[1..].to_string());
        } else {
            out.terms.push(lower);
        }
    }
    out
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn search(conn: &Connection, q: &str, limit: i64, hidden: &[&str]) -> rusqlite::Result<Vec<Entry>> {
    let parsed = parse_query(q);
    if parsed.terms.is_empty() && parsed.exts.is_empty() && parsed.types.is_empty() && parsed.within.is_empty() {
        return Ok(vec![]);
    }
    let mut clauses: Vec<String> = vec!["parent_id IS NOT NULL".into()];
    let mut p: Vec<rusqlite::types::Value> = Vec::new();
    for t in &parsed.terms {
        clauses.push("name_lower LIKE ? ESCAPE '\\'".into());
        p.push(format!("%{}%", like_escape(t)).into());
    }
    if !parsed.exts.is_empty() {
        clauses.push(format!("ext IN ({})", vec!["?"; parsed.exts.len()].join(",")));
        p.extend(parsed.exts.iter().cloned().map(Into::into));
    }
    if !parsed.types.is_empty() {
        clauses.push(format!("category IN ({})", vec!["?"; parsed.types.len()].join(",")));
        p.extend(parsed.types.iter().cloned().map(Into::into));
    }
    if let Some(k) = parsed.kind {
        clauses.push("kind = ?".into());
        p.push(k.into());
    }
    for w in &parsed.within {
        clauses.push("path LIKE ? ESCAPE '\\'".into());
        p.push(format!("%{}%", like_escape(w)).into());
    }
    let (vis, vis_params) = visibility(hidden);
    clauses.push(vis);
    p.extend(vis_params.into_iter().map(Into::into));

    // Rank exact name matches first, then prefix matches, then folders, then size.
    let first = parsed.terms.first().cloned().unwrap_or_default();
    let order = "CASE WHEN name_lower = ? THEN 0 WHEN name_lower LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, kind DESC, size DESC";
    p.push(first.clone().into());
    p.push(format!("{}%", like_escape(&first)).into());
    p.push(limit.into());
    let sql = format!("SELECT {ENTRY_COLS} FROM entries WHERE {} ORDER BY {order} LIMIT ?", clauses.join(" AND "));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(p), entry_from_row)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub entries: i64,
    pub files: i64,
    pub dirs: i64,
    pub total_size: i64,
}

pub fn stats(conn: &Connection) -> rusqlite::Result<IndexStats> {
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(kind = 0), 0),
                COALESCE(SUM(kind = 1), 0),
                COALESCE((SELECT SUM(size) FROM entries WHERE parent_id IS NULL), 0)
         FROM entries",
        [],
        |r| Ok(IndexStats { entries: r.get(0)?, files: r.get(1)?, dirs: r.get(2)?, total_size: r.get(3)? }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing() {
        let q = parse_query("Report ext:pdf,.docx type:document kind:file in:Projects *.txt .md");
        assert_eq!(q.terms, vec!["report"]);
        assert_eq!(q.exts, vec!["pdf", "docx", "txt", "md"]);
        assert_eq!(q.types, vec!["document"]);
        assert_eq!(q.kind, Some(KIND_FILE));
        assert_eq!(q.within, vec!["projects"]);
        assert_eq!(parse_query("archive.tar.gz").terms, vec!["archive.tar.gz"]);
    }
}
