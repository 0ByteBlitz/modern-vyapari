/**
 * SQLite schema — core tables from the plan (§4 sessions, §5 memory, §10 backtests).
 * Structured facts are ground truth; journal is append-only; audit_log is order-affecting actions.
 *
 * v4: added description/backtest_count/last_evaluated_at to strategies; added alerts table.
 * v5: added paper_balance to sessions.
 * v6: added paper_positions (explicit position state for the paper exchange —
 *     previously inferred by replaying the whole order log on every reload).
 * v7: added basis_samples — measured Revolut X vs. Binance spread and basis, so
 *     the gap between the analysis feed and the execution venue is a number we
 *     track rather than an assumption.
 * v8: purged cached candles for non-USD quote pairs. Those rows were written
 *     by two paths that disagreed (WS applied an FX divisor, REST backfill did
 *     not), so a single symbol's history mixed GBP and USD prices.
 * v9: added chart_drawings — persisted research annotations (trendlines, fib,
 *     wave counts, position tools) per symbol.
 * v10: recomputed sessions.paper_balance from the position history. The column
 *     was missing from getSessionById's SELECT, so the paper engine read
 *     `undefined` on every candle and every stored balance was wrong.
 * v11: added candles.taker_buy_volume — the aggressor split Binance already
 *     sends on both ingest paths (kline index 9 / WS `k.V`) and both discarded.
 *     It is the only ingredient CVD needs: delta = 2×takerBuy − volume.
 *     NULLABLE ON PURPOSE: NULL means "unknown", and must never be coerced to
 *     0 (that would read as delta = −volume, a bar of pure selling that never
 *     happened). Existing rows stay NULL and heal as history is refetched,
 *     since both backfill paths use ON CONFLICT DO UPDATE.
 * v12: added paper_positions.entry_levels_json — what each derived PriceLevel
 *     was worth when the position opened, against what it was worth when the
 *     strategy was armed. Without it the review agent cannot answer the one
 *     question no PnL figure will ever reveal: did the trigger fire because
 *     price moved, or because the LEVEL moved toward price? An anchored
 *     profile's POC migrates toward price as volume accumulates, so a
 *     strategy can appear to be catching setups while the setups are walking
 *     into it. NULL for every position with purely numeric thresholds.
 * v13: trade_plans + plan_branches (roadmap S3-1). Scenario plans get their own
 *     tables rather than a `type` flag on `strategies`, because a flag would
 *     make `backtested` meaningless for half the rows — a plan is never
 *     backtested, and statistical validation is inapplicable to a one-shot bet
 *     on a path, not merely unavailable. Branches are a child table rather than
 *     JSON because the monitor queries them individually (which branch fired,
 *     which were cancelled by OCO) and OCO cancellation must be recorded per
 *     branch, not inferred from a blob.
 * v15: paper_positions gained plan_branch_id and made strategy_id nullable,
 *     with a CHECK that exactly one of the two is set. A plan needs somewhere
 *     to record the position it opened, and the fill model must stay shared —
 *     a second positions table would be a second execution path, which is the
 *     one thing §17 forbids outright. Required a table rebuild, since SQLite
 *     cannot drop a NOT NULL constraint in place.
 * v18: trade_plans.reviewed. A plan that expired or was invalidated WITHOUT
 *     ever firing got no journal entry at all — review only ever ran on a
 *     closed position. That is backwards: a plan that never triggered is the
 *     most informative case for the calibration record, and it was the one
 *     case with no written record. Same idempotency flag as paper_positions.
 * v19: api_usage. Every Anthropic call records its own token counts and the
 *     dollar cost computed AT WRITE TIME — prices change, and repricing
 *     history at today's rates would rewrite what was actually paid. There is
 *     no account-balance endpoint for a normal API key (Anthropic's cost
 *     reports need an Admin key, which is unavailable to individual accounts),
 *     so measured spend is the only figure this app can state honestly.
 * v20: paper_account — ONE balance, not one per session. `sessions.paper_balance`
 *     defaulted to 10,000, so every session minted ten thousand dollars from
 *     nothing and the portfolio total was their sum: open five sessions and the
 *     headline read $50,000, a figure that looks like capital and is really a
 *     count. It also made "not enough cash" unreachable. The column stays for
 *     history but nothing reads it; cash is an account fact, not a workspace one.
 * v14: level_references (roadmap S2-2) — the semantic layer over
 *     chart_drawings. A drawing is geometry; a reference is what the trader
 *     meant, as a PriceLevel definition, so the chart renders from it and the
 *     engine resolves from it rather than each holding its own idea of the
 *     same level.
 */
