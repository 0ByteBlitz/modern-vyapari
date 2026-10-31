import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
import { createLogger } from "../logger";
import { appMode, databaseFileName } from "../modes/app-mode";

const log = createLogger("db");

/**
 * DB layer on Node's built-in sqlite (node:sqlite) — no native module builds required.
 * Requires the Node version bundled with Electron >= 43 (node:sqlite available).
 */

let db: DatabaseSync | null = null;

/** Whether `withTransaction` currently has one open. Tracked here because
 *  node:sqlite exposes no portable "in a transaction" flag across versions. */
let inTransaction = false;

/**
 * Open the database for the mode this process is running in.
 *
 * **Two files, never a `mode` column.** A column would be the
 * `source = 'binance'` problem again — a predicate on every query, and the one
 * you forget blends simulated history into a real record silently rather than
 * failing. Separate files make cross-mode contamination unwriteable: there is
 * no query that can reach the other mode's rows, because the other mode's rows
 * are not in this connection.
 *
 * Live keeps the historic `mybot.db` filename so an existing install's real
 * history stays exactly where it is. Renaming it would orphan the owner's
 * financial record, which has no backup routine yet (roadmap L-3).
 */
export function initDatabase(userDataPath: string): void {
  const dataDir = path.join(userDataPath, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const file = databaseFileName(appMode());
  db = new DatabaseSync(path.join(dataDir, file));
  log.info(`Opened ${file} (${appMode()} mode).`);

  // Ensure settings table exists before querying schema_version
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  let currentVersion = 1;
  try {
    const versionRow = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    if (versionRow) currentVersion = parseInt(versionRow.value, 10);
  } catch (e) {
    // If settings table didn't exist or query failed, assume v1
  }

  if (currentVersion < 2) {
    const sessionsExist = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    if (sessionsExist) {
      db.exec("PRAGMA foreign_keys = OFF;");
      // Prevent SQLite from auto-rewriting FK references in other tables
      db.exec("PRAGMA legacy_alter_table = ON;");
      db.exec("BEGIN TRANSACTION;");
      db.exec("ALTER TABLE sessions RENAME TO sessions_old;");
      
      // SCHEMA_SQL will create the new sessions table
      db.exec(SCHEMA_SQL);

      const oldSessions = db.prepare("SELECT * FROM sessions_old").all() as any[];
      const insertStmt = db.prepare(
        "INSERT INTO sessions (id, uuid, pair, status, risk_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );

      for (const s of oldSessions) {
        const uuid = crypto.randomUUID();
        const status = s.status || "active";
        const risk_config = s.risk_config || "{}";
        insertStmt.run(s.id, uuid, s.pair, status, risk_config, s.created_at, s.updated_at);
      }

      db.exec("DROP TABLE sessions_old;");
      db.exec("COMMIT;");
      db.exec("PRAGMA legacy_alter_table = OFF;");
      db.exec("PRAGMA foreign_keys = ON;");
    } else {
      db.exec(SCHEMA_SQL);
    }
  } else {
    db.exec(SCHEMA_SQL);
  }

  // v3 → v4 migration: new columns on strategies + alerts table
  if (currentVersion < 4) {
    try {
      db.exec("ALTER TABLE strategies ADD COLUMN description TEXT DEFAULT '';");
    } catch (_e) {
      /* column already exists */
    }
    try {
      db.exec("ALTER TABLE strategies ADD COLUMN backtest_count INTEGER NOT NULL DEFAULT 0;");
    } catch (_e) {
      /* column already exists */
    }
    try {
      db.exec("ALTER TABLE strategies ADD COLUMN last_evaluated_at INTEGER;");
    } catch (_e) {
      /* column already exists */
    }
    // alerts table — SCHEMA_SQL already has CREATE TABLE IF NOT EXISTS,
    // but run it explicitly in case the full schema wasn't re-applied.
    db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER REFERENCES sessions(id),
        label        TEXT NOT NULL,
        condition    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        triggered_at INTEGER,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id, status);
    `);
  }

  // v4 → v5 migration: add paper_balance to sessions
  if (currentVersion < 5) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN paper_balance TEXT NOT NULL DEFAULT '10000.00';");
    } catch (_e) {
      /* column already exists */
    }
  }

  // v5 → v6 migration: paper_positions table.
  // SCHEMA_SQL already has CREATE TABLE IF NOT EXISTS, but run it explicitly
  // so upgrading installs (where the full schema isn't re-applied) get it.
  if (currentVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_positions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER NOT NULL REFERENCES sessions(id),
        strategy_id    INTEGER NOT NULL REFERENCES strategies(id),
        symbol         TEXT NOT NULL,
        side           TEXT NOT NULL DEFAULT 'buy',
        entry_price    TEXT NOT NULL,
        quantity       TEXT NOT NULL,
        entry_fee      TEXT NOT NULL DEFAULT '0',
        stop_price     TEXT,
        target_price   TEXT,
        entry_order_id INTEGER REFERENCES orders(id),
        exit_order_id  INTEGER REFERENCES orders(id),
        status         TEXT NOT NULL DEFAULT 'open',
        exit_price     TEXT,
        exit_reason    TEXT,
        realized_pnl   TEXT,
        fees_total     TEXT,
        entry_reason   TEXT,
        opened_at      INTEGER NOT NULL,
        closed_at      INTEGER,
        reviewed       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_paper_pos_strategy ON paper_positions(strategy_id, status);
      CREATE INDEX IF NOT EXISTS idx_paper_pos_review   ON paper_positions(status, reviewed);
    `);
  }

  // v6 → v7 migration: basis_samples table (basis monitor).
  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS basis_samples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol          TEXT NOT NULL,
        revx_bid        TEXT NOT NULL,
        revx_ask        TEXT NOT NULL,
        revx_mid        TEXT NOT NULL,
        bin_bid         TEXT NOT NULL,
        bin_ask         TEXT NOT NULL,
        bin_mid         TEXT NOT NULL,
        revx_spread_bps REAL NOT NULL,
        bin_spread_bps  REAL NOT NULL,
        basis_bps       REAL NOT NULL,
        sampled_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_basis_symbol_time ON basis_samples(symbol, sampled_at);
    `);
  }

  // v7 → v8 migration: purge candles for non-USD quote pairs.
  // These were written by two paths that disagreed — the WS layer divided by
  // an FX rate (defaulting to 1 before the first fiat tick), the REST backfill
  // applied no conversion at all — so one symbol's history contained both GBP
  // and USD prices with a step change between them. Unrecoverable after the
  // fact, and candles are a rebuildable cache, so drop them; the app refuses
  // to chart non-USD quotes now and will not re-create these rows.
  if (currentVersion < 8) {
    try {
      const res = db
        .prepare(
          `DELETE FROM candles
           WHERE instr(symbol, '-') > 0
             AND substr(symbol, instr(symbol, '-') + 1) NOT IN ('USD', 'USDT')`
        )
        .run();
      if (Number(res.changes) > 0) {
        log.info(`v8 migration: purged ${res.changes} FX-contaminated candle rows.`);
      }
    } catch (err) {
      log.error("v8 candle purge failed:", err);
    }
  }

  // v8 → v9 migration: chart_drawings (research annotations).
  if (currentVersion < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chart_drawings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol       TEXT NOT NULL,
        interval_min INTEGER,
        kind         TEXT NOT NULL,
        points       TEXT NOT NULL,
        extend       TEXT NOT NULL DEFAULT '{}',
        locked       INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drawings_symbol ON chart_drawings(symbol, interval_min);
    `);
  }

  /* v9 → v10 repair: recompute `sessions.paper_balance`.
   *
   * `getSessionById` didn't SELECT the column, so the paper engine read
   * `undefined` on every candle: entries were sized off the `"10000"` fallback
   * forever, and each close rewrote cash to just the sale proceeds. Every
   * existing balance is therefore fiction.
   *
   * It IS recoverable, because cash is derivable from the position history:
   *   cash = START + Σ realised_pnl (closed) − Σ (entry cost + entry fee) (open)
   * A closed round trip's net cash effect is exactly its realised PnL; an open
   * position has only paid out its cost so far. Both are recorded per row, so
   * this reconstructs the true balance rather than resetting it and throwing
   * away the trading history's effect. */
  if (currentVersion < 10) {
    try {
      const START = 10000;
      const rows = db
        .prepare(
          `SELECT s.id,
                  COALESCE(SUM(CASE WHEN p.status = 'closed'
                                    THEN CAST(p.realized_pnl AS REAL) ELSE 0 END), 0) AS realized,
                  COALESCE(SUM(CASE WHEN p.status = 'open'
                                    THEN CAST(p.entry_price AS REAL) * CAST(p.quantity AS REAL)
                                         + CAST(COALESCE(p.entry_fee, '0') AS REAL)
                                    ELSE 0 END), 0) AS committed
           FROM sessions s
           LEFT JOIN paper_positions p ON p.session_id = s.id
           GROUP BY s.id`
        )
        .all() as unknown as { id: number; realized: number; committed: number }[];

      const update = db.prepare("UPDATE sessions SET paper_balance = ? WHERE id = ?");
      for (const r of rows) {
        const cash = START + (r.realized ?? 0) - (r.committed ?? 0);
        update.run(cash.toFixed(2), r.id);
      }
      if (rows.length > 0) log.info(`v10 migration: recomputed paper_balance for ${rows.length} sessions.`);
    } catch (err) {
      log.error("v10 paper_balance repair failed:", err);
    }
  }

  /* v10 → v11: candles.taker_buy_volume.
   *
   * Additive and nullable. Existing rows keep NULL, which the CVD layer reads
   * as "unknown" and refuses to accumulate across — deliberately NOT
   * backfilled to 0, because 0 taker-buy volume means delta = −volume, i.e. a
   * bar of pure selling that never happened. Both Binance ingest paths use
   * ON CONFLICT DO UPDATE, so history heals wherever it is refetched. */
  if (currentVersion < 11) {
    try {
      const cols = db.prepare(`PRAGMA table_info(candles)`).all() as unknown as { name: string }[];
      if (!cols.some((c) => c.name === "taker_buy_volume")) {
        db.exec(`ALTER TABLE candles ADD COLUMN taker_buy_volume TEXT;`);
        log.info("v11 migration: added candles.taker_buy_volume (NULL = unknown).");
      }
    } catch (err) {
      log.error("v11 taker_buy_volume migration failed:", err);
    }
  }

  /* v11 → v12: paper_positions.entry_levels_json.
   *
   * Records what each derived PriceLevel resolved to at entry alongside what
   * it was worth when the strategy was armed. The review agent needs both to
   * answer "did the trigger fire because price moved, or because the level
   * moved toward price?" — a question no PnL figure can answer, and the one
   * that distinguishes a real setup from an anchored profile's POC quietly
   * migrating into the market. Additive and nullable: positions opened on
   * numeric thresholds legitimately have nothing to record. */
  if (currentVersion < 12) {
    try {
      const cols = db.prepare(`PRAGMA table_info(paper_positions)`).all() as unknown as { name: string }[];
      if (!cols.some((c) => c.name === "entry_levels_json")) {
        db.exec(`ALTER TABLE paper_positions ADD COLUMN entry_levels_json TEXT;`);
        log.info("v12 migration: added paper_positions.entry_levels_json.");
      }
    } catch (err) {
      log.error("v12 entry_levels_json migration failed:", err);
    }
  }

  /* v12 → v13: trade_plans + plan_branches (roadmap S3-1).
   *
   * Purely additive — two new tables, nothing existing is touched, so there is
   * no data to migrate and no way for this to corrupt a history.
   *
   * **This block is belt-and-braces, not the only path.** SCHEMA_SQL is re-run
   * on every startup (see the `else` above), and its `CREATE TABLE IF NOT
   * EXISTS` would create these on an existing database anyway. It is kept
   * because that is how v9 introduced `chart_drawings`, and because a version
   * bump whose migration block is empty invites the next reader to conclude the
   * tables arrive by magic. If SCHEMA_SQL ever stops running unconditionally,
   * this is what keeps existing installs working. */
  if (currentVersion < 13) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trade_plans (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    INTEGER NOT NULL REFERENCES sessions(id),
          slug          TEXT NOT NULL,
          pair          TEXT NOT NULL,
          thesis        TEXT NOT NULL,
          assumptions_json TEXT NOT NULL DEFAULT '[]',
          invalidation_json TEXT NOT NULL,
          expires_at    INTEGER NOT NULL,
          risk_json     TEXT NOT NULL,
          oco_exclusive INTEGER NOT NULL DEFAULT 1,
          eval_interval TEXT NOT NULL DEFAULT '4h',
          state         TEXT NOT NULL DEFAULT 'draft',
          notes         TEXT,
          armed_at      INTEGER,
          outcome_reason TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          closed_at     INTEGER
        );
        CREATE TABLE IF NOT EXISTS plan_branches (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id      INTEGER NOT NULL REFERENCES trade_plans(id),
          slug         TEXT NOT NULL,
          label        TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          entry_json   TEXT NOT NULL,
          stop_json    TEXT NOT NULL,
          targets_json TEXT NOT NULL,
          budget_share_pct REAL NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          triggered_at INTEGER,
          position_id  INTEGER REFERENCES paper_positions(id),
          trigger_levels_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plans_session      ON trade_plans(session_id, state);
        CREATE INDEX IF NOT EXISTS idx_plans_expiry       ON trade_plans(state, expires_at);
        CREATE INDEX IF NOT EXISTS idx_plan_branches_plan ON plan_branches(plan_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_slug  ON trade_plans(session_id, slug);
      `);
      log.info("v13 migration: added trade_plans and plan_branches.");
    } catch (err) {
      log.error("v13 trade_plans migration failed:", err);
    }
  }

  /* v13 → v14: level_references (roadmap S2-2). Additive, same shape as v13. */
  if (currentVersion < 14) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS level_references (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol       TEXT NOT NULL,
          interval_min INTEGER,
          label        TEXT NOT NULL,
          level_json   TEXT NOT NULL,
          drawing_id   INTEGER REFERENCES chart_drawings(id),
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_levelrefs_symbol ON level_references(symbol, interval_min);
      `);
      log.info("v14 migration: added level_references.");
    } catch (err) {
      log.error("v14 level_references migration failed:", err);
    }
  }

  /* v14 → v15: paper_positions gains plan_branch_id, strategy_id becomes
   * nullable, and a CHECK enforces that exactly one of them is set.
   *
   * A plan branch that triggers needs somewhere to record the position it
   * opened, and it must be THIS table — a second positions table would be a
   * second execution path, and "no second fill model, ever" is the rule the
   * whole plan monitor is built around.
   *
   * SQLite cannot drop a NOT NULL constraint in place, so this is a rebuild:
   * create, copy, drop, rename. The same shape `repairStaleForeignKeys` below
   * already uses. Three things make it safe to run against real history:
   *   • it is wrapped in a transaction, so a failure leaves the old table;
   *   • the copy is column-explicit, so a future column added to one side and
   *     not the other fails loudly instead of shifting values silently;
   *   • foreign_keys is toggled OUTSIDE the transaction, because SQLite
   *     ignores the pragma while one is open. */
  if (currentVersion < 15) {
    const cols = db.prepare(`PRAGMA table_info(paper_positions)`).all() as unknown as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "plan_branch_id")) {
      db.exec("PRAGMA foreign_keys = OFF;");
      try {
        db.exec("BEGIN TRANSACTION;");
        db.exec(`
          CREATE TABLE paper_positions_v15 (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id     INTEGER NOT NULL REFERENCES sessions(id),
            strategy_id    INTEGER REFERENCES strategies(id),
            plan_branch_id INTEGER REFERENCES plan_branches(id),
            symbol         TEXT NOT NULL,
            side           TEXT NOT NULL DEFAULT 'buy',
            entry_price    TEXT NOT NULL,
            quantity       TEXT NOT NULL,
            entry_fee      TEXT NOT NULL DEFAULT '0',
            stop_price     TEXT,
            target_price   TEXT,
            entry_order_id INTEGER REFERENCES orders(id),
            exit_order_id  INTEGER REFERENCES orders(id),
            status         TEXT NOT NULL DEFAULT 'open',
            exit_price     TEXT,
            exit_reason    TEXT,
            realized_pnl   TEXT,
            fees_total     TEXT,
            entry_reason   TEXT,
            opened_at      INTEGER NOT NULL,
            closed_at      INTEGER,
            reviewed       INTEGER NOT NULL DEFAULT 0,
            entry_levels_json TEXT,
            CHECK ((strategy_id IS NULL) <> (plan_branch_id IS NULL))
          );
          INSERT INTO paper_positions_v15
            (id, session_id, strategy_id, plan_branch_id, symbol, side, entry_price, quantity,
             entry_fee, stop_price, target_price, entry_order_id, exit_order_id, status,
             exit_price, exit_reason, realized_pnl, fees_total, entry_reason, opened_at,
             closed_at, reviewed, entry_levels_json)
          SELECT
             id, session_id, strategy_id, NULL, symbol, side, entry_price, quantity,
             entry_fee, stop_price, target_price, entry_order_id, exit_order_id, status,
             exit_price, exit_reason, realized_pnl, fees_total, entry_reason, opened_at,
             closed_at, reviewed, entry_levels_json
          FROM paper_positions;
          DROP TABLE paper_positions;
          ALTER TABLE paper_positions_v15 RENAME TO paper_positions;
          CREATE INDEX IF NOT EXISTS idx_paper_pos_strategy ON paper_positions(strategy_id, status);
          CREATE INDEX IF NOT EXISTS idx_paper_pos_review   ON paper_positions(status, reviewed);
          CREATE INDEX IF NOT EXISTS idx_paper_pos_branch   ON paper_positions(plan_branch_id, status);
        `);
        db.exec("COMMIT;");
        log.info("v15 migration: paper_positions rebuilt with plan_branch_id.");
      } catch (err) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          /* nothing to roll back */
        }
        log.error("v15 paper_positions rebuild failed:", err);
      } finally {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }
    /* Outside the rebuild guard on purpose: a FRESH database gets the new table
       straight from SCHEMA_SQL and so skips the rebuild, but still needs the
       index. `IF NOT EXISTS` makes this idempotent for the migrated path. */
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_paper_pos_branch ON paper_positions(plan_branch_id, status);"
      );
    } catch (err) {
      log.error("v15 plan_branch_id index creation failed:", err);
    }
  }

  if (currentVersion < 16) {
    /* A plain ALTER, not a rebuild: the column is additive and nullable, so an
       existing row simply has no plan — which is true, every position written
       so far is strategy-owned. `SCHEMA_SQL` covers fresh databases; this
       covers the ones that already exist, where `CREATE TABLE IF NOT EXISTS`
       is a no-op. */
    const jcols = db.prepare(`PRAGMA table_info(journal)`).all() as unknown as { name: string }[];
    if (jcols.length > 0 && !jcols.some((c) => c.name === "ref_plan_id")) {
      db.exec(`ALTER TABLE journal ADD COLUMN ref_plan_id INTEGER REFERENCES trade_plans(id);`);
      log.info("v16 migration: journal.ref_plan_id added.");
    }
  }

  if (currentVersion < 17) {
    /* `SCHEMA_SQL` re-runs on every startup, so its CREATE TABLE IF NOT EXISTS
       already covers existing installs — this block is belt-and-braces and is
       commented as such, the same shape as v13. Note the index is over columns
       introduced with the table, not by a rebuild, so it is safe in SCHEMA_SQL
       (contrast v15, where an index over a not-yet-added column crashed launch). */
    const has = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'`)
      .get();
    if (!has) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          kind          TEXT NOT NULL,
          title         TEXT NOT NULL,
          body          TEXT NOT NULL DEFAULT '',
          dedupe_key    TEXT NOT NULL UNIQUE,
          deliver_after INTEGER NOT NULL DEFAULT 0,
          attempts      INTEGER NOT NULL DEFAULT 0,
          delivered_at  INTEGER,
          last_error    TEXT,
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_pending
          ON notifications(delivered_at, attempts, deliver_after);
      `);
      log.info("v17 migration: notifications outbox created.");
    }
  }

  if (currentVersion < 18) {
    /* A plain additive ALTER, not a rebuild — so unlike v15 there is no index
       over a new column to keep out of SCHEMA_SQL. Guarded by a column check
       because SCHEMA_SQL's CREATE TABLE IF NOT EXISTS skips on an existing
       table, leaving the column genuinely absent here. */
    const cols = db.prepare(`PRAGMA table_info(trade_plans)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === "reviewed")) {
      db.exec(`ALTER TABLE trade_plans ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0`);
      log.info("v18 migration: trade_plans.reviewed added");
    }
  }

  if (currentVersion < 19) {
    /* Additive table. SCHEMA_SQL's CREATE TABLE IF NOT EXISTS already covers
       it on every startup; this block exists so the version bump is explicit
       and so a reader can find v19 where the others are. */
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER REFERENCES sessions(id),
        model       TEXT NOT NULL,
        purpose     TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd    TEXT,
        created_at  INTEGER NOT NULL
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_api_usage_time ON api_usage(created_at DESC);`);
    log.info("v19 migration: api_usage added");
  }

  if (currentVersion < 20) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_account (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        balance         TEXT NOT NULL,
        initial_balance TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      );
    `);
    const existing = db.prepare(`SELECT balance FROM paper_account WHERE id = 1`).get();
    if (!existing) {
      /* Collapse the minted balances into one account WITHOUT throwing away
         real paper P&L. Each session started at 10,000, so its deviation from
         that is what its trading actually did; summing the deviations onto one
         starting balance preserves the P&L and removes the duplication.
         Summing the balances themselves would keep the minted money. */
      const START = 10_000;
      let balance = START;
      try {
        const rows = db.prepare(`SELECT paper_balance FROM sessions`).all() as Array<{ paper_balance: string }>;
        for (const r of rows) {
          const v = parseFloat(r.paper_balance);
          if (Number.isFinite(v)) balance += v - START;
        }
      } catch {
        /* No sessions table yet on a fresh file — the default stands. */
      }
      if (!Number.isFinite(balance) || balance < 0) balance = START;
      db.prepare(
        `INSERT INTO paper_account (id, balance, initial_balance, updated_at) VALUES (1, ?, ?, ?)`
      ).run(balance.toString(), String(START), Date.now());
      log.info(`v20 migration: one paper account seeded at ${balance.toFixed(2)} (P&L preserved).`);
    }
  }

  // ── Repair: fix stale FK references to "sessions_old" ─────────────
  // The v1→v2 migration used ALTER TABLE RENAME which caused SQLite to
  // silently rewrite FK references in other tables from "sessions" to
  // "sessions_old". After sessions_old was dropped, those FKs became
  // dangling. Detect and rebuild any affected tables.
  repairStaleForeignKeys(db);

  db.prepare(
    "INSERT INTO settings(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(SCHEMA_VERSION));
}

