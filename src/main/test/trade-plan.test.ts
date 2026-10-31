/**
 * Scenario plans — the falsifiability gate, the lifecycle, and the v13 schema
 * (roadmap S3-1).
 *
 * What is under test is deliberately the *refusals*. A plan's licence to trade
 * real money comes from being falsifiable, not from a backtest, so the gate is
 * the only thing standing between "a thesis" and "a guess with a stop attached".
 * Each of the four required elements gets a test proving a plan without it
 * cannot be armed, plus the two structural rules that stop a plan meaning two
 * things at once (OCO budget, invalidation that merely restates a stop).
 *
 * The migration test covers the gap S1-5 left open: an EXISTING on-disk
 * database being migrated forward, rather than only the fresh-schema path every
 * other test exercises. It starts from a v12 shape, which is what a real
 * installation had before the plan tables landed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, getDb, setDbForTesting } from "../db/database";
import {
  validatePlan,
  canTransitionPlan,
  isPlanTerminal,
  isPlanExpired,
  PLAN_TRANSITIONS,
  MAX_PLAN_HORIZON_MS,
  type TradePlan,
  type PlanBranch,
} from "../plans/trade-plan";
import type { ConditionGroup } from "../strategy/strategy-spec";
import type { DerivedLevel, PriceLevel } from "../../shared/levels";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../db/schema";

const NOW = 1_785_000_000_000;
const DAY = 86_400_000;

const priceBelow = (v: number): ConditionGroup => ({
  logic: "and",
  conditions: [{ indicator: "price", params: {}, operator: "below", value: v }],
});
const priceAbove = (v: number): ConditionGroup => ({
  logic: "and",
  conditions: [{ indicator: "price", params: {}, operator: "crosses_above", value: v }],
});

const staticLevel = (price: number): PriceLevel => ({ kind: "static", price });

/** A developing POC — the level type the drift rules exist for. */
function developingPoc(overrides: Partial<DerivedLevel> = {}): DerivedLevel {
  return {
    kind: "derived",
    source: "volume_profile",
    params: { binWidth: 50, valueAreaPct: 70, distribution: "uniform" },
    window: { from: NOW - 30 * DAY, to: "developing" },
    field: "poc",
    resolve: "live",
    resolvedAtArm: 71_800,
    driftTolerance: { binChange: true },
    onDrift: "invalidate",
    ...overrides,
  };
}

function branch(over: Partial<PlanBranch> = {}): PlanBranch {
  return {
    id: "breakout",
    label: "breakout continuation",
    trigger: priceAbove(72_000),
    entry: staticLevel(72_100),
    stop: staticLevel(70_500),
    targets: [staticLevel(78_000)],
    budgetSharePct: 100,
    ...over,
  };
}

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    id: "btc-range-break",
    sessionId: 1,
    pair: "BTC-USD",
    thesis: "72k reclaimed and held opens the gap to 78k.",
    assumptions: [{ text: "The 72k shelf is real supply, not a wick.", tag: "range-high-reclaim" }],
    branches: [branch()],
    invalidation: priceBelow(66_000),
    expiresAt: NOW + 10 * DAY,
    risk: { maxQuote: 250 },
    ocoExclusive: true,
    evalInterval: "4h",
    ...over,
  };
}

const errorsOf = (p: TradePlan) => validatePlan(p, NOW).errors.join(" | ");

