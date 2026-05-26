import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_wallet (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      remark TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployed_contract (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      deployer_address TEXT NOT NULL,
      contract_address TEXT NOT NULL UNIQUE,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      deploy_time INTEGER NOT NULL,
      is_token INTEGER DEFAULT 0,
      token_name TEXT,
      token_symbol TEXT,
      token_decimals INTEGER,
      total_supply TEXT,
      status TEXT NOT NULL DEFAULT 'deployed_no_liquidity',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deployed_status ON deployed_contract(status);
    CREATE INDEX IF NOT EXISTS idx_deployed_time ON deployed_contract(deploy_time DESC);

    CREATE TABLE IF NOT EXISTS token_pair (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      pair_address TEXT NOT NULL UNIQUE,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      quote_token TEXT NOT NULL,
      quote_symbol TEXT,
      dex_name TEXT DEFAULT 'PancakeSwap',
      created_tx_hash TEXT,
      created_block INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pair_token ON token_pair(token_address);

    CREATE TABLE IF NOT EXISTS token_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number INTEGER NOT NULL,
      event_time INTEGER NOT NULL,
      from_address TEXT,
      to_address TEXT,
      trader TEXT,
      token_amount TEXT,
      quote_amount TEXT,
      price REAL DEFAULT 0,
      pair_address TEXT,
      UNIQUE(tx_hash, log_index, token_address)
    );
    CREATE INDEX IF NOT EXISTS idx_event_token_time ON token_event(token_address, event_time DESC);
    CREATE INDEX IF NOT EXISTS idx_event_type ON token_event(token_address, event_type);

    CREATE TABLE IF NOT EXISTS token_holder (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      holder_address TEXT NOT NULL,
      balance TEXT NOT NULL DEFAULT '0',
      balance_percent REAL DEFAULT 0,
      last_active_time INTEGER,
      address_tag TEXT,
      UNIQUE(chain_id, token_address, holder_address)
    );
    CREATE INDEX IF NOT EXISTS idx_holder_token ON token_holder(token_address, balance);

    CREATE TABLE IF NOT EXISTS token_address_stat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      buy_count INTEGER DEFAULT 0,
      sell_count INTEGER DEFAULT 0,
      transfer_in_count INTEGER DEFAULT 0,
      transfer_out_count INTEGER DEFAULT 0,
      total_buy_token TEXT DEFAULT '0',
      total_sell_token TEXT DEFAULT '0',
      total_buy_value REAL DEFAULT 0,
      total_sell_value REAL DEFAULT 0,
      current_balance TEXT DEFAULT '0',
      is_cleared INTEGER DEFAULT 0,
      last_trade_time INTEGER,
      UNIQUE(chain_id, token_address, wallet_address)
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      token_address TEXT,
      pair_address TEXT,
      tx_hash TEXT,
      message TEXT,
      channel TEXT DEFAULT 'telegram',
      send_status TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_price_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      price_usd REAL NOT NULL,
      liquidity_usd REAL DEFAULT 0,
      token_reserve TEXT,
      quote_reserve TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_price_snap_token_time
      ON token_price_snapshot(token_address, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS token_market_cache (
      token_address TEXT PRIMARY KEY,
      symbol TEXT,
      price_usd REAL DEFAULT 0,
      price_change_5m REAL DEFAULT 0,
      price_change_15m REAL DEFAULT 0,
      price_change_1h REAL DEFAULT 0,
      price_change_24h REAL DEFAULT 0,
      high_24h REAL DEFAULT 0,
      low_24h REAL DEFAULT 0,
      volume_24h_usd REAL DEFAULT 0,
      liquidity_usd REAL DEFAULT 0,
      token_reserve TEXT,
      quote_reserve TEXT,
      holder_count INTEGER DEFAULT 0,
      liquidity_change_24h REAL DEFAULT 0,
      liquidity_change_7d REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staking_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      action TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER,
      event_time INTEGER NOT NULL,
      UNIQUE(tx_hash, token_address, wallet_address, action)
    );
    CREATE INDEX IF NOT EXISTS idx_staking_token ON staking_record(token_address, event_time DESC);

    CREATE TABLE IF NOT EXISTS token_staking_stat (
      token_address TEXT PRIMARY KEY,
      total_staked TEXT DEFAULT '0',
      staker_count INTEGER DEFAULT 0,
      stake_24h TEXT DEFAULT '0',
      unstake_24h TEXT DEFAULT '0',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_liquidity_stat (
      token_address TEXT PRIMARY KEY,
      pair_address TEXT,
      liquidity_usd REAL DEFAULT 0,
      lp_burned_pct REAL DEFAULT 0,
      lp_locked_pct REAL DEFAULT 0,
      lp_holder_count INTEGER DEFAULT 0,
      change_24h_pct REAL DEFAULT 0,
      change_7d_pct REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_risk_scan (
      token_address TEXT PRIMARY KEY,
      owner_address TEXT,
      owner_renounced INTEGER DEFAULT 0,
      can_mint INTEGER DEFAULT 0,
      has_blacklist INTEGER DEFAULT 0,
      trading_disabled INTEGER DEFAULT 0,
      risk_level TEXT DEFAULT 'UNKNOWN',
      risk_flags TEXT,
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunity_score (
      token_address TEXT PRIMARY KEY,
      score INTEGER DEFAULT 50,
      trend TEXT DEFAULT 'NEUTRAL',
      bullish_signals TEXT,
      bearish_signals TEXT,
      risk_signals TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS address_label (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      label TEXT NOT NULL,
      confidence REAL DEFAULT 1,
      reason TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain_id, token_address, wallet_address, label)
    );
    CREATE INDEX IF NOT EXISTS idx_label_token ON address_label(token_address, label);

    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      sync_type TEXT NOT NULL,
      start_block INTEGER NOT NULL DEFAULT 0,
      last_synced_block INTEGER NOT NULL DEFAULT 0,
      latest_block INTEGER,
      confirm_blocks INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      error_message TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain_id, token_address, sync_type)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_token ON sync_status(token_address, sync_type);

    CREATE TABLE IF NOT EXISTS listener_service (
      service_name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      heartbeat_at INTEGER NOT NULL,
      latest_block INTEGER,
      lag_blocks INTEGER DEFAULT 0,
      error_message TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT,
      contract_address TEXT NOT NULL,
      event_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number INTEGER NOT NULL,
      block_hash TEXT,
      block_time INTEGER NOT NULL,
      topic0 TEXT,
      topics TEXT,
      data TEXT,
      decoded_data TEXT,
      from_address TEXT,
      to_address TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      process_status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_token_time ON raw_events(token_address, block_time DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_processed ON raw_events(processed, process_status);

    CREATE TABLE IF NOT EXISTS sync_failed_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      sync_type TEXT NOT NULL,
      block_from INTEGER NOT NULL,
      block_to INTEGER NOT NULL,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain_id, token_address, sync_type, block_from, block_to)
    );

    CREATE TABLE IF NOT EXISTS holder_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      wallet_balance TEXT NOT NULL DEFAULT '0',
      staking_balance TEXT NOT NULL DEFAULT '0',
      total_balance TEXT NOT NULL DEFAULT '0',
      balance_usd REAL NOT NULL DEFAULT 0,
      holding_percent REAL NOT NULL DEFAULT 0,
      buy_count INTEGER NOT NULL DEFAULT 0,
      sell_count INTEGER NOT NULL DEFAULT 0,
      total_buy_amount TEXT NOT NULL DEFAULT '0',
      total_buy_usd TEXT NOT NULL DEFAULT '0',
      total_sell_amount TEXT NOT NULL DEFAULT '0',
      total_sell_usd TEXT NOT NULL DEFAULT '0',
      net_buy_amount TEXT NOT NULL DEFAULT '0',
      net_buy_usd TEXT NOT NULL DEFAULT '0',
      avg_buy_price TEXT NOT NULL DEFAULT '0',
      avg_sell_price TEXT NOT NULL DEFAULT '0',
      realized_pnl TEXT NOT NULL DEFAULT '0',
      unrealized_pnl TEXT NOT NULL DEFAULT '0',
      total_pnl TEXT NOT NULL DEFAULT '0',
      roi TEXT NOT NULL DEFAULT '0',
      first_buy_time INTEGER,
      last_trade_time INTEGER,
      highest_balance TEXT NOT NULL DEFAULT '0',
      highest_balance_usd TEXT NOT NULL DEFAULT '0',
      is_contract INTEGER NOT NULL DEFAULT 0,
      is_whale INTEGER NOT NULL DEFAULT 0,
      is_super_whale INTEGER NOT NULL DEFAULT 0,
      is_staking_user INTEGER NOT NULL DEFAULT 0,
      is_cleared INTEGER NOT NULL DEFAULT 0,
      is_new_wallet INTEGER NOT NULL DEFAULT 0,
      holder_level TEXT NOT NULL DEFAULT 'small',
      liquidity_impact TEXT NOT NULL DEFAULT 'low',
      behavior_tags TEXT NOT NULL DEFAULT '[]',
      risk_tags TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      UNIQUE(chain_id, token_address, wallet_address)
    );
    CREATE INDEX IF NOT EXISTS idx_holder_profiles_token ON holder_profiles(token_address, balance_usd DESC);
    CREATE INDEX IF NOT EXISTS idx_holder_profiles_level ON holder_profiles(token_address, holder_level);

    CREATE TABLE IF NOT EXISTS addresses (
      chain_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      address_type TEXT NOT NULL DEFAULT 'wallet',
      is_contract INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, address)
    );

    CREATE TABLE IF NOT EXISTS token_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      address_type TEXT NOT NULL DEFAULT 'wallet',
      is_contract INTEGER NOT NULL DEFAULT 0,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number INTEGER NOT NULL,
      block_time INTEGER NOT NULL,
      trade_type TEXT NOT NULL,
      side TEXT,
      token_amount TEXT NOT NULL DEFAULT '0',
      quote_amount TEXT NOT NULL DEFAULT '0',
      amount_usd REAL DEFAULT 0,
      price REAL DEFAULT 0,
      balance_after TEXT,
      staking_balance_after TEXT,
      buy_count_after INTEGER DEFAULT 0,
      sell_count_after INTEGER DEFAULT 0,
      from_address TEXT,
      to_address TEXT,
      pair_address TEXT,
      contract_address TEXT,
      UNIQUE(chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_token_time ON token_transactions(token_address, block_time DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_wallet ON token_transactions(token_address, wallet_address, block_time DESC);

    CREATE TABLE IF NOT EXISTS lp_notify_state (
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      pair_address TEXT NOT NULL,
      notify_key TEXT NOT NULL,
      tx_hash TEXT,
      block_number INTEGER,
      notified_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, token_address, pair_address, notify_key)
    );
  `);

  migrateColumns(db);
}

function migrateColumns(db: Database.Database): void {
  const alters: string[] = [
    'ALTER TABLE token_event ADD COLUMN amount_usd REAL DEFAULT 0',
    'ALTER TABLE token_address_stat ADD COLUMN first_buy_time INTEGER',
    'ALTER TABLE token_address_stat ADD COLUMN staking_balance TEXT DEFAULT "0"',
    'ALTER TABLE token_market_cache ADD COLUMN liquidity_change_24h REAL DEFAULT 0',
    'ALTER TABLE token_market_cache ADD COLUMN liquidity_change_7d REAL DEFAULT 0',
    'ALTER TABLE alert_log ADD COLUMN level TEXT DEFAULT "MEDIUM"',
    'ALTER TABLE alert_log ADD COLUMN wallet_address TEXT',
    'ALTER TABLE alert_log ADD COLUMN amount_usd REAL',
    'ALTER TABLE alert_log ADD COLUMN handled INTEGER DEFAULT 0',
    'ALTER TABLE alert_log ADD COLUMN telegram_error TEXT',
    'ALTER TABLE alert_log ADD COLUMN retry_count INTEGER DEFAULT 0',
    'ALTER TABLE token_event ADD COLUMN balance_after TEXT',
    'ALTER TABLE token_address_stat ADD COLUMN last_sell_time INTEGER',
    'ALTER TABLE token_address_stat ADD COLUMN last_buy_time INTEGER',
    'ALTER TABLE holder_profiles ADD COLUMN address_type TEXT DEFAULT "wallet"',
    'ALTER TABLE holder_profiles ADD COLUMN last_buy_time INTEGER',
    'ALTER TABLE holder_profiles ADD COLUMN last_sell_time INTEGER',
    'ALTER TABLE sync_status ADD COLUMN lag_blocks INTEGER DEFAULT 0',
    'ALTER TABLE sync_status ADD COLUMN heartbeat_at INTEGER',
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch {
      /* column exists */
    }
  }
}