/**
 * Repair tables whose FK references were silently rewritten from "sessions"
 * to "sessions_old" by SQLite's ALTER TABLE RENAME during the v1→v2 migration.
 * For each affected table, rebuild it with the correct FK pointing to "sessions".
 */
function repairStaleForeignKeys(database: DatabaseSync): void {
  const tables = database
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND sql LIKE '%sessions_old%'`
    )
    .all() as { name: string; sql: string }[];

  if (tables.length === 0) return; // nothing to repair

  log.info(`Found ${tables.length} table(s) with stale FK to sessions_old:`, tables.map((t) => t.name));

  database.exec("PRAGMA foreign_keys = OFF;");
  database.exec("BEGIN TRANSACTION;");

  for (const { name, sql } of tables) {
    // Build corrected CREATE TABLE SQL: replace all references to sessions_old with sessions
    const fixedSql = sql.replace(/sessions_old/g, "sessions");
    const tempName = `${name}_repair_temp`;

    // Create the fixed table under a temp name
    const createTemp = fixedSql.replace(
      new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${name}`, "i"),
      `CREATE TABLE ${tempName}`
    );
    database.exec(createTemp);

    // Copy all data
    database.exec(`INSERT INTO ${tempName} SELECT * FROM ${name};`);

    // Swap
    database.exec(`DROP TABLE ${name};`);
    database.exec(`ALTER TABLE ${tempName} RENAME TO ${name};`);

    log.info(`Rebuilt table "${name}" with corrected FK references.`);
  }

  database.exec("COMMIT;");
  database.exec("PRAGMA foreign_keys = ON;");

  // Re-run schema SQL to recreate any indexes/triggers that were dropped
  database.exec(SCHEMA_SQL);
}

