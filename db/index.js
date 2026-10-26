const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (avoids timezone shifts)
types.setTypeParser(1082, v => v);

// SSL: on in production unless DATABASE_SSL=false. If the database says it
// doesn't support SSL (common on hosts' private networks), we switch it off automatically.
let useSSL = process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'false';

function makePool() {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  p.on('error', err => console.error('Unexpected DB client error:', err.message));
  return p;
}

let pool = makePool();

async function withSslFallback(fn) {
  try {
    return await fn();
  } catch (err) {
    if (useSSL && /does not support SSL/i.test(err.message)) {
      console.log('Database does not support SSL — reconnecting without SSL');
      useSSL = false;
      const old = pool; pool = makePool(); old.end().catch(() => {});
      return fn();
    }
    throw err;
  }
}

module.exports = {
  query:   (...args) => withSslFallback(() => pool.query(...args)),
  connect: ()        => withSslFallback(() => pool.connect()),
};