/* v21: general_chat_messages — the conversation with the agent when no session
 *     is open. `chat_messages.session_id` is NOT NULL (and SQLite cannot relax
 *     that without a table rebuild), so the general thread gets its own table
 *     rather than a sentinel session id that a JOIN would one day trip over.
 *     Plain CREATE TABLE IF NOT EXISTS: no data moves, nothing to migrate. */
export const SCHEMA_VERSION = 21;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Session identity model (v2):
--   id   = internal surrogate key (all FKs point here)
--   uuid = stable opaque identifier (export/sync-safe, never derived from data)
--   pair = scoping attribute, NOT identity. Uniqueness applies only to LIVE
--          sessions (partial index below) — archived sessions form history
--          ("epochs"), so a pair can be traded fresh after archiving.
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT NOT NULL UNIQUE,
  pair        TEXT NOT NULL,                     -- e.g. 'BTC-USD'
  status      TEXT NOT NULL DEFAULT 'active',    -- active | paused | archived
  risk_config TEXT NOT NULL DEFAULT '{}',        -- JSON, per-pair limits
  paper_balance TEXT NOT NULL DEFAULT '10000.00',-- virtual USD balance for Phase 3
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_live_pair
  ON sessions(pair) WHERE status != 'archived';

CREATE TABLE IF NOT EXISTS strategies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES sessions(id),
  name             TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  spec_json        TEXT NOT NULL,                     -- formal strategy spec (§6)
  state            TEXT NOT NULL DEFAULT 'draft',     -- draft|backtested|paper|live_supervised|live_auto|retired
  description      TEXT DEFAULT '',                   -- human-readable summary
  backtest_count   INTEGER NOT NULL DEFAULT 0,        -- quick lookup for UI badge
  last_evaluated_at INTEGER,                          -- when last checked against live data
  created_at       INTEGER NOT NULL,
  UNIQUE(session_id, name, version)
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES sessions(id),
  strategy_id      INTEGER REFERENCES strategies(id),
  client_order_id  TEXT NOT NULL UNIQUE,         -- UUID, idempotency key
  venue_order_id   TEXT UNIQUE,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL,                -- buy | sell
  type             TEXT NOT NULL,                -- market | limit | tpsl | conditional
  quantity         TEXT,
  quote_amount     TEXT,
  price            TEXT,
  status           TEXT NOT NULL,                -- proposed|approved|submitted|new|partially_filled|filled|cancelled|rejected|expired
  mode             TEXT NOT NULL DEFAULT 'paper',-- paper | live
  reasoning        TEXT,                         -- AI reasoning snapshot at proposal time
  raw_json         TEXT,                         -- last venue response
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  order_id    INTEGER REFERENCES orders(id),
  venue_trade_id TEXT UNIQUE,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  price       TEXT NOT NULL,
  quantity    TEXT NOT NULL,
  fee         TEXT,
  fee_currency TEXT,
  mode        TEXT NOT NULL DEFAULT 'paper',
  executed_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  kind        TEXT NOT NULL,                     -- trade_review|backtest_review|strategy_note|observation|lesson
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '',          -- comma-separated
  ref_trade_id    INTEGER REFERENCES trades(id),
  ref_strategy_id INTEGER REFERENCES strategies(id),
  -- v16. A review of a plan-owned position has no strategy to point at, and
  -- the review IS the record — S3-6's calibration figures are derived from it,
  -- so it has to be findable by plan rather than only by tag text.
  ref_plan_id     INTEGER REFERENCES trade_plans(id),
  created_at  INTEGER NOT NULL
);


