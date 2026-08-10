#!/usr/bin/env node
'use strict';
/*
 * Ant Motors — Phase 2 backfill (dual-track migration)
 *
 * Copies every existing row from the local SQLite database into the Supabase
 * mirror project. Idempotent: it uses the SAME upsert + onConflict keys as
 * server/server.js `mirrorRow`, so re-running is safe and only fills gaps
 * (it never deletes rows in Supabase).
 *
 * Prerequisites:
 *   1. You already ran server/supabase-schema.sql in your Supabase project.
 *   2. Env vars set (same as the server):
 *        SUPABASE_URL
 *        SUPABASE_SERVICE_ROLE_KEY
 *      Optionally: DB=/path/to/antmotors.db  (defaults to the server's path)
 *
 * Usage:
 *   node backfill-to-supabase.js            # write everything
 *   node backfill-to-supabase.js --dry-run  # count rows only, no writes
 *
 * This is a ONE-OFF maintenance script. It does NOT start the HTTP server and
 * does NOT touch the live request path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// --- locate the same DB the server uses -------------------------------------
function defaultDbPath() {
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/antmotors.db';
    }
  } catch (e) { /* not writable — fall through */ }
  return path.join(__dirname, 'antmotors.db');
}
const DB_PATH = process.env.DB || defaultDbPath();

// --- mirror config, kept in sync with server/server.js ----------------------
const MIRROR_TABLES = ['companies', 'cars', 'employees', 'showrooms', 'orders'];
const MIRROR_CONFLICT = {
  companies: 'id',
  cars: 'id,company_id',
  employees: 'id,company_id',
  showrooms: 'id,company_id',
  orders: 'out_trade_no'
};

const DRY = process.argv.includes('--dry-run');

// --- Supabase client (only needed for the real WRITE pass) -------------------
// In --dry-run we never connect, so the script also works without the
// @supabase/supabase-js package or the env vars — handy as a pre-migration
// "how much data is there" peek.
let _sb = null;
if (!DRY) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    console.error('Export them, then re-run, e.g.:');
    console.error('  export SUPABASE_URL=https://xxxx.supabase.co');
    console.error('  export SUPABASE_SERVICE_ROLE_KEY=eyJ...');
    process.exit(1);
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
  } catch (e) {
    console.error('[backfill] Supabase client init failed:', e.message);
    console.error('Make sure @supabase/supabase-js is installed: npm i @supabase/supabase-js');
    process.exit(1);
  }
}

// --- open SQLite -------------------------------------------------------------
if (!fs.existsSync(DB_PATH)) {
  console.error('SQLite DB not found at:', DB_PATH);
  console.error('Set DB=/path/to/antmotors.db if it lives elsewhere.');
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);

// Mirror the exact cleaning server.js does (undefined -> null) so the row sent
// to Supabase is byte-identical to a live mirrorRow upsert.
function cleanRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = (row[k] === undefined) ? null : row[k];
  return out;
}

const BATCH = 200;

async function backfillTable(table) {
  const rows = db.prepare('SELECT * FROM ' + table).all();
  const total = rows.length;
  console.log(`\n[${table}] ${total} row(s) in SQLite`);

  if (DRY || total === 0) return total;

  let done = 0;
  for (let i = 0; i < total; i += BATCH) {
    const slice = rows.slice(i, i + BATCH).map(cleanRow);
    const { error } = await _sb.from(table).upsert(slice, {
      onConflict: MIRROR_CONFLICT[table] || 'id'
    });
    if (error) {
      console.error(`  batch ${Math.floor(i / BATCH) + 1} FAILED:`, error.message);
      process.exitCode = 1;
      return done;
    }
    done += slice.length;
    process.stdout.write(`  upserted ${done}/${total}\r`);
  }
  console.log(`  upserted ${done}/${total} ok`);
  return done;
}

(async () => {
  console.log('Ant Motors — Phase 2 backfill');
  console.log('DB  :', DB_PATH);
  console.log('Dest:', process.env.SUPABASE_URL);
  console.log(DRY ? 'MODE: DRY-RUN (no writes)\n' : 'MODE: WRITE\n');

  let grand = 0;
  for (const t of MIRROR_TABLES) {
    grand += await backfillTable(t);
  }
  console.log('\n=== done ===');
  if (DRY) console.log(`Dry-run complete — ${grand} row(s) would be written.`);
  else console.log(`Backfilled ${grand} row(s) total across ${MIRROR_TABLES.length} tables.`);
  process.exit(process.exitCode || 0);
})();
