import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
const pool = new Pool({
  connectionString: DATABASE_URL,
  // If you're connecting locally on LAN, you usually don't need SSL.
  // ssl: { rejectUnauthorized: false },
});

const statements: string[] = [
  // Extensions
  `CREATE EXTENSION IF NOT EXISTS citext;`,

  // Core tables
  `
  CREATE TABLE IF NOT EXISTS chains (
    chain_id   integer PRIMARY KEY,
    name       text NOT NULL,
    rpc_url    text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS aave_markets (
    id           bigserial PRIMARY KEY,
    chain_id     integer NOT NULL REFERENCES chains(chain_id),
    name         text NOT NULL,
    pool_address citext NOT NULL,
    UNIQUE (chain_id, pool_address)
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS assets (
    id            bigserial PRIMARY KEY,
    chain_id      integer NOT NULL REFERENCES chains(chain_id),
    asset_address citext NOT NULL,
    symbol        text,
    decimals      integer,
    UNIQUE (chain_id, asset_address)
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS borrowers (
    id            bigserial PRIMARY KEY,
    chain_id      integer NOT NULL REFERENCES chains(chain_id),
    user_address  citext NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,
    active        boolean NOT NULL DEFAULT true,
    UNIQUE (chain_id, user_address)
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS borrower_monitor_state (
    borrower_id        bigint PRIMARY KEY REFERENCES borrowers(id) ON DELETE CASCADE,
    priority           smallint NOT NULL DEFAULT 0,
    next_check_at      timestamptz NOT NULL DEFAULT now(),
    last_check_at      timestamptz,
    last_health_factor numeric(38,18),
    last_status        text,
    last_error         text
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS borrower_monitor_state_next_check_idx
    ON borrower_monitor_state (next_check_at);
  `,

  `
  CREATE TABLE IF NOT EXISTS borrower_snapshots (
    id                      bigserial PRIMARY KEY,
    borrower_id             bigint NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    observed_at             timestamptz NOT NULL,
    block_number            bigint NOT NULL,
    health_factor           numeric(38,18),
    total_collateral_usd    numeric(38,18),
    total_debt_usd          numeric(38,18),
    available_borrows_usd   numeric(38,18),
    ltv                     numeric(38,18),
    liquidation_threshold   numeric(38,18),
    UNIQUE (borrower_id, block_number)
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS borrower_snapshots_borrower_time_idx
    ON borrower_snapshots (borrower_id, observed_at DESC);
  `,

  `
  CREATE INDEX IF NOT EXISTS borrower_snapshots_hf_idx
    ON borrower_snapshots (observed_at DESC, health_factor);
  `,

  `
  CREATE TABLE IF NOT EXISTS borrower_reserve_snapshots (
    id                   bigserial PRIMARY KEY,
    borrower_snapshot_id bigint NOT NULL REFERENCES borrower_snapshots(id) ON DELETE CASCADE,
    asset_id             bigint NOT NULL REFERENCES assets(id),
    is_collateral        boolean NOT NULL DEFAULT false,
    supplied_amount      numeric(78,0),
    borrowed_amount      numeric(78,0),
    UNIQUE (borrower_snapshot_id, asset_id)
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS liquidation_calls (
    id                          bigserial PRIMARY KEY,
    chain_id                    integer NOT NULL REFERENCES chains(chain_id),
    market_id                   bigint REFERENCES aave_markets(id),
    block_number                bigint NOT NULL,
    tx_hash                     bytea NOT NULL,
    log_index                   integer NOT NULL,

    collateral_asset_address    citext NOT NULL,
    debt_asset_address          citext NOT NULL,
    user_address                citext NOT NULL,
    liquidator_address          citext NOT NULL,

    debt_to_cover               numeric(78,0) NOT NULL,
    liquidated_collateral_amount numeric(78,0) NOT NULL,
    receive_a_token             boolean NOT NULL,

    observed_at                 timestamptz NOT NULL DEFAULT now(),

    UNIQUE (chain_id, tx_hash, log_index)
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS liquidation_calls_user_idx
    ON liquidation_calls (chain_id, user_address, block_number DESC);
  `,

  `
  CREATE TABLE IF NOT EXISTS liquidation_attempts (
    id                       bigserial PRIMARY KEY,
    chain_id                  integer NOT NULL REFERENCES chains(chain_id),
    market_id                 bigint REFERENCES aave_markets(id),
    borrower_id               bigint REFERENCES borrowers(id),
    created_at                timestamptz NOT NULL DEFAULT now(),

    collateral_asset_address  citext,
    debt_asset_address        citext,

    planned_debt_to_cover     numeric(78,0),
    planned_receive_a_token   boolean,

    status                    text NOT NULL,
    tx_hash                   bytea,
    error                     text
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS liquidation_attempts_status_time_idx
    ON liquidation_attempts (status, created_at DESC);
  `,

  // Optional: subgraph pagination/discovery tables
  `
  CREATE TABLE IF NOT EXISTS subgraph_cursors (
    id          bigserial PRIMARY KEY,
    chain_id    integer NOT NULL,
    subgraph_id text NOT NULL,
    entity      text NOT NULL,
    cursor_name text NOT NULL,
    last_id     text NOT NULL DEFAULT '',
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id, subgraph_id, entity, cursor_name)
  );
  `,

  `
  CREATE TABLE IF NOT EXISTS subgraph_positions_borrowers (
    id           text PRIMARY KEY,
    chain_id     integer NOT NULL,
    subgraph_id  text NOT NULL,
    borrower     citext NOT NULL,
    principal    text,
    discovered_at timestamptz NOT NULL DEFAULT now()
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS subgraph_positions_borrowers_borrower_idx
    ON subgraph_positions_borrowers (chain_id, borrower);
  `,

  `
  CREATE TABLE IF NOT EXISTS liquidation_opportunities (
    id bigserial PRIMARY KEY,
    borrower_id bigint NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    observed_at timestamptz NOT NULL DEFAULT now(),
    health_factor numeric(38,18) NOT NULL,
    collateral_asset_address citext,
    total_collateral_base numeric(38,18),
    total_debt_base numeric(38,18),
    estimated_profit_usd numeric(38,18),
    notes text
  );
  `,

  `
  CREATE INDEX IF NOT EXISTS liquidation_opportunities_borrower_time_idx
    ON liquidation_opportunities (borrower_id, observed_at DESC);
  `,
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('Schema created/verified.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed creating schema:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
