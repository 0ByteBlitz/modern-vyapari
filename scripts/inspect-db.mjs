/**
 * Read-only DB inspector — verification helper for the owner.
 *
 * Prints schema version, table list, paper_positions contents, and recent
 * trade reviews, so a paper round trip can be confirmed without a separate
 * SQLite client. Opens the DB read-only; it cannot modify anything.
 *
 * Usage (from the repo root, with the app CLOSED):
 *   node --experimental-sqlite scripts/inspect-db.mjs
 *   node --experimental-sqlite scripts/inspect-db.mjs "C:\\path\\to\\mybot.db"
 */
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

function defaultDbPath() {
  // Electron's userData: %APPDATA%\<app name>\ on Windows. Dev runs use the
  // package.json "name" (modern-vyapari); a packaged install uses the
  // electron-builder productName ("Modern Vyapari"). Try both.
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "modern-vyapari", "data", "mybot.db"),
    path.join(appData, "Modern Vyapari", "data", "mybot.db"),
    path.join(os.homedir(), "Library", "Application Support", "modern-vyapari", "data", "mybot.db"),
    path.join(os.homedir(), ".config", "modern-vyapari", "data", "mybot.db"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

const dbPath = process.argv[2] || defaultDbPath();

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at:\n  ${dbPath}\n`);
  console.error("Run the app once to create it, or pass the path explicitly:");
  console.error('  node --experimental-sqlite scripts/inspect-db.mjs "C:\\path\\to\\mybot.db"');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

function heading(title) {
  console.log(`\n\x1b[1m── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\x1b[0m`);
}

function table(rows) {
  if (!rows.length) {
    console.log("  (none)");
    return;
  }
  console.table(rows);
}

console.log(`DB: ${dbPath}`);

heading("Schema version");
const version = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
console.log(`  schema_version = ${version?.value ?? "(unset)"}   (expected: 6)`);

heading("Tables");
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log("  " + tables.join(", "));
console.log(
  tables.includes("paper_positions")
    ? "\n  \x1b[32m✓ paper_positions exists\x1b[0m"
    : "\n  \x1b[31m✗ paper_positions MISSING — the v6 migration did not run\x1b[0m"
);

if (tables.includes("paper_positions")) {
  heading("paper_positions columns");
  table(
    db
      .prepare("PRAGMA table_info(paper_positions)")
      .all()
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, default: c.dflt_value }))
  );

  heading("Open positions");
  table(
    db
      .prepare(
        `SELECT id, strategy_id, symbol, entry_price, quantity, stop_price, target_price,
                datetime(opened_at / 1000, 'unixepoch', 'localtime') AS opened
         FROM paper_positions WHERE status = 'open' ORDER BY opened_at DESC`
      )
      .all()
  );

  heading("Closed positions (most recent 20)");
  table(
    db
      .prepare(
        `SELECT id, strategy_id, symbol, entry_price, exit_price, exit_reason,
                round(CAST(realized_pnl AS REAL), 2) AS pnl,
                round(CAST(fees_total AS REAL), 2) AS fees,
                reviewed,
                datetime(closed_at / 1000, 'unixepoch', 'localtime') AS closed
         FROM paper_positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 20`
      )
      .all()
  );

  heading("Review coverage");
  const cov = db
    .prepare(
      `SELECT COUNT(*) AS closed_total,
              SUM(CASE WHEN reviewed = 1 THEN 1 ELSE 0 END) AS reviewed_total
       FROM paper_positions WHERE status = 'closed'`
    )
    .get();
  console.log(`  ${cov.reviewed_total ?? 0} of ${cov.closed_total ?? 0} closed positions reviewed`);
}

heading("Candle coverage (per symbol / interval)");
{
  // A chart is only trustworthy if its window is CONTIGUOUS. This compares
  // how many bars exist against how many should exist between the oldest and
  // newest cached bar — the gap count is what made short intervals render
  // wrong while 1D looked fine.
  const rows = db
    .prepare(
      `SELECT symbol, interval_min,
              COUNT(*) AS bars,
              MIN(start_ms) AS oldest,
              MAX(start_ms) AS newest
       FROM candles WHERE source = 'binance'
       GROUP BY symbol, interval_min
       ORDER BY symbol, interval_min`
    )
    .all();

  table(
    rows.map((r) => {
      const span = r.newest - r.oldest;
      const expected = Math.floor(span / (r.interval_min * 60_000)) + 1;
      const missing = Math.max(0, expected - r.bars);
      const ageMin = Math.round((Date.now() - r.newest) / 60_000);
      return {
        symbol: r.symbol,
        interval: `${r.interval_min}m`,
        bars: r.bars,
        expected,
        missing,
        "gap %": expected > 0 ? `${((missing / expected) * 100).toFixed(1)}%` : "—",
        "newest age": ageMin > 1440 ? `${Math.round(ageMin / 1440)}d` : `${ageMin}m`,
      };
    })
  );
  console.log("  missing > 0 means holes in the series — the chart will draw non-adjacent bars side by side.");
}

heading("Sessions");
table(db.prepare("SELECT id, pair, status, paper_balance FROM sessions ORDER BY id").all());

heading("Strategies");
table(db.prepare("SELECT id, session_id, name, version, state, backtest_count FROM strategies ORDER BY id").all());

heading("Recent journal entries (trade_review / lesson)");
table(
  db
    .prepare(
      `SELECT id, kind, substr(replace(content, char(10), ' '), 1, 90) AS preview,
              datetime(created_at / 1000, 'unixepoch', 'localtime') AS created
       FROM journal WHERE kind IN ('trade_review', 'lesson')
       ORDER BY created_at DESC LIMIT 10`
    )
    .all()
);

heading("Recent paper audit log");
table(
  db
    .prepare(
      `SELECT action, substr(detail, 1, 80) AS detail,
              datetime(created_at / 1000, 'unixepoch', 'localtime') AS created
       FROM audit_log WHERE action LIKE 'paper%' ORDER BY created_at DESC LIMIT 10`
    )
    .all()
);

db.close();
console.log("");