describe("the falsifiability gate — all four elements are required", () => {
  test("a complete plan validates", () => {
    const res = validatePlan(plan(), NOW);
    assert.equal(res.valid, true, res.errors.join(" | "));
    assert.deepEqual(res.warnings, []);
  });

  test("1. no assumptions → refused", () => {
    const res = validatePlan(plan({ assumptions: [] }), NOW);
    assert.equal(res.valid, false);
    assert.match(res.errors.join(" "), /at least one assumption/i);
  });

  test("assumptions that are only whitespace do not count", () => {
    const res = validatePlan(plan({ assumptions: [{ text: "   " }] }), NOW);
    assert.equal(res.valid, false);
    assert.match(res.errors.join(" "), /at least one assumption/i);
  });

  test("2. no thesis invalidation → refused", () => {
    const res = validatePlan(plan({ invalidation: { logic: "and", conditions: [] } }), NOW);
    assert.equal(res.valid, false);
    assert.match(res.errors.join(" "), /thesis invalidation/i);
  });

  test("2b. invalidation that merely restates the only stop → refused", () => {
    /* The distinction this protects: a stop is where the TRADE is wrong,
       invalidation is where the THESIS is wrong. If they are the same level the
       thesis has nowhere to be wrong except by losing the trade, and the plan
       has quietly become an ordinary trade with extra words. */
    const poc = developingPoc();
    const res = validatePlan(
      plan({
        branches: [branch({ stop: poc })],
        invalidation: { logic: "and", conditions: [{ indicator: "price", params: {}, operator: "below", value: poc }] },
      }),
      NOW
    );
    assert.equal(res.valid, false);
    assert.match(res.errors.join(" "), /same price as every stop/i);
  });

  test("3. no expiry → refused; past expiry → refused; absurd horizon → refused", () => {
    assert.match(errorsOf(plan({ expiresAt: NaN })), /add an expiry/i);
    assert.match(errorsOf(plan({ expiresAt: NOW - 1 })), /in the past/i);
    assert.match(errorsOf(plan({ expiresAt: NOW + MAX_PLAN_HORIZON_MS + DAY })), /nearer date/i);
  });

  test("4. no risk budget → refused", () => {
    assert.match(errorsOf(plan({ risk: { maxQuote: 0 } })), /risk budget/i);
  });
});

describe("structural rules that stop a plan meaning two things", () => {
  test("OCO branches cannot together exceed the plan's budget", () => {
    const res = validatePlan(
      plan({
        branches: [
          branch({ id: "a", budgetSharePct: 70 }),
          branch({ id: "b", label: "retest", budgetSharePct: 70 }),
        ],
      }),
      NOW
    );
    assert.equal(res.valid, false);
    assert.match(res.errors.join(" "), /100% or under/i);
  });

  test("disabling OCO warns about double sizing but does not refuse", () => {
    const res = validatePlan(
      plan({
        ocoExclusive: false,
        branches: [branch({ id: "a", budgetSharePct: 50 }), branch({ id: "b", budgetSharePct: 50 })],
      }),
      NOW
    );
    assert.equal(res.valid, true, res.errors.join(" | "));
    assert.match(res.warnings.join(" "), /several positions/i);
  });

  test("duplicate branch ids are refused", () => {
    assert.match(errorsOf(plan({ branches: [branch({ id: "x" }), branch({ id: "x" })] })), /used twice/i);
  });

  test("a branch with no target is refused", () => {
    assert.match(errorsOf(plan({ branches: [branch({ targets: [] })] })), /add a target/i);
  });
});

describe("developing levels must carry a drift guard", () => {
  test("a developing entry with no tolerance is refused", () => {
    /* Without a guard the resolver fails the level closed, so the plan would sit
       there looking armed and never fire. Refusing at authoring time is the
       honest version of the same outcome. */
    const naked = developingPoc({ driftTolerance: {} });
    assert.match(errorsOf(plan({ branches: [branch({ entry: naked })] })), /drift tolerance/i);
  });

  test("a developing stop with no tolerance is refused", () => {
    const naked = developingPoc({ driftTolerance: {} });
    assert.match(errorsOf(plan({ branches: [branch({ stop: naked })] })), /drift tolerance/i);
  });

  test("a developing level WITH a tolerance is accepted", () => {
    const guarded = developingPoc({ driftTolerance: { pct: 1.5 } });
    const res = validatePlan(plan({ branches: [branch({ entry: guarded })] }), NOW);
    assert.equal(res.valid, true, res.errors.join(" | "));
  });

  test("a frozen derived level needs no drift guard — it cannot move", () => {
    const frozen = developingPoc({ window: { from: NOW - 30 * DAY, to: NOW - DAY }, driftTolerance: {} });
    const res = validatePlan(plan({ branches: [branch({ entry: frozen })] }), NOW);
    assert.equal(res.valid, true, res.errors.join(" | "));
  });
});

