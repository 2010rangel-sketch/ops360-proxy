// ═══════════════════════════════════════════════════════════════
//  ChatMix Discovery Round 2 — foco em /_api/ com mais variações
//  Uso: node chatmix-discover2.js
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
  'Authorization':   token.startsWith('Bearer ') ? token : `Bearer ${token}`,
};

// Foco total em /_api/ com paths que NÃO são rotas Vue.js
const CANDIDATES = [
  // Chats / conversas
  '/_api/chats',
  '/_api/chats/open',
  '/_api/chats/closed',
  '/_api/chats/waiting',
  '/_api/chats/count',
  '/_api/chats/summary',
  '/_api/chats/stats',
  '/_api/chats/report',
  '/_api/conversations',
  '/_api/conversations/count',
  '/_api/conversations/stats',
  '/_api/sessions',
  '/_api/sessions/stats',
  // Agentes / atendentes
  '/_api/agents',
  '/_api/agents/online',
  '/_api/agents/stats',
  '/_api/agents/report',
  '/_api/attendants',
  '/_api/attendant',
  '/_api/users',
  '/_api/users/stats',
  // Departamentos / setores
  '/_api/departments',
  '/_api/department',
  '/_api/sectors',
  '/_api/sector',
  '/_api/groups',
  '/_api/group',
  '/_api/teams',
  // Filas
  '/_api/queues',
  '/_api/queue',
  '/_api/queue/stats',
  '/_api/queues/stats',
  // Reports
  '/_api/reports',
  '/_api/report',
  '/_api/reports/agents',
  '/_api/reports/chats',
  '/_api/reports/departments',
  '/_api/reports/general',
  '/_api/reports/overview',
  '/_api/reports/csat',
  '/_api/reports/tma',
  // Dashboard
  '/_api/dashboard',
  '/_api/dashboard/overview',
  '/_api/dashboard/agents',
  '/_api/dashboard/chats',
  '/_api/overview',
  '/_api/overview/chats',
  // Tickets
  '/_api/tickets',
  '/_api/tickets/open',
  '/_api/tickets/closed',
  '/_api/tickets/count',
  // Contatos
  '/_api/contacts',
  '/_api/contact',
  // CSAT / NPS / feedback
  '/_api/csat',
  '/_api/nps',
  '/_api/ratings',
  '/_api/feedback',
  '/_api/survey',
  // Analytics
  '/_api/analytics',
  '/_api/analytics/chats',
  '/_api/metrics',
  '/_api/stats',
  '/_api/statistics',
  // Tags / motivos
  '/_api/tags',
  '/_api/labels',
  '/_api/reasons',
  '/_api/motives',
  '/_api/causes',
  // Bots / automações
  '/_api/bots',
  '/_api/bot',
  '/_api/flows',
  '/_api/automations',
  // Histórico / mensagens
  '/_api/messages',
  '/_api/messages/count',
  '/_api/history',
  // Misc
  '/_api/online',
  '/_api/status',
  '/_api/notifications',
  '/_api/config',
  '/_api/settings',
  '/_api/me',
  '/_api/account',
  '/_api/workspace',
];

// Também testa com parâmetros de data de hoje
const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2,'0');
const dd = String(today.getDate()).padStart(2,'0');
const dateParams = `?start=${yyyy}-${mm}-01&end=${yyyy}-${mm}-${dd}&date=${yyyy}-${mm}-${dd}&month=${yyyy}-${mm}`;

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
    const isHtml = String(r.data).slice(0,50).includes('<html') || String(r.data).slice(0,50).includes('<!DOCTYPE');
    const preview = isJson
      ? JSON.stringify(r.data).slice(0, 150)
      : String(r.data).slice(0, 80).replace(/\n/g, ' ');
    return { status: r.status, isJson, isHtml, preview };
  } catch (e) {
    return { status: 0, isJson: false, isHtml: false, preview: e.message };
  }
}

async function run() {
  console.log('🔍 ChatMix Discovery Round 2 — foco em /_api/\n');

  const hits200 = [];
  const hits404json = [];
  const total = CANDIDATES.length;
  let i = 0;

  for (const path of CANDIDATES) {
    const url = srv + path;
    const result = await probe(url);
    i++;
    process.stdout.write(`\r[${i}/${total}] ${path.padEnd(45)}`);

    if (result.isJson && result.status === 200) {
      hits200.push({ path, ...result });
    } else if (result.isJson && !result.isHtml) {
      hits404json.push({ path, status: result.status, preview: result.preview });
    }

    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('✅ 200 JSON — endpoints com dados reais:');
  console.log('═══════════════════════════════════════════════════════\n');

  if (hits200.length === 0) {
    console.log('  (nenhum)\n');
  } else {
    hits200.forEach(h => {
      console.log(`  ✅ ${h.path}`);
      console.log(`     ${h.preview}\n`);
    });
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('⚠️  Outros JSON (4xx) — paths reconhecidos pela API:');
  console.log('═══════════════════════════════════════════════════════\n');

  if (hits404json.length === 0) {
    console.log('  (nenhum)\n');
  } else {
    hits404json.forEach(h => {
      console.log(`  [${h.status}] ${h.path}`);
      console.log(`     ${h.preview.slice(0,100)}\n`);
    });
  }

  console.log('\n💡 Próximo passo:');
  if (hits200.length > 0) {
    console.log('   Use os paths acima no chatmix-agent.js');
  } else {
    console.log('   Abra o DevTools → Network → filtre XHR → copie o :path de qualquer requisição de dados do dashboard');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
