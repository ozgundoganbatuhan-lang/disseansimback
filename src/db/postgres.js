'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => console.error('PG pool error:', err));

// Helper: scoped query that always includes tenant_id
const q = (sql, params) => pool.query(sql, params);
const one = async (sql, params) => { const r = await pool.query(sql, params); return r.rows[0] || null; };
const many = async (sql, params) => { const r = await pool.query(sql, params); return r.rows; };

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅ Database migrated');
}

module.exports = { pool, q, one, many, migrate };