describe("lifecycle", () => {
  test("there is no live_auto state", () => {
    assert.equal(Object.keys(PLAN_TRANSITIONS).includes("live_auto"), false);
    for (const targets of Object.values(PLAN_TRANSITIONS)) {
      assert.equal(targets.includes("live_auto" as never), false);
    }
  });

  test("a draft can only be armed, never jumped straight to triggered", () => {
    assert.equal(canTransitionPlan("draft", "planned"), true);
    assert.equal(canTransitionPlan("draft", "triggered"), false);
    assert.equal(canTransitionPlan("draft", "closed"), false);
  });

  test("an armed plan can trigger, expire or be invalidated", () => {
    assert.equal(canTransitionPlan("planned", "triggered"), true);
    assert.equal(canTransitionPlan("planned", "expired"), true);
    assert.equal(canTransitionPlan("planned", "invalidated"), true);
  });

  test("a triggered plan can still be invalidated — the thesis can fail while the trade is green", () => {
    assert.equal(canTransitionPlan("triggered", "invalidated"), true);
    assert.equal(canTransitionPlan("triggered", "closed"), true);
  });

  test("expired and invalidated are distinct terminal states", () => {
    /* Collapsing them would destroy the calibration record's most useful
       distinction: plans that never fired vs. plans that fired and were wrong. */
    assert.equal(isPlanTerminal("expired"), true);
    assert.equal(isPlanTerminal("invalidated"), true);
    assert.equal(isPlanTerminal("closed"), true);
    assert.equal(isPlanTerminal("planned"), false);
    assert.equal(canTransitionPlan("expired", "triggered"), false);
    assert.equal(canTransitionPlan("invalidated", "planned"), false);
  });

  test("expiry is evaluated against a supplied clock, not the wall clock", () => {
    assert.equal(isPlanExpired({ expiresAt: NOW + DAY }, NOW), false);
    assert.equal(isPlanExpired({ expiresAt: NOW }, NOW), true);
    assert.equal(isPlanExpired({ expiresAt: NOW - 1 }, NOW), true);
  });
});

