/**
 * Persistence for plan references (roadmap S2-2).
 *
 * Kept separate from `level-reference.ts`, which is the pure drawing→meaning
 * mapping, so the mapping stays testable without a database and the DB layer
 * stays free of interpretation.
 *
 * The rule this module exists to enforce: **erasing the ink must not erase the
 * meaning.** A reference outlives the drawing it was promoted from, because a
 * plan may already be armed against it. Deleting a drawing clears the pointer
 * and leaves the reference standing.
 */

import { getDb } from "../db/database";
import { drawingToLevel, type LevelDraft, type PromoteOptions, type DrawingPoint } from "./level-reference";

export interface LevelReferenceRow {
  id: number;
  symbol: string;
  interval_min: number | null;
  label: string;
  level_json: string;
  drawing_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface LevelReference extends Omit<LevelReferenceRow, "level_json"> {
  level: LevelDraft;
}

function hydrate(row: LevelReferenceRow): LevelReference {
  const { level_json, ...rest } = row;
  return { ...rest, level: JSON.parse(level_json) as LevelDraft };
}

/** References for a symbol. NULL `interval_min` means "every timeframe", the
 *  same convention `listDrawings` uses. */
export function listLevelReferences(symbol: string, intervalMin?: number): LevelReference[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM level_references
        WHERE symbol = ? AND (interval_min IS NULL ${intervalMin !== undefined ? "OR interval_min = ?" : ""})
        ORDER BY created_at ASC`
    )
    .all(...(intervalMin !== undefined ? [symbol, intervalMin] : [symbol])) as unknown as LevelReferenceRow[];
  return rows.map(hydrate);
}

export function getLevelReference(id: number): LevelReference | null {
  const row = getDb().prepare(`SELECT * FROM level_references WHERE id = ?`).get(id) as
    | unknown as LevelReferenceRow
    | undefined;
  return row ? hydrate(row) : null;
}

export function saveLevelReference(input: {
  id?: number;
  symbol: string;
  intervalMin: number | null;
  label: string;
  level: LevelDraft;
  drawingId?: number | null;
}): LevelReference {
  const db = getDb();
  const now = Date.now();
  const json = JSON.stringify(input.level);

  if (input.id) {
    db.prepare(
      `UPDATE level_references SET symbol=?, interval_min=?, label=?, level_json=?, drawing_id=?, updated_at=?
        WHERE id=?`
    ).run(input.symbol, input.intervalMin, input.label, json, input.drawingId ?? null, now, input.id);
    return getLevelReference(input.id)!;
  }

  const res = db
    .prepare(
      `INSERT INTO level_references (symbol, interval_min, label, level_json, drawing_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.symbol, input.intervalMin, input.label, json, input.drawingId ?? null, now, now);

  return getLevelReference(Number(res.lastInsertRowid))!;
}

export function deleteLevelReference(id: number): { ok: true } {
  getDb().prepare(`DELETE FROM level_references WHERE id = ?`).run(id);
  return { ok: true };
}

/**
 * Clear the drawing pointer on any reference promoted from `drawingId`.
 *
 * Called when a drawing is deleted. The reference survives: a plan may be armed
 * against it, and a level that vanished because the trader tidied their chart
 * would be the worst kind of silent failure — the plan would still look armed
 * while its geometry had been erased underneath it.
 */
export function detachDrawing(drawingId: number): { detached: number } {
  const res = getDb()
    .prepare(`UPDATE level_references SET drawing_id = NULL, updated_at = ? WHERE drawing_id = ?`)
    .run(Date.now(), drawingId);
  return { detached: Number(res.changes) };
}

export type PromoteDrawingResult =
  | { ok: true; reference: LevelReference }
  | { ok: false; reason: string };

/**
 * Promote a saved drawing into a persisted reference.
 *
 * Reads the drawing's geometry, asks the pure mapper what it means, and stores
 * the result. A refusal is returned as a reason, never as a reference — a
 * drawing that cannot become a resolvable level must not become a
 * plausible-looking one.
 */
export function promoteDrawingToReference(
  drawingId: number,
  opts: PromoteOptions & { label?: string } = {}
): PromoteDrawingResult {
  const row = getDb()
    .prepare(`SELECT id, symbol, interval_min, kind, points FROM chart_drawings WHERE id = ?`)
    .get(drawingId) as
    | unknown as { id: number; symbol: string; interval_min: number | null; kind: string; points: string }
    | undefined;

  if (!row) return { ok: false, reason: "That drawing no longer exists." };

  let points: DrawingPoint[];
  try {
    points = JSON.parse(row.points) as DrawingPoint[];
  } catch {
    return { ok: false, reason: "That drawing's points could not be read." };
  }

  const mapped = drawingToLevel({ kind: row.kind, points }, opts);
  if (!mapped.ok) return mapped;

  const reference = saveLevelReference({
    symbol: row.symbol,
    intervalMin: row.interval_min,
    label: opts.label?.trim() || mapped.label,
    level: mapped.level,
    drawingId: row.id,
  });
  return { ok: true, reference };
}
