//! DB-space merge, ported from `src/main/sync/merge.ts`. Git is transport
//! only; conflicts resolve here, never as git conflict markers. Rules in
//! application order:
//!   1. Spaces — LWW with clock convergence for identical content.
//!   2. Tombstones — union by (fingerprint, createdAt); a local active memory
//!      dies only if its edit clock is OLDER than the forget decision, so an
//!      undo (newer edit) survives stale files.
//!   3. Memories — unknown id inserts unless its fingerprint is tombstoned
//!      locally (never resurrect); known id is last-write-wins on edited_at
//!      with a symmetric content tie-break.
//!   4. Settings — per-key LWW over the curated key list only, values
//!      normalized before they touch the store.
//! File ABSENCE is never deletion — deletes travel only via tombstones.

use crate::db::{Db, FullMemoryRow};
use crate::settings::normalize_setting_value;
use crate::sync::format::{SyncTree, SYNCED_SETTINGS};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImportCounts {
    pub memories_added: usize,
    pub memories_updated: usize,
    pub tombstones_added: usize,
    pub tombstones_applied: usize,
    pub spaces_changed: usize,
    pub settings_changed: usize,
}

/// Durable fields only — local ranking signals never count as a difference.
fn durably_differs(local: &FullMemoryRow, remote: &FullMemoryRow) -> bool {
    local.content != remote.content
        || local.status != remote.status
        || local.pinned != remote.pinned
        || local.mtype != remote.mtype
        || local.scope != remote.scope
        || local.space_id != remote.space_id
        || local.source_hash.clone().unwrap_or_default()
            != remote.source_hash.clone().unwrap_or_default()
}

/// Symmetric tie-break for equal edit clocks: higher content string wins.
fn remote_wins_tie(local: &FullMemoryRow, remote: &FullMemoryRow) -> bool {
    remote.content > local.content
        || (remote.content == local.content && remote.status > local.status)
}

pub fn import_tree(db: &Db, tree: &SyncTree, now: i64) -> ImportCounts {
    db.transaction(|| {
        let mut res = ImportCounts::default();

        // 1. Spaces (before memories so grouping targets exist).
        let local_spaces: std::collections::HashMap<String, crate::db::SpaceRow> = db
            .list_spaces()
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        for s in &tree.spaces {
            let Some(local) = local_spaces.get(&s.id) else {
                db.upsert_synced_space(&s.id, &s.name, s.icon.as_deref(), s.sort_order, s.created_at, s.updated_at);
                res.spaces_changed += 1;
                continue;
            };
            let local_clock = local.updated_at;
            let differs = local.name != s.name
                || local.icon != s.icon
                || local.sort_order != s.sort_order;
            if !differs {
                // Same content, different clocks — converge on the min so the
                // exported file stops ping-ponging between machines.
                let created_at = local.created_at.min(s.created_at);
                let updated_at = local_clock.min(s.updated_at);
                if created_at != local.created_at || updated_at != local_clock {
                    db.upsert_synced_space(&s.id, &local.name, local.icon.as_deref(), local.sort_order, created_at, updated_at);
                }
                continue;
            }
            if s.updated_at > local_clock || (s.updated_at == local_clock && s.name > local.name) {
                db.upsert_synced_space(&s.id, &s.name, s.icon.as_deref(), s.sort_order, s.created_at, s.updated_at);
                res.spaces_changed += 1;
            }
        }

        // 2. Tombstones — union, then apply behind the clock guard.
        for t in &tree.tombstones {
            if db.insert_tombstone_if_absent(t) {
                res.tombstones_added += 1;
            }
            for (id, edit_clock) in db.actives_by_fingerprint(&t.fingerprint) {
                if edit_clock >= t.created_at {
                    continue; // undo/edit is newer than the forget — it survives
                }
                db.mark_tombstoned(&id, now);
                res.tombstones_applied += 1;
            }
        }

        // 3. Memories.
        for m in &tree.memories {
            let Some(local) = db.get_memory_sync(&m.id) else {
                let fp = m.source_hash.clone().unwrap_or_default();
                if !fp.is_empty() && db.has_tombstone(&fp) {
                    continue; // never resurrect a forgotten fact
                }
                db.upsert_synced_memory(m, now);
                res.memories_added += 1;
                continue;
            };
            let local_clock = local.edited_at;
            if !durably_differs(&local, m) {
                // Identical content minted independently — converge clocks on
                // the min (also the conservative side of the tombstone guard).
                let created_at = local.created_at.min(m.created_at);
                let edited_at = local_clock.min(m.edited_at);
                if created_at != local.created_at || edited_at != local_clock {
                    let mut keep = local.clone();
                    keep.created_at = created_at;
                    keep.edited_at = edited_at;
                    db.upsert_synced_memory(&keep, now);
                }
                continue;
            }
            if m.edited_at > local_clock
                || (m.edited_at == local_clock && remote_wins_tie(&local, m))
            {
                db.upsert_synced_memory(m, now);
                res.memories_updated += 1;
            }
        }

        // 4. Settings — per-key LWW; only curated keys ever cross machines.
        for (key, remote) in &tree.settings {
            if !SYNCED_SETTINGS.contains(&key.as_str()) {
                continue;
            }
            let Some(value) = normalize_setting_value(key, &remote.value) else {
                continue;
            };
            let local = db.get_setting_row(key);
            if let Some((local_value, local_clock)) = &local {
                if *local_value == value {
                    if remote.edited_at < *local_clock {
                        db.set_setting_with_clock(key, local_value, remote.edited_at); // converge clocks
                    }
                    continue;
                }
                if remote.edited_at > *local_clock
                    || (remote.edited_at == *local_clock && value > *local_value)
                {
                    db.set_setting_with_clock(key, &value, remote.edited_at);
                    res.settings_changed += 1;
                }
            } else {
                db.set_setting_with_clock(key, &value, remote.edited_at);
                res.settings_changed += 1;
            }
        }

        res
    })
}
