// Função serverless temporária — lê NR certs direto do Neon (Vercel Postgres)
// Usada UMA VEZ para migrar dados para o Railway
const { Pool } = require('pg');

let _pool = null;
function getPool() {
  if (!_pool) {
    const connStr = process.env.DATABASE_URL
      || process.env.POSTGRES_URL
      || process.env.STORAGE_URL
      || process.env.POSTGRES_PRISMA_URL;
    if (!connStr) return null;
    _pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  }
  return _pool;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const pool = getPool();
    if (!pool) return res.status(200).json({ ok: false, motivo: 'Sem DATABASE_URL no Vercel' });
    const r = await pool.query("SELECT value FROM kv_store WHERE key='rh_nr_certs'");
    if (!r.rows[0]) return res.status(200).json({ ok: false, motivo: 'Chave rh_nr_certs não encontrada no banco' });
    const lista = JSON.parse(r.rows[0].value);
    res.status(200).json({ ok: true, total: lista.length, data: lista });
  } catch(e) {
    res.status(200).json({ ok: false, motivo: e.message });
  }
};
