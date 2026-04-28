// ═══════════════════════════════════════════════════════════════
//  ChatMix Path Discovery — descobre quais endpoints retornam JSON
//  Uso: node chatmix-discover.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const axios = require('axios');

const srv = 'https://srv6.chatmix.com.br';
const token = process.env.CHATMIX_TOKEN || '';
const phpsessid = process.env.CHATMIX_PHPSESSID || '';

if (!token || !phpsessid) {
  console.error('❌ Configure CHATMIX_TOKEN e CHATMIX_PHPSESSID no .env');
  process.exit(1);
}

const cookieStr = [
  `i18n_locale=pt-BR`,
  `_chat_auth=${token.startsWith('Bearer ') ? token : 'Bearer ' + token}`,
  `PHPSESSID=${phpsessid}`,
].join('; ');

const headers = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin':          srv,
  'Referer':         `${srv}/app/dash/home`,
  'Cookie':          cookieStr,
};

// Paths candidatos — prefixos × sufixos
const PREFIXES = ['/_api', '/crm/api/V1', '/api/v1', '/api', '/v1', '/v2', '/v3'];
const PATHS = [
  '/sum',
  '/dashboard',
  '/dashboard/sum',
  '/reports/sum',
  '/reports/dashboard',
  '/reports/dashboard/sum',
  '/reports/attendance',
  '/reports/attendances',
  '/attendees',
  '/agents',
  '/attendances',
  '/attendances/monthly',
  '/attendance/monthly',
  '/monthly',
  '/motivos',
  '/motives',
  '/reasons',
  '/closed',
  '/tickets/closed',
  '/chats/closed',
  '/waiting',
  '/queue',
  '/queues',
  '/tickets/waiting',
  '/incidents',
  '/stats',
  '/statistics',
  '/metrics',
  '/overview',
  '/summary',
  '/csat',
  '/nps',
  '/tma',
  '/tme',
  '/sectors',
  '/departments',
  '/contacts',
  '/tickets',
  '/chats',
  '/conversations',
];

async function probe(url) {
  try {
    const r = await axios.get(url, {
      headers,
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 8000,
    });
    const ct = r.headers['content-type'] || '';
    const isJson = ct.includes('json') || (typeof r.data === 'object' && r.data !== null);
    const preview = isJson
      ? JSON.stringify(r.data).slice(0, 120)
      : String(r.data).slice(0, 60).replace(/\n/g, ' ');
    return { status: r.status, isJson, preview };
  } catch (e) {
    return { status: 0, isJson: false, preview: e.message };
  }
}

async function run() {
  console.log('🔍 ChatMix Path Discovery\n');
  console.log(`   Cookie: _chat_auth + PHPSESSID presentes\n`);

  const hits = [];
  const total = PREFIXES.length * PATHS.length;
  let i = 0;

  for (const prefix of PREFIXES) {
    for (const path of PATHS) {
      const url = srv + prefix + path;
      const result = await probe(url);
      i++;
      process.stdout.write(`\r[${i}/${total}] ${prefix}${path}          `);

      if (result.isJson || (result.status >= 200 && result.status < 300 && result.status !== 200)) {
        hits.push({ url: prefix + path, ...result });
      }
      // pequena pausa para não sobrecarregar
      await new Promise(r => setTimeout(r, 120));
    }
  }

  console.log('\n\n═══════════════════════════════════════════');
  console.log('📋 RESULTADOS — paths que retornaram JSON:');
  console.log('═══════════════════════════════════════════\n');

  if (hits.length === 0) {
    console.log('❌ Nenhum path retornou JSON.');
    console.log('   Possíveis causas:');
    console.log('   1. Sessão expirada — atualize CHATMIX_TOKEN e CHATMIX_PHPSESSID no .env');
    console.log('   2. Os paths do /_api são diferentes dos padrões testados');
    console.log('\n💡 Próximo passo: abra o DevTools → Network, filtre por XHR/Fetch,');
    console.log('   navegue até o dashboard e copie o ":path" de qualquer requisição de dados.');
  } else {
    hits.forEach(h => {
      console.log(`✅ [${h.status}] ${h.url}`);
      console.log(`   ${h.preview}\n`);
    });
  }
}

run().catch(e => { console.error(e); process.exit(1); });
