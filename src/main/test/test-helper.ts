import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../db/schema";
import { setDbForTesting, getDb } from "../db/database";
import { __setSharedStoreForTests } from "../db/shared-store";
import { __resetModeForTests } from "../modes/app-mode";
import { binanceWS } from "../data/binance-ws";
import type { StrategySpec } from "../strategy/strategy-spec";
import type { CandleNumeric } from "../insights/indicator-types";
import * as crypto from "crypto";

export function setupTestDb(): DatabaseSync {
  /* No test may open a network socket.
   *
   * `alertEngine.addAlert()` takes an internal Binance subscription, which
   * connects the shared WS singleton. Nothing released it, so the socket
   * outlived `cleanupTestDb()`, kept receiving klines against a closed
   * database, and — being an open handle — stopped `node --test` from exiting
   * at all. The suite looked like it hung; it was actually holding a live
   * market feed open. */
  binanceWS.setOffline(true);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO settings(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  setDbForTesting(db);

  /* The store both modes share, in memory. Without it every call that reads a
     lesson throws — and the app's default mode is `simulated`, so tests run in
     the same mode a fresh install does. A test that needs the live adapter says
     so explicitly (`__resetModeForTests("live")`), which is clearer than a
     harness that quietly puts every test in live mode. */
  /* One paper account per app, so tests get one too — seeded rather than left
     to the migration, which does not run against an in-memory schema. */
  db.prepare(
    `INSERT INTO paper_account (id, balance, initial_balance, updated_at) VALUES (1, '10000', '10000', ?)`
  ).run(Date.now());

  __setSharedStoreForTests(new DatabaseSync(":memory:"));
  __resetModeForTests();
  return db;
}

export function cleanupTestDb(): void {
  __setSharedStoreForTests(null);
  // Release subscriptions and timers BEFORE the DB goes away, so nothing is
  // left holding a handle or writing into a closed database.
  binanceWS.shutdown();

  try {
    const db = getDb();
    db.close();
  } catch {
    // Ignore if already closed
  }
  setDbForTesting(null);
}

export interface TestSession {
  id: number;
  uuid: string;
  pair: string;
  status: string;
  paper_balance: string;
}

export function createTestSession(pair = "BTC-USD", status = "active", paperBalance = "10000.00"): TestSession {
  const db = getDb();
  const uuid = crypto.randomUUID();
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO sessions (uuid, pair, status, paper_balance, risk_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`
    )
    .run(uuid, pair, status, paperBalance, now, now);
  
  return {
    id: Number(res.lastInsertRowid),
    uuid,
    pair,
    status,
    paper_balance: paperBalance,
  };
}

export interface TestStrategy {
  id: number;
  session_id: number;
  name: string;
  version: number;
  state: string;
  spec_json: string;
}

export function createTestStrategy(sessionId: number, spec: StrategySpec, state = "paper"): TestStrategy {
  const db = getDb();
  const now = Date.now();
  const specJson = JSON.stringify(spec);
  const res = db
    .prepare(
      `INSERT INTO strategies (session_id, name, version, state, spec_json, description, created_at)
       VALUES (?, ?, 1, ?, ?, 'Test Strategy', ?)`
    )
    .run(sessionId, spec.id, state, specJson, now);

  return {
    id: Number(res.lastInsertRowid),
    session_id: sessionId,
    name: spec.id,
    version: 1,
    state,
    spec_json: specJson,
  };
}

export function seedTestCandles(symbol: string, intervalMin: number, candles: CandleNumeric[]): void {
  const db = getDb();
  /* `taker_buy_volume` is written when the fixture supplies it and left NULL
     when it doesn't — NULL meaning *unknown*, exactly as a pre-schema-v11 row
     does. Omitting the column entirely would have made every seeded bar
     unknown with no way to express a known one, so a CVD or coverage test
     could never have been written against this helper. */
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, interval_min, start_ms, open, high, low, close, volume, taker_buy_volume, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'binance')`
  );

  db.exec("BEGIN TRANSACTION;");
  for (const c of candles) {
    const tb = c.takerBuyVolume;
    stmt.run(
      symbol,
      intervalMin,
      c.timestamp,
      c.open.toString(),
      c.high.toString(),
      c.low.toString(),
      c.close.toString(),
      c.volume.toString(),
      tb === null || tb === undefined ? null : tb.toString()
    );
  }
  db.exec("COMMIT;");
}