-- v17. The notification outbox. Rows are written in the SAME transaction as the
-- state change they describe, so "traded but never told" and "told twice" are
-- both structurally impossible rather than guarded against. The dedupe key is
-- derived from the event, never the clock — enqueuing one event twice is one
-- message. (No backticks in this file: SCHEMA_SQL is a template literal.)
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

CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  content, tags, content_rowid=id, content=journal
);

CREATE TRIGGER IF NOT EXISTS journal_ai AFTER INSERT ON journal BEGIN
  INSERT INTO journal_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS backtests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  strategy_id INTEGER REFERENCES strategies(id),
  params_json TEXT NOT NULL,
  result_json TEXT,
  data_from   INTEGER,
  data_until  INTEGER,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candles (
  symbol       TEXT NOT NULL,
  interval_min INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  open   TEXT NOT NULL,
  high   TEXT NOT NULL,
  low    TEXT NOT NULL,
  close  TEXT NOT NULL,
  volume TEXT NOT NULL,
  -- Taker (aggressor) BUY base volume for the bar. NULL = unknown, never 0:
  -- see schema v11 note. Taker sell volume = volume - taker_buy_volume.
  taker_buy_volume TEXT,
  source TEXT NOT NULL DEFAULT 'revx',           -- revx | binance | coinbase
  PRIMARY KEY (source, symbol, interval_min, start_ms)
);

-- Paper exchange position state (v6). One row per round trip. The paper
-- engine's authoritative record of what it holds — orders/trades remain the
-- append-only fill log, this is the position-level view (entry, protective
-- levels, exit reason, realized PnL) that the post-trade review agent reads.
CREATE TABLE IF NOT EXISTS paper_positions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER NOT NULL REFERENCES sessions(id),
  -- v15: EXACTLY ONE owner. A position is opened either by a strategy or by a
  -- plan branch, never both and never neither. The alternative considered and
  -- rejected was a synthetic strategy row per plan: it would have kept this
  -- column NOT NULL at the cost of putting plans into the strategy lifecycle,
  -- corrupting both the promotion states and the calibration record.
  strategy_id    INTEGER REFERENCES strategies(id),
  plan_branch_id INTEGER REFERENCES plan_branches(id),
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL DEFAULT 'buy',
  entry_price    TEXT NOT NULL,                  -- fill price incl. slippage
  quantity       TEXT NOT NULL,
  entry_fee      TEXT NOT NULL DEFAULT '0',
  stop_price     TEXT,                           -- venue-side SL equivalent (§ plan: every position carries TP/SL)
  target_price   TEXT,
  entry_order_id INTEGER REFERENCES orders(id),
  exit_order_id  INTEGER REFERENCES orders(id),
  status         TEXT NOT NULL DEFAULT 'open',   -- open | closed
  exit_price     TEXT,
  -- Who decided the exit. exit_signal/stop_loss/take_profit = the strategy;
  -- manual/session_archived = the operator (excluded from promotion evidence).
  exit_reason    TEXT,                           -- exit_signal | stop_loss | take_profit | manual | session_archived
  realized_pnl   TEXT,                           -- net of both fees
  fees_total     TEXT,
  entry_reason   TEXT,
  opened_at      INTEGER NOT NULL,
  closed_at      INTEGER,
  reviewed       INTEGER NOT NULL DEFAULT 0,     -- 0 until the review agent has journalled it
  -- Derived PriceLevels as resolved at entry, vs. their armed values (v12).
  -- JSON array; NULL when the spec used only numeric thresholds.
  entry_levels_json TEXT,
  -- The constraint is the point of v15: "owned by a strategy" and "owned by a
  -- plan" must never both be true, or aggregates would double-count and the
  -- review agent would not know which intent to judge the trade against.
  CHECK ((strategy_id IS NULL) <> (plan_branch_id IS NULL))
);