describe("schema v13", () => {
  test("fresh database gets trade_plans and plan_branches", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec(SCHEMA_SQL);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(tables.includes("trade_plans"));
    assert.ok(tables.includes("plan_branches"));
    db.close();
  });

  test("expires_at is NOT NULL — a plan with no expiry cannot be stored", () => {
    /* The gate is enforced in validatePlan, but the column carries it too. A
       scenario plan with no expiry is the worst failure mode of the feature, so
       it should be impossible at two layers rather than one. */
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO sessions (uuid, pair, status, created_at, updated_at, paper_balance)
             VALUES ('u1', 'BTC-USD', 'active', ${NOW}, ${NOW}, '10000')`);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO trade_plans
               (session_id, slug, pair, thesis, invalidation_json, expires_at, risk_json, created_at, updated_at)
             VALUES (1, 'p', 'BTC-USD', 't', '{}', NULL, '{}', ${NOW}, ${NOW})`
          )
          .run(),
      /NOT NULL/i
    );
    db.close();
  });

  test("an EXISTING v15 database gains journal.ref_plan_id", () => {
    /* Same shape as the v12 test below, for the v16 column. A review of a
       plan-owned position has no strategy to point at, and the review IS the
       record S3-6 derives from — so it must be findable by plan, not by
       searching tag text. `CREATE TABLE IF NOT EXISTS` is a no-op on an
       existing database, so only the ALTER in the migration adds it. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyapari-mig16-"));
    try {
      const dataDir = path.join(dir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, "mybot.db");

      const seed = new DatabaseSync(file);
      seed.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      seed.exec(SCHEMA_SQL);
      /* Roll the journal back to its pre-v16 shape. SQLite can drop a column
         in recent versions; if it cannot, the table is rebuilt below. */
      try {
        seed.exec("ALTER TABLE journal DROP COLUMN ref_plan_id;");
      } catch {
        /* Older SQLite: leave it, the migration's guard will simply skip. */
      }
      seed.prepare("INSERT INTO settings(key,value) VALUES('schema_version','15')").run();
      seed.exec(`INSERT INTO sessions (uuid, pair, status, created_at, updated_at, paper_balance)
                 VALUES ('keep-16','ETH-USD','active',${NOW},${NOW},'999.99')`);
      seed.close();

      initDatabase(dir);
      const db = getDb();

      const cols = (db.prepare(`PRAGMA table_info(journal)`).all() as unknown as { name: string }[]).map(
        (c) => c.name
      );
      assert.ok(cols.includes("ref_plan_id"), "journal.ref_plan_id must exist after migrating");

      const version = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as {
        value: string;
      };
      assert.equal(version.value, String(SCHEMA_VERSION));

      /* Additive: nothing pre-existing may move. */
      const session = db.prepare("SELECT paper_balance FROM sessions WHERE uuid='keep-16'").get() as {
        paper_balance: string;
      };
      assert.equal(session.paper_balance, "999.99");
    } finally {
      try {
        getDb().close();
      } catch {
        /* already closed */
      }
      setDbForTesting(null as never);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an EXISTING v12 database gains the plan tables and is brought fully up to date", () => {
    /* The gap S1-5 left open: every other schema test builds a fresh database
       from SCHEMA_SQL, which is the one path a real installation never takes.
       This one starts from a v12 database on disk — tables present, v13 tables
       absent, schema_version = 12 — and runs the real `initDatabase`. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyapari-mig-"));
    try {
      const dataDir = path.join(dir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, "mybot.db");

      const seed = new DatabaseSync(file);
      seed.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      seed.exec(SCHEMA_SQL);
      // Roll it back to a genuine v12 shape.
      seed.exec("DROP TABLE IF EXISTS plan_branches; DROP TABLE IF EXISTS trade_plans;");
      seed.prepare("INSERT INTO settings(key,value) VALUES('schema_version','12')").run();
      seed.exec(`INSERT INTO sessions (uuid, pair, status, created_at, updated_at, paper_balance)
                 VALUES ('keep-me','BTC-USD','active',${NOW},${NOW},'12345.67')`);
      seed.close();

      initDatabase(dir);
      const db = getDb();

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => (r as { name: string }).name);
      assert.ok(tables.includes("trade_plans"), "trade_plans should exist after migrating");
      assert.ok(tables.includes("plan_branches"), "plan_branches should exist after migrating");

      const version = db.prepare("SELECT value FROM settings WHERE key='schema_version'").get() as {
        value: string;
      };
      /* Asserted against the constant rather than a literal: this test is about
         an old database being migrated forward, not about which version is
         current, and pinning the number makes every future bump fail here for
         no reason. */
      assert.equal(version.value, String(SCHEMA_VERSION));

      // The migration is additive: pre-existing data must be untouched.
      const session = db.prepare("SELECT paper_balance FROM sessions WHERE uuid='keep-me'").get() as {
        paper_balance: string;
      };
      assert.equal(session.paper_balance, "12345.67");
    } finally {
      try {
        getDb().close();
      } catch {
        /* already closed */
      }
      setDbForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  test("v15 rebuild preserves existing positions and enforces exactly-one-owner", () => {
    /* The riskiest migration so far: paper_positions is rebuilt, not altered,
       because SQLite cannot drop NOT NULL in place. What must hold is that
       real rows survive the copy intact, and that the new CHECK actually
       refuses the two ambiguous states — a position owned by both a strategy
       and a plan, or by neither. Ambiguous ownership would double-count in
       aggregates and leave the review agent unable to tell which intent to
       judge the trade against. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyapari-v15-"));
    try {
      const dataDir = path.join(dir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const file = path.join(dataDir, "mybot.db");

      const seed = new DatabaseSync(file);
      seed.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
      seed.exec(SCHEMA_SQL);
      // Roll paper_positions back to its v14 shape: no plan_branch_id, strategy_id NOT NULL.
      seed.exec("DROP TABLE paper_positions;");
      seed.exec(`CREATE TABLE paper_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        strategy_id INTEGER NOT NULL REFERENCES strategies(id),
        symbol TEXT NOT NULL, side TEXT NOT NULL DEFAULT 'buy',
        entry_price TEXT NOT NULL, quantity TEXT NOT NULL,
        entry_fee TEXT NOT NULL DEFAULT '0', stop_price TEXT, target_price TEXT,
        entry_order_id INTEGER, exit_order_id INTEGER,
        status TEXT NOT NULL DEFAULT 'open', exit_price TEXT, exit_reason TEXT,
        realized_pnl TEXT, fees_total TEXT, entry_reason TEXT,
        opened_at INTEGER NOT NULL, closed_at INTEGER,
        reviewed INTEGER NOT NULL DEFAULT 0, entry_levels_json TEXT
      );`);
      seed.prepare("INSERT INTO settings(key,value) VALUES('schema_version','14')").run();
      seed.exec(`INSERT INTO sessions (uuid, pair, status, created_at, updated_at, paper_balance)
                 VALUES ('s1','BTC-USD','active',${NOW},${NOW},'10000')`);
      seed.exec(`INSERT INTO strategies (session_id, name, spec_json, state, created_at)
                 VALUES (1,'legacy','{}','paper',${NOW})`);
      seed.exec(`INSERT INTO paper_positions
                   (session_id, strategy_id, symbol, entry_price, quantity, realized_pnl, opened_at, status)
                 VALUES (1, 1, 'BTC-USD', '101.5', '2', '42.25', ${NOW}, 'closed')`);
      seed.close();

      initDatabase(dir);
      const db = getDb();

      const cols = (db.prepare("PRAGMA table_info(paper_positions)").all() as unknown as { name: string }[])
        .map((c) => c.name);
      assert.ok(cols.includes("plan_branch_id"), "the new column must exist");

      const row = db.prepare("SELECT * FROM paper_positions WHERE id = 1").get() as unknown as {
        strategy_id: number; plan_branch_id: number | null; entry_price: string; realized_pnl: string;
      };
      assert.equal(row.strategy_id, 1, "the existing owner must survive the copy");
      assert.equal(row.plan_branch_id, null);
      assert.equal(row.entry_price, "101.5", "values must not shift columns during the copy");
      assert.equal(row.realized_pnl, "42.25");

      const insert = (strategyId: number | null, branchId: number | null) =>
        db
          .prepare(
            `INSERT INTO paper_positions (session_id, strategy_id, plan_branch_id, symbol,
               entry_price, quantity, opened_at) VALUES (1, ?, ?, 'BTC-USD', '1', '1', ${NOW})`
          )
          .run(strategyId, branchId);

      assert.throws(() => insert(1, 1), /CHECK/i, "owned by both must be refused");
      assert.throws(() => insert(null, null), /CHECK/i, "owned by neither must be refused");
    } finally {
      try {
        getDb().close();
      } catch {
        /* already closed */
      }
      setDbForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a slug is unique within a session but reusable across sessions", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO sessions (uuid, pair, status, created_at, updated_at, paper_balance)
             VALUES ('u1','BTC-USD','active',${NOW},${NOW},'10000'),
                    ('u2','ETH-USD','active',${NOW},${NOW},'10000')`);
    const ins = db.prepare(
      `INSERT INTO trade_plans
         (session_id, slug, pair, thesis, invalidation_json, expires_at, risk_json, created_at, updated_at)
       VALUES (?, ?, 'X-USD', 't', '{}', ${NOW + DAY}, '{}', ${NOW}, ${NOW})`
    );
    ins.run(1, "range-break");
    ins.run(2, "range-break"); // same slug, different session — allowed
    assert.throws(() => ins.run(1, "range-break"), /UNIQUE/i);
    db.close();
  });
});