export function setDbForTesting(testDb: DatabaseSync | null): void {
  db = testDb;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized");
  return db;
}

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * **Why this exists (owner decision, 2026-07-31: fix the core).** Until now the
 * only transactions in the process were in migrations. Every multi-row write
 * elsewhere — a plan and its branches, a position close and the cash it moves,
 * an archive wind-down — was a sequence of independent statements, so a failure
 * partway through left a half-written record that nothing would ever notice.
 * That is this project's recurring bug class expressed in the storage layer:
 * state presented with more confidence than it earned.
 *
 * Two properties worth knowing before using it:
 *
 *  • **Not reentrant.** SQLite has no nested transactions, so a call inside an
 *    active transaction joins the outer one rather than starting its own. That
 *    is deliberate — savepoints would let an inner rollback silently keep an
 *    outer write, which is worse than the problem being solved. Compose by
 *    calling helpers *inside* one `withTransaction`, never by nesting two.
 *  • **The callback must be synchronous.** `node:sqlite` is synchronous, and an
 *    `await` inside a transaction would hold it open across the event loop
 *    while other writers proceed. The type enforces it.
 */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const database = getDb();

  // Already inside one: join it rather than opening a second (see the note above).
  if (inTransaction) return fn(database);

  database.exec("BEGIN");
  inTransaction = true;
  try {
    const out = fn(database);
    database.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackErr) {
      // A failed rollback is worse than the original error and must be visible.
      log.error("ROLLBACK failed after a transaction error", rollbackErr);
    }
    throw err;
  } finally {
    inTransaction = false;
  }
}

/** Is a database available?
 *
 * For background writers (the WS candle ingest) that can legitimately still be
 * receiving data after the DB has gone away — during shutdown, or between tests.
 * They should skip the write rather than throw once per message: an unbounded
 * error log is its own failure, and it buries whatever went wrong first. */
export function isDbReady(): boolean {
  return db !== null;
}

export function dbInfo(): { schemaVersion: string; sessionCount: number } {
  const d = getDb();
  const versionRow = d.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const countRow = d.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
  return { schemaVersion: versionRow?.value ?? "unknown", sessionCount: countRow.c };
}

export function auditLog(action: string, detail: unknown): void {
  getDb()
    .prepare("INSERT INTO audit_log(action, detail, created_at) VALUES(?, ?, ?)")
    .run(action, JSON.stringify(detail), Date.now());
}