-- Basis monitor (v7). One row per sample of "what the analysis feed says" vs.
-- "what the execution venue is actually quoting". Strategies are validated on
-- Binance prices but fill on Revolut X, and on thin alts those differ; this
-- table turns that gap into measured bps instead of an assumption.
--   revx_spread_bps = (ask - bid) / mid       — cost of crossing RevX's book
--   basis_bps       = (revx_mid - bin_mid) / bin_mid — venue price disagreement
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

-- Research annotations (v9). Human-authored chart work: trendlines, fib,
-- Elliott counts, anchored VWAPs, position tools. Keyed by symbol, not by
-- session, because a level you drew on ARB-USD is true regardless of which
-- session you were in when you drew it.
--   kind   = klinecharts overlay name (or a custom tool name)
--   points = JSON array of {timestamp, value} anchors
--   extend = JSON blob for tool-specific state (styles, locked, text)
CREATE TABLE IF NOT EXISTS chart_drawings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT NOT NULL,
  interval_min INTEGER,                          -- NULL = show on every timeframe
  kind         TEXT NOT NULL,
  points       TEXT NOT NULL,
  extend       TEXT NOT NULL DEFAULT '{}',
  locked       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER REFERENCES sessions(id),
  model       TEXT NOT NULL,
  -- chat | trade_review | plan_review | lessons | other. So a bill can be
  -- attributed rather than only totalled.
  purpose     TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- NULL when the model has no published price here. Zero would be
  -- indistinguishable from free and would silently under-report the total.
  cost_usd    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_usage_time ON api_usage(created_at DESC);

