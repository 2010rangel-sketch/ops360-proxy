// ═══════════════════════════════════════════════════════════════
//  ChatMix Agent — roda localmente, coleta dados e envia ao Railway
//  Uso: node chatmix-agent.js
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

// ── Configurações ────────────────────────────────────────────────
const CONFIG = {
  chatmixUser:   process.env.CHATMIX_USER   || '',
  chatmixPass:   process.env.CHATMIX_PASS   || '',
  chatmixToken:  process.env.CHATMIX_TOKEN  || '', // Bearer 318038|...
  railwayUrl:    process.env.RAILWAY_URL    || 'https://lcfibra360.up.railway.app',
  agentSecret:   process.env.CHATMIX_AGENT_SECRET || 'chatmix-agent-2026',
  intervaloSeg:  parseInt(process.env.INTERVALO_SEG || '30'),
  chatmixSrv:    'https://srv6.chatmix.com.br',
};

let _token = CONFIG.chatmixToken;
let _cookieJar = {};

// ── Helpers HTTP ─────────────────────────────────────────────────
function req(method, urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const cookieStr = Object.entries(_cookieJar).map(([k,v])=>`${k}=${v}`).join('; ');

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36',
        'Origin': CONFIG.chatmixSrv,
        'Referer': CONFIG.chatmixSrv + '/app/dash/home',
        ...(cookieStr ? { 'Cookie': cookieStr } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...extraHeaders,
      },
    };

    const request = lib.request(opts, res => {
      // Captura cookies Set-Cookie
      const sc = res.headers['set-cookie'] || [];
      sc.forEach(c => {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) _cookieJar[m[1]] = m[2];
      });

      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.status || res.statusCode, data: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.status || res.statusCode, data: null, raw: data }); }
      });
    });
    request.on('error', reject);
    if (bodyStr) request.write(bodyStr);
    request.end();
  });
}

// ── Login ────────────────────────────────────────────────────────
async function login() {
  if (!CONFIG.chatmixUser || !CONFIG.chatmixPass) {
    // Usa token fixo se não tiver credenciais
    if (_token) {
      const bearer = _token.startsWith('Bearer ') ? _token : `Bearer ${_token}`;
      _cookieJar['_chat_auth'] = bearer;
      console.log('[Agent] Usando token fixo');
      return true;
    }
    return false;
  }

  const endpoints = [
    `${CONFIG.chatmixSrv}/crm/api/V1/auth/login`,
    `${CONFIG.chatmixSrv}/crm/api/V1/login`,
    `${CONFIG.chatmixSrv}/v3/api/auth/login`,
    `${CONFIG.chatmixSrv}/api/login`,
    `${CONFIG.chatmixSrv}/v3/login`,
  ];

  for (const url of endpoints) {
    try {
      const r = await req('POST', url, { email: CONFIG.chatmixUser, password: CONFIG.chatmixPass });
      const token = r.data?.token || r.data?.access_token || r.data?.data?.token || r.data?.auth_token;
      if (token) {
        _token = `Bearer ${token}`;
        _cookieJar['_chat_auth'] = _token;
        console.log('[Agent] Login OK via', url);
        return true;
      }
      if (_cookieJar['_chat_auth']) {
        _token = _cookieJar['_chat_auth'];
        console.log('[Agent] Login OK via cookie em', url);
        return true;
      }
    } catch(e) {
      // tenta próximo
    }
  }

  // Fallback: token fixo
  if (_token) {
    const bearer = _token.startsWith('Bearer ') ? _token : `Bearer ${_token}`;
    _cookieJar['_chat_auth'] = bearer;
    console.log('[Agent] Todos endpoints falharam, usando token fixo');
    return true;
  }
  return false;
}

// ── Coleta dados do ChatMix ──────────────────────────────────────
async function collect() {
  const base = `${CONFIG.chatmixSrv}/crm/api/V1`;
  const bearer = (_token||'').startsWith('Bearer ') ? _token : `Bearer ${_token}`;
  const authHeaders = { 'Authorization': bearer };

  const get = async (path) => {
    try {
      const r = await req('GET', base + path, null, authHeaders);
      if (r.status === 401 || r.status === 403) return null;
      return typeof r.data === 'object' && r.data !== null ? r.data : null;
    } catch { return null; }
  };

  const [monthly, sum, attendees, motivos, closed, waiting] = await Promise.all([
    get('/reports/dashboard/attendances/monthly'),
    get('/reports/dashboard/sum'),
    get('/reports/dashboard/attendees'),
    get('/reports/dashboard/motivos'),
    get('/reports/dashboard/closed'),
    get('/reports/dashboard/waiting'),
  ]);

  const allNull = [monthly, sum, attendees, motivos, closed, waiting].every(x => x === null);
  if (allNull) {
    console.log('[Agent] Todos os endpoints retornaram null — token expirado, tentando relogin...');
    await login();
    return null;
  }

  return { monthly, sum, attendees, motivos, closed, waiting };
}

// ── Envia para Railway ───────────────────────────────────────────
async function sendToRailway(data) {
  try {
    const r = await req('POST', `${CONFIG.railwayUrl}/api/chatmix/ingest`, data, {
      'x-agent-secret': CONFIG.agentSecret,
    });
    if (r.status === 200) {
      console.log('[Agent] Dados enviados ao Railway ✓', new Date().toLocaleTimeString('pt-BR'));
    } else {
      console.error('[Agent] Erro ao enviar:', r.status, r.raw?.slice(0,100));
    }
  } catch(e) {
    console.error('[Agent] Erro de rede ao enviar:', e.message);
  }
}

// ── Loop principal ───────────────────────────────────────────────
async function run() {
  console.log(`\n🤖 ChatMix Agent iniciado`);
  console.log(`   Servidor: ${CONFIG.chatmixSrv}`);
  console.log(`   Railway:  ${CONFIG.railwayUrl}`);
  console.log(`   Intervalo: ${CONFIG.intervaloSeg}s\n`);

  const ok = await login();
  if (!ok) {
    console.error('[Agent] ❌ Sem credenciais. Configure CHATMIX_USER/CHATMIX_PASS ou CHATMIX_TOKEN');
    process.exit(1);
  }

  const tick = async () => {
    const data = await collect();
    if (data) await sendToRailway(data);
  };

  await tick();
  setInterval(tick, CONFIG.intervaloSeg * 1000);
}

run().catch(e => { console.error(e); process.exit(1); });