-- v20. Exactly one row (id = 1). Cash belongs to the account, not to a
-- session — a session is a workspace for one pair's plans and history.
-- In LIVE mode this is not the authority: the venue's balances are.
CREATE TABLE IF NOT EXISTS paper_account (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  balance         TEXT NOT NULL,
  -- What it started at, so a return is computable without replaying fills.
  initial_balance TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,                      -- e.g. order_proposed, order_submitted, kill_switch
  detail     TEXT NOT NULL,                      -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS general_chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,                     -- user | assistant
  content     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,                     -- user | assistant | system
  content     TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER REFERENCES sessions(id),
  label        TEXT NOT NULL,
  condition    TEXT NOT NULL,                      -- JSON (Condition from strategy-spec)
  status       TEXT NOT NULL DEFAULT 'active',     -- active | triggered | dismissed
  triggered_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- Plan references (v14, plan §17): the SEMANTIC layer over chart_drawings.
-- A drawing is geometry — points on a canvas. A reference is what the trader
-- meant, stored as a PriceLevel definition, so the chart renders from it and
-- the engine resolves from it: one definition, two consumers.
--
-- level_json holds a LevelDraft — a PriceLevel WITHOUT resolvedAtArm, because
-- a reference is created long before any plan is armed and there is no
-- "value at arm" yet. Arming fills it in. Storing a placeholder would put a
-- fabricated number in the field every drift check measures against.
CREATE TABLE IF NOT EXISTS level_references (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT NOT NULL,
  -- NULL means the reference applies on every timeframe, matching the same
  -- convention chart_drawings uses for horizontal levels.
  interval_min INTEGER,
  label        TEXT NOT NULL,
  level_json   TEXT NOT NULL,
  -- The drawing this was promoted from, when there was one. ON DELETE SET NULL
  -- is expressed by the service rather than the constraint: erasing the ink
  -- must not erase the meaning, because a plan may already reference it.
  drawing_id   INTEGER REFERENCES chart_drawings(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Scenario plans (v13, plan §17). A thesis the trader authored, monitored
-- mechanically. Separate from the strategies table on purpose: a plan is never
-- backtested, so sharing it would make the "backtested" state meaningless for
-- half the rows.
CREATE TABLE IF NOT EXISTS trade_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  slug          TEXT NOT NULL,
  pair          TEXT NOT NULL,
  thesis        TEXT NOT NULL,
  -- JSON PlanAssumption[]. At least one, enforced by validatePlan before arming.
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  -- JSON ConditionGroup: where the THESIS is wrong. Not a stop — this can fire
  -- while the position is in profit, and when it does the plan is over.
  invalidation_json TEXT NOT NULL,
  -- Hard expiry, ms epoch. NOT NULL: a scenario plan with no expiry is the
  -- worst failure mode of this whole feature.
  expires_at    INTEGER NOT NULL,
  risk_json     TEXT NOT NULL,                     -- JSON PlanRiskBudget
  oco_exclusive INTEGER NOT NULL DEFAULT 1,        -- branches are OCO by default
  eval_interval TEXT NOT NULL DEFAULT '4h',
  -- draft | planned | triggered | closed | expired | invalidated.
  -- There is deliberately no live_auto: a plan's licence comes from
  -- falsifiability, never from a validated edge.
  state         TEXT NOT NULL DEFAULT 'draft',
  -- v18. 0 until the review agent has written the plan's closing note. Only
  -- plans that resolved WITHOUT a position need one; a plan that traded is
  -- covered by its position's trade_review.
  reviewed      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  armed_at      INTEGER,
  -- Why the plan ended, in its own words. Distinguishes "never fired" from
  -- "fired and was wrong", which is the calibration record's whole point.
  outcome_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_at     INTEGER
);

-- One row per branch of the path. A child table rather than JSON because the
-- monitor asks per-branch questions — which fired, which OCO cancelled — and an
-- answer inferred from a blob is an answer nothing can index or audit.
CREATE TABLE IF NOT EXISTS plan_branches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL REFERENCES trade_plans(id),
  slug         TEXT NOT NULL,
  label        TEXT NOT NULL,
  trigger_json TEXT NOT NULL,                      -- JSON ConditionGroup
  entry_json   TEXT NOT NULL,                      -- JSON PriceLevel
  stop_json    TEXT NOT NULL,                      -- JSON PriceLevel
  targets_json TEXT NOT NULL,                      -- JSON PriceLevel[]
  budget_share_pct REAL NOT NULL,
  -- pending | triggered | cancelled_oco | expired
  status       TEXT NOT NULL DEFAULT 'pending',
  triggered_at INTEGER,
  -- Set when this branch opened a position, so a plan's outcome can be traced
  -- to the fill without re-deriving it.
  position_id  INTEGER REFERENCES paper_positions(id),
  -- What each derived level resolved to at trigger, vs. its value at arm.
  -- Same question as paper_positions.entry_levels_json (v12): did price move to
  -- the level, or the level to price?
  trigger_levels_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_session   ON orders(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trades_session   ON trades(session_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_journal_session  ON journal(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_session   ON alerts(session_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_pos_strategy ON paper_positions(strategy_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_pos_review   ON paper_positions(status, reviewed);
-- NOTE: no index on plan_branch_id here. SCHEMA_SQL is re-executed on EVERY
-- startup, including against a database whose paper_positions is still the
-- pre-v15 shape, and an index over a column that does not exist yet fails the
-- whole statement — crashing the app before the migration that would add it
-- can run. It is created in the v15 block instead. **Any index over a column
-- introduced by a rebuild belongs with the rebuild, not here.**
CREATE INDEX IF NOT EXISTS idx_basis_symbol_time  ON basis_samples(symbol, sampled_at);
CREATE INDEX IF NOT EXISTS idx_drawings_symbol    ON chart_drawings(symbol, interval_min);
CREATE INDEX IF NOT EXISTS idx_plans_session      ON trade_plans(session_id, state);
CREATE INDEX IF NOT EXISTS idx_plans_expiry       ON trade_plans(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_plan_branches_plan ON plan_branches(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_levelrefs_symbol   ON level_references(symbol, interval_min);
-- A slug identifies a plan within its session; two sessions may reuse one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_slug  ON trade_plans(session_id, slug);
`;
