// ═══════════════════════════════════════════════════════════════
//  OPS360 — Servidor Proxy Hubsoft
//  Hospede no Railway.app — funciona sem configuração extra
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');

const crypto = require('crypto');
const AUTH_SECRET = process.env.AUTH_SECRET || 'ops360-secret-2025';

// ── Auth helpers ──────────────────────────────────────────────────
function _hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + AUTH_SECRET).digest('hex');
}
function _gerarToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function _validarToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    const payload = `${userId}:${ts}`;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    // Token expira em 30 dias
    if (Date.now() - parseInt(ts) > 30 * 24 * 60 * 60 * 1000) return null;
    return parseInt(userId);
  } catch { return null; }
}
async function _getUser(id) {
  try {
    const pool = getPool(); if (!pool) return null;
    const r = await pool.query('SELECT * FROM ops360_users WHERE id=$1 AND ativo=TRUE', [id]);
    return r.rows[0] || null;
  } catch { return null; }
}

// ── Handlers globais: evita que erros async não capturados matem o processo ──
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

// ── Mapeamento definitivo: ID do usuário → Setor ──────────────────
// Fonte: planilha de usuários do Hubsoft (atualizar aqui se mudar)
const SETOR_POR_ID = {
  // Cobrança
  326:'Cobrança', 120:'Cobrança', 258:'Cobrança', 292:'Cobrança', 218:'Cobrança',
  325:'Cobrança', 127:'Cobrança', 129:'Cobrança', 261:'Cobrança', 194:'Cobrança', 286:'Cobrança',
  // Comercial
  123:'Comercial', 115:'Comercial',
  // Call Center
  282:'Call Center', 297:'Call Center', 283:'Call Center', 329:'Call Center',
  278:'Call Center', 321:'Call Center', 328:'Call Center', 299:'Call Center', 316:'Call Center',
  // Financeiro
  198:'Financeiro', 95:'Financeiro', 254:'Financeiro',
};
// Nome do usuário → Setor (fallback quando só temos o nome)
const SETOR_POR_NOME = {
  'Ana Beatriz':'Cobrança','Anna':'Cobrança','Anna Carla':'Cobrança','Evellem':'Cobrança',
  'Kiara':'Cobrança','Mileny':'Cobrança','Nayla':'Cobrança','Paula':'Cobrança',
  'Sara':'Cobrança','Talita':'Cobrança','Vanessa':'Cobrança',
  'Jamilly - COMERCIAL':'Comercial','Samara - COMERCIAL':'Comercial',
  'Clara':'Call Center','Cleiza':'Call Center','Eduarda Reis':'Call Center',
  'Graziela':'Call Center','Kamila':'Call Center','Liane':'Call Center',
  'Maiza':'Call Center','Mirian':'Call Center','Ana Carolina':'Call Center',
  'Ruth Oliveira':'Financeiro','Rakezia':'Financeiro','Isabel':'Financeiro',
};

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credenciais Hubsoft (Railway usa nomes PT, Vercel usa nomes EN — suporta ambos) ──
const HUBSOFT_HOST          = process.env.HUBSOFT_HOST          || 'https://api.lcvirtual.hubsoft.com.br';
const HUBSOFT_CLIENT_ID     = process.env.HUBSOFT_CLIENT_ID     || process.env.ID_DO_CLIENTE_HUBSOFT || '71';
const HUBSOFT_CLIENT_SECRET = process.env.HUBSOFT_CLIENT_SECRET || '';
const HUBSOFT_USERNAME      = process.env.HUBSOFT_USERNAME      || '2026rangel@gmail.com';
const HUBSOFT_PASSWORD      = process.env.HUBSOFT_PASSWORD      || process.env.SENHA_HUBSOFT || '';
const grant_type            = process.env.grant_type            || process.env.tipo_de_concessão || 'password';

// ── Apple iCloud CalDAV ───────────────────────────────────────────
const APPLE_ID           = process.env.APPLE_ID           || process.env.ID_MAÇÃ           || '';
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD || process.env.SENHA_DO_APP_APP  || '';
let caldavCache = null; // { auth, baseUrl, calPath } — descoberto na 1ª chamada

function icsDateTime(d) {
  return d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
}

function buildICS(ev) {
  const uid = `ops360-${Date.now()}-${Math.random().toString(36).slice(2)}@ops360`;
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0',
    'PRODID:-//OPS360//Dashboard//PT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDateTime(new Date())}`,
    `DTSTART:${icsDateTime(new Date(ev.inicio))}`,
    `DTEND:${icsDateTime(new Date(ev.fim || new Date(new Date(ev.inicio).getTime()+3600000)))}`,
    `SUMMARY:${(ev.titulo||'Evento OPS360').replace(/[\\;,]/g,'\\$&').replace(/\n/g,'\\n')}`,
    ev.descricao ? `DESCRIPTION:${ev.descricao.replace(/[\\;,]/g,'\\$&').replace(/\n/g,'\\n')}` : null,
    ev.local     ? `LOCATION:${ev.local.replace(/[\\;,]/g,'\\$&')}` : null,
    'END:VEVENT','END:VCALENDAR',
  ].filter(Boolean);
  return { ics: lines.join('\r\n'), uid };
}

function parseICS(icsText) {
  const events = [];
  const vevents = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const getP = (block, prop) => {
    const m = block.match(new RegExp(`(?:^|\\r\\n)${prop}[^:]*:([^\\r\\n]+)(?:\\r\\n[ \\t]([^\\r\\n]+))*`, 'm'));
    return m ? m[1].trim() : null;
  };
  const parseIcsDate = (s) => {
    if (!s) return null;
    // strip TZID prefix if present (e.g. "TZID=America/Sao_Paulo:20260325T100000")
    const raw = s.includes(':') ? s.split(':').pop() : s;
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
    if (!m) return null;
    if (!m[4]) return new Date(+m[1], +m[2]-1, +m[3]).toISOString();
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]?'Z':''}`;
    return new Date(iso).toISOString();
  };
  for (const ve of vevents) {
    const uid   = getP(ve, 'UID');
    const dtStart = ve.match(/DTSTART[^\r\n]*/)?.[0]?.split(':').pop()?.trim();
    const dtEnd   = ve.match(/DTEND[^\r\n]*/)?.[0]?.split(':').pop()?.trim();
    if (!uid || !dtStart) continue;
    events.push({
      uid,
      titulo:    (getP(ve,'SUMMARY')  ||'Sem título').replace(/\\n/g,'\n').replace(/\\,/g,','),
      inicio:    parseIcsDate(dtStart),
      fim:       parseIcsDate(dtEnd),
      descricao: (getP(ve,'DESCRIPTION')||'').replace(/\\n/g,'\n'),
      local:     getP(ve,'LOCATION') || '',
    });
  }
  return events;
}

async function getCaldavInfo() {
  if (caldavCache) return caldavCache;
  if (!APPLE_ID || !APPLE_APP_PASSWORD) throw new Error('nao_configurado');

  const auth = `Basic ${Buffer.from(`${APPLE_ID}:${APPLE_APP_PASSWORD}`).toString('base64')}`;
  const UA   = 'OPS360/1.0 (Node.js; CalDAV Client)';
  const hdr  = (extra={}) => ({ Authorization:auth, 'Content-Type':'application/xml; charset=utf-8', 'User-Agent':UA, ...extra });

  // 1. Descobre principal URL — tenta também via /.well-known/caldav
  let r1 = await axios({
    method:'PROPFIND', url:'https://caldav.icloud.com/',
    data:'<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
    headers: hdr({ Depth:'0' }), validateStatus:()=>true, maxRedirects:5,
  });
  // Se 401 ou sem href, tenta com o Apple ID embutido na URL
  if (r1.status === 401 || r1.status === 403) {
    throw new Error(`CalDAV autenticação recusada (${r1.status}) — verifique APPLE_ID e APPLE_APP_PASSWORD`);
  }
  let hrefs1 = [...(r1.data||'').matchAll(/<(?:\w+:)?href>(\/[^<]+)<\/(?:\w+:)?href>/g)].map(m=>m[1]);
  let principal = hrefs1.find(u => u.length > 2 && u !== '/');
  // Se não encontrou, tenta well-known
  if (!principal) {
    const rWK = await axios({
      method:'PROPFIND', url:'https://caldav.icloud.com/.well-known/caldav',
      data:'<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
      headers: hdr({ Depth:'0' }), validateStatus:()=>true, maxRedirects:10,
    });
    hrefs1 = [...(rWK.data||'').matchAll(/<(?:\w+:)?href>(\/[^<]+)<\/(?:\w+:)?href>/g)].map(m=>m[1]);
    principal = hrefs1.find(u => u.length > 2 && u !== '/');
  }
  if (!principal) throw new Error(`Principal não encontrado (status ${r1.status}) body: ${String(r1.data).slice(0,300)}`);

  // 2. Calendar-home-set
  const r2 = await axios({
    method:'PROPFIND', url:`https://caldav.icloud.com${principal}`,
    data:'<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
    headers: hdr({ Depth:'0' }), validateStatus:()=>true,
  });
  const homeM = r2.data.match(/calendar-home-set[\s\S]{0,400}?<(?:\w+:)?href>(\/[^<]+\/)<\/(?:\w+:)?href>/);
  if (!homeM) throw new Error('calendar-home-set não encontrado');
  const homePath = homeM[1];

  // 3. Lista calendários → encontra o 1º que suporte VEVENT
  const r3 = await axios({
    method:'PROPFIND', url:`https://caldav.icloud.com${homePath}`,
    data:'<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>',
    headers: hdr({ Depth:'1' }), validateStatus:()=>true,
  });
  const resps = (r3.data||'').split(/<(?:\w+:)?response>/).slice(1);
  let calPath = null;
  for (const resp of resps) {
    const hm = resp.match(/<(?:\w+:)?href>(\/[^<]+\/)<\/(?:\w+:)?href>/);
    if (!hm || hm[1] === homePath) continue;
    if (resp.includes('VEVENT') || resp.includes('calendar')) { calPath = hm[1]; break; }
  }
  if (!calPath && resps.length > 1) {
    const hm = resps[1].match(/<(?:\w+:)?href>(\/[^<]+\/)<\/(?:\w+:)?href>/);
    if (hm) calPath = hm[1];
  }
  if (!calPath) throw new Error('Nenhum calendário encontrado');

  caldavCache = { auth, baseUrl:'https://caldav.icloud.com', calPath };
  console.log(`[CalDAV] Calendário descoberto: ${calPath}`);
  return caldavCache;
}

// ── Token em memória (renovado automaticamente) ──────────────────
let tokenCache = { access_token: null, expires_at: 0 };

async function getToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at - 60000) {
    return tokenCache.access_token;
  }

  try {
    const res = await axios.post(`${HUBSOFT_HOST}/oauth/token`, {
      grant_type:    'password',
      client_id:     HUBSOFT_CLIENT_ID,
      client_secret: HUBSOFT_CLIENT_SECRET,
      username:      HUBSOFT_USERNAME,
      password:      HUBSOFT_PASSWORD,
    }, { headers: { 'Content-Type': 'application/json' } });

    tokenCache = {
      access_token: res.data.access_token,
      expires_at:   Date.now() + (res.data.expires_in * 1000),
    };
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Token renovado com sucesso`);
    return tokenCache.access_token;
  } catch (err) {
    console.error('Erro ao obter token:', err.response?.data || err.message);
    throw new Error('Falha na autenticação com o Hubsoft');
  }
}

// ── Helper GET ────────────────────────────────────────────────────
async function hubsoftGet(endpoint, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${HUBSOFT_HOST}/api/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return res.data;
}

// ── Helper POST (endpoint real de consulta do Hubsoft) ────────────
async function hubsoftPost(endpoint, body = {}) {
  const token = await getToken();
  const res = await axios.post(`${HUBSOFT_HOST}/api/${endpoint}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ── Monta body padrão para consultar OS ──────────────────────────
function bodyConsultaOS({ data_inicio, data_fim, tecnicos = [], cidades = [], status = ['pendente','aguardando_agendamento','em_andamento','em_execucao','finalizado','cancelado','reagendado','retrabalho'] } = {}) {
  const agora = new Date();
  // Padrão: 7 dias atrás até 3 dias à frente (igual ao painel web)
  const ini = data_inicio ? new Date(data_inicio) : new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fim = data_fim    ? new Date(data_fim)    : new Date(agora.getTime() + 3 * 24 * 60 * 60 * 1000);
  return {
    data_inicio:              ini.toISOString(),
    data_fim:                 fim.toISOString(),
    agendas:                  [],
    assinatura_cliente:       null,
    bairros:                  null,
    cidades:                  cidades,
    condominios:              null,
    grupos_clientes:          [],
    grupos_clientes_servicos: [],
    motivo_fechamento:        [],
    order_by:                 'data_inicio_programado',
    order_by_key:             'DESC',
    participantes:            [],
    periodos:                 [],
    pop:                      [],
    prioridade:               [],
    reservada:                null,
    servico:                  [],
    servico_status:           [],
    status_ordem_servico:     status,
    tecnicos:                 tecnicos,
  };
}

// ── Extrai lista de OS da resposta do Hubsoft ─────────────────────
function extrairLista(data) {
  if (Array.isArray(data.ordens_servico?.data)) return data.ordens_servico.data;
  if (Array.isArray(data.ordens_servico))       return data.ordens_servico;
  if (Array.isArray(data.ordem_servico?.data))  return data.ordem_servico.data;
  if (Array.isArray(data.ordem_servico))        return data.ordem_servico;
  if (Array.isArray(data.data))                 return data.data;
  return [];
}

// Extrai metadados de paginação (last_page / total)
function extrairPaginacao(data) {
  const pag = data.ordens_servico || data.ordem_servico || data;
  return {
    lastPage:   pag.last_page  || null,
    total:      pag.total      || null,
    perPage:    pag.per_page   || null,
  };
}

// ── CORS: permite acesso do dashboard em qualquer origem ─────────
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ── Serve o dashboard (arquivo HTML) ────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
//  ROTAS DA API PROXY
// ════════════════════════════════════════════════════════════════

// Testar conexão
app.get('/api/status', async (req, res) => {
  try {
    await getToken();
    res.json({ ok: true, host: HUBSOFT_HOST, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Diagnóstico: testa quais endpoints o Hubsoft aceita
app.get('/api/diagnostico', async (req, res) => {
  const token = await getToken();
  const candidatos = [
    // cidades
    'v1/cidade', 'v1/cidades', 'v1/municipio', 'v1/municipios',
    'v1/endereco', 'v1/enderecos', 'v1/logradouro', 'v1/uf',
    'v1/estado', 'v1/estados', 'v1/cep', 'v1/regiao', 'v1/regioes',
    // tipos de OS
    'v1/tipo_servico', 'v1/tipos_servico', 'v1/tipo_os',
    'v1/tipo_ordem_servico', 'v1/tipos_ordem_servico',
    'v1/tipo_atendimento', 'v1/grupo_servico', 'v1/grupo',
    'v1/categoria_servico', 'v1/categoria_os', 'v1/assunto',
    'v1/motivo', 'v1/motivos', 'v1/item', 'v1/itens',
    // outros que podem ter cidades/tipos embutidos
    'v1/contrato', 'v1/plano', 'v1/planos',
  ];
  const resultados = {};
  for (const ep of candidatos) {
    try {
      const r = await axios.get(`${HUBSOFT_HOST}/api/${ep}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 1 },
        timeout: 5000,
      });
      resultados[ep] = { status: r.status, ok: true };
    } catch (e) {
      resultados[ep] = { status: e.response?.status || 'erro', ok: false };
    }
  }
  res.json({ host: HUBSOFT_HOST, resultados });
});

// Debug: força novo token e testa lista de OS
app.get('/api/debug-os', async (req, res) => {
  try {
    // Força renovação do token (ignora cache)
    tokenCache = { access_token: null, expires_at: 0 };
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    const resultados = { token_renovado: true };

    const agora = new Date();
    const set7diasAtras = new Date(agora); set7diasAtras.setDate(set7diasAtras.getDate() - 7);
    const set2diasFrente = new Date(agora); set2diasFrente.setDate(set2diasFrente.getDate() + 2);

    const bodyExato = {
      data_inicio: set7diasAtras.toISOString(),
      data_fim:    set2diasFrente.toISOString(),
      agendas: [], assinatura_cliente: null, bairros: null,
      cidades: [], condominios: null, grupos_clientes: [],
      grupos_clientes_servicos: [], motivo_fechamento: [],
      order_by: 'data_inicio_programado', order_by_key: 'DESC',
      participantes: [], periodos: [], pop: [], prioridade: [],
      reservada: null, servico: [], servico_status: [],
      status_ordem_servico: ['pendente', 'aguardando_agendamento'],
      tecnicos: [],
    };

    const bodySemStatus = { ...bodyExato, status_ordem_servico: [] };
    const bodyTodosStatus = { ...bodyExato, status_ordem_servico: ['pendente','aguardando_agendamento','em_andamento','finalizado','cancelado','reagendado'] };

    for (const [label, body] of [['status_pendente', bodyExato], ['status_vazio', bodySemStatus], ['todos_status', bodyTodosStatus]]) {
      try {
        const r = await axios.post(`${HUBSOFT_HOST}/api/v1/ordem_servico/consultar/paginado/10?page=1`, body, { headers, timeout: 10000 });
        resultados[label] = { keys: Object.keys(r.data), total: r.data.ordem_servico?.length ?? r.data.data?.length ?? 'sem_array', amostra: r.data };
      } catch(e) { resultados[label] = { erro: e.response?.status, body: e.response?.data }; }
    }

    res.json(resultados);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Debug: lista todos os tipos de OS e cidades únicos retornados pela API
app.get('/api/debug-tipos-cidades', async (req, res) => {
  try {
    // Busca mais OS para cobrir mais tipos/cidades — 14 dias
    const agora = new Date();
    const body = bodyConsultaOS({
      data_inicio: new Date(agora.getTime() - 14*24*60*60*1000).toISOString(),
      data_fim:    new Date(agora.getTime() + 7*24*60*60*1000).toISOString(),
    });
    const data = await hubsoftPost('v1/ordem_servico/consultar/paginado/500?page=1', body);
    const lista = extrairLista(data);
    const tipos = {}, cidades = {};
    lista.forEach(os => {
      const tipo   = os.tipo_ordem_servico?.descricao || os.tipo_os?.nome || '?';
      const id_tipo = os.tipo_ordem_servico?.id_tipo_ordem_servico || '?';
      const end    = os.atendimento?.cliente_servico?.endereco_instalacao;
      const cidade = end?.endereco_numero?.cidade?.nome || end?.cidade?.nome || null;
      tipos[tipo]   = (tipos[tipo]   || 0) + 1;
      if (cidade) cidades[cidade] = (cidades[cidade] || 0) + 1;
    });
    res.json({
      total_os: lista.length,
      tipos_os: Object.entries(tipos).sort((a,b)=>b[1]-a[1]).map(([nome,qtd])=>({nome, qtd, cat: normalizarTipo(nome)})),
      cidades:  Object.entries(cidades).sort((a,b)=>b[1]-a[1]).map(([nome,qtd])=>({nome,qtd})),
      os_sem_cidade: lista.filter(os => {
        const end = os.atendimento?.cliente_servico?.endereco_instalacao;
        return !end?.endereco_numero?.cidade?.nome && !end?.cidade?.nome;
      }).length,
    });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// Debug temporário: mostra estrutura bruta do primeiro OS
app.get('/api/debug-raw', async (req, res) => {
  try {
    const data = await hubsoftPost('v1/ordem_servico/consultar/paginado/3?page=1', bodyConsultaOS());
    const lista = extrairLista(data);
    if (!lista.length) return res.json({ ok: false, msg: 'nenhum OS retornado' });
    const os = lista[0];
    // Extrai caminhos que possam ter cidade
    res.json({
      id_ordem_servico: os.id_ordem_servico,
      status_raw:               os.status,
      status_ordem_servico_raw: os.status_ordem_servico,
      situacao_raw:             os.situacao,
      st_normalizado: normalizarStatus(os.status_ordem_servico?.descricao || os.status_ordem_servico || os.status || os.situacao || ''),
      atendimento_keys: os.atendimento ? Object.keys(os.atendimento) : null,
      cliente_servico_keys: os.atendimento?.cliente_servico ? Object.keys(os.atendimento.cliente_servico) : null,
      endereco_instalacao: os.atendimento?.cliente_servico?.endereco_instalacao || null,
      cliente: os.atendimento?.cliente_servico?.cliente || null,
      raw_top_keys: Object.keys(os),
      raw_os: os,
    });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Debug: campos de atendimento de retenção ─────────────────────
app.get('/api/debug-retencao', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const agora = new Date();
    const ini = data_inicio || new Date(agora.getFullYear(), agora.getMonth()-1, 1).toISOString().slice(0,10);
    const fim = data_fim    || new Date(agora.getFullYear(), agora.getMonth(), 0).toISOString().slice(0,10);
    const first = await hubsoftPost('v1/atendimento/consultar/paginado/500?page=1', { data_inicio: ini, data_fim: fim, relacoes: 'origem_contato' });
    const totalPages = first?.atendimentos?.last_page || first?.atendimento?.last_page || first?.last_page || 1;
    let lista = first?.atendimentos?.data || first?.atendimento?.data || first?.data || [];
    // Busca todas as páginas
    if (totalPages > 1) {
      const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const results = await Promise.all(pages.map(async pg => {
        try {
          const d = await hubsoftPost(`v1/atendimento/consultar/paginado/500?page=${pg}`, { data_inicio: ini, data_fim: fim });
          return d?.atendimentos?.data || d?.atendimento?.data || d?.data || [];
        } catch { return []; }
      }));
      results.forEach(r => lista.push(...r));
    }
    const norm = s => (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const solicitacoes = lista.filter(a => {
      const u = norm(a.tipo_atendimento?.descricao || '');
      return u.includes('SOLICIT') && u.includes('CANCELAMENTO');
    });
    // Agrupa por combinação de status_fechamento + id_motivo para mapear desfechos
    const combinacoes = {};
    for (const a of solicitacoes) {
      const key = `sf=${a.status_fechamento}|sp=${a.status?.prefixo}|motivo=${a.id_motivo_fechamento_atendimento}`;
      if (!combinacoes[key]) combinacoes[key] = { count: 0, exemplo_descricao: a.descricao_fechamento };
      combinacoes[key].count++;
    }
    res.json({
      ok: true,
      total_paginas: totalPages,
      total_todos: lista.length,
      total_solicitacoes: solicitacoes.length,
      combinacoes_desfecho: combinacoes,
      amostra_ingresado: solicitacoes.slice(0, 10).map(a => ({
        ingresado: a.ingresado,
        destino_atendimento: a.destino_atendimento,
        descricao_abertura_inicio: (a.descricao_abertura || '').slice(0, 60),
      })),
    });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// ── Debug: campos de serviço do cliente ──────────────────────────
app.get('/api/debug-servico-campos', async (req, res) => {
  try {
    if (!_comAllClientes || !_comAllClientes.length) {
      return res.json({ ok: false, msg: 'Cache vazio — acesse /api/comercial primeiro' });
    }
    // Acha um cliente com pelo menos 1 serviço
    const cli = _comAllClientes.find(c => c.servicos && c.servicos.length);
    if (!cli) return res.json({ ok: false, msg: 'Nenhum cliente com serviços encontrado' });
    const s = cli.servicos[0];
    res.json({
      cliente_keys: Object.keys(cli).filter(k => k !== 'servicos'),
      servico_keys: Object.keys(s),
      data_venda:        s.data_venda,
      data_habilitacao:  s.data_habilitacao,
      data_cadastro_cli: cli.data_cadastro,
      data_cancelamento: s.data_cancelamento,
      status_prefixo:    s.status_prefixo,
      sample_servico:    s,
    });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Cache de Chamados (em memória + DB) ──────────────────────────
const _chamadosCache = new Map(); // key → { data, ts }
const CHAMADOS_HOJE_TTL   = 20 * 1000;   // 20s para "hoje" (ao vivo)
const CHAMADOS_HIST_TTL   = 5 * 60 * 1000; // 5min para períodos históricos
let   _chamadosRefreshing = false;

// Extrai a lista de OS da resposta do Hubsoft e normaliza
async function _fetchChamadosHubsoft(data_inicio, data_fim, all) {
  let lista = [];
  if (all) {
    const PAGE_SIZE = 500; const MAX_PAGES = 50;
    const body1 = bodyConsultaOS({ data_inicio, data_fim });
    const data1 = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=1`, body1);
    const page1Lista = extrairLista(data1);
    lista.push(...page1Lista);
    const { lastPage, total, perPage } = extrairPaginacao(data1);
    let totalPages = lastPage || (total && perPage ? Math.ceil(total / perPage) : null);
    const knowsTotal = !!totalPages;
    if (!totalPages) totalPages = page1Lista.length >= PAGE_SIZE ? MAX_PAGES : 1;
    totalPages = Math.min(totalPages, MAX_PAGES);
    if (totalPages > 1) {
      if (knowsTotal) {
        const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const results = await Promise.all(pages.map(async pg => {
          const d = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, bodyConsultaOS({ data_inicio, data_fim }));
          return extrairLista(d);
        }));
        for (const r of results) lista.push(...r);
      } else {
        let pg = 2;
        while (pg <= MAX_PAGES) {
          const d = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, bodyConsultaOS({ data_inicio, data_fim }));
          const r = extrairLista(d);
          lista.push(...r);
          if (r.length < PAGE_SIZE) break;
          pg++;
        }
      }
    }
  } else {
    const body = bodyConsultaOS({ data_inicio, data_fim, limit: 200, page: 1 });
    lista = extrairLista(await hubsoftPost(`v1/ordem_servico/consultar/paginado/200?page=1`, body));
  }
  return lista;
}

function _normalizarChamados(lista) {
  return lista.map(os => {
    const tipo  = os.tipo_ordem_servico?.descricao || os.tipo_os?.nome || 'Sem tipo';
    const tecs  = os.tecnicos || [];
    const tec   = tecs.map(t => t.name || t.nome || t.display).filter(Boolean).join(', ') || 'Sem técnico';
    const cs    = os.atendimento?.cliente_servico;
    const end   = cs?.endereco_instalacao;
    const coords = end?.endereco_numero?.coordenadas?.coordinates || end?.coordenadas?.coordinates;
    const cidade = end?.endereco_numero?.cidade?.nome || end?.cidade?.nome || end?.cidade?.display || cs?.cliente?.cidade?.nome || 'Sem cidade';
    const cidId  = end?.endereco_numero?.id_cidade || end?.id_cidade || end?.cidade?.id_cidade || null;
    const cli    = cs?.display || cs?.cliente?.nome_razaosocial || cs?.cliente?.display || 'Cliente';
    const stBase = normalizarStatus(os.status || '');
    const execAtiva = stBase === 'aguardando' && (os.executando === true || (Array.isArray(os.reservas) && os.reservas.some(r => r.servico_iniciado && !r.desreservada)));
    const stVal = execAtiva ? 'em_execucao' : (os.status || '');
    return {
      id: `#${os.id_ordem_servico || os.id}`, cli,
      cat: normalizarTipo(tipo), tipo, tec, cidade, cidadeId: cidId,
      ab: (os.hora_inicio_programado || '').slice(0, 5) || formatarHora(os.data_inicio_programado || os.data_cadastro),
      dataProgramada: os.data_inicio_programado || os.data_cadastro || null,
      slaMin: os.tipo_ordem_servico?.prazo_execucao || 240,
      inicioExec: (os.hora_inicio_executado || '').slice(0, 5) || null,
      fimExec:    (os.hora_termino_executado || '').slice(0, 5) || null,
      tsInicioExec: os.data_inicio_executado || null,
      tsFimExec:    os.data_termino_executado || null,
      st: normalizarStatus(stVal), rtb: tipo.toLowerCase().includes('retrabalho'),
      rtbOrig: os.id_ordem_servico_origem ? `#${os.id_ordem_servico_origem}` : null,
      rtbMotivo: os.descricao_retrabalho || null,
      reagMotivo: normalizarStatus(stVal) === 'reagendado' ? (os.motivo_reagendamento || 'Reagendado') : null,
      lat: coords ? parseFloat(coords[1]) || null : null,
      lng: coords ? parseFloat(coords[0]) || null : null,
      motivoFech: (() => { const mf = os.motivo_fechamento; if (!mf) return ''; if (typeof mf === 'string') return mf; if (Array.isArray(mf)) return mf.map(m => m?.descricao || m?.nome || '').filter(Boolean).join(', '); return mf?.descricao || mf?.nome || ''; })(),
      raw: os,
    };
  });
}

// Refresh proativo do cache "hoje" — chamado pelo cron a cada 15s
async function _refreshChamadosHoje() {
  if (_chamadosRefreshing) return;
  _chamadosRefreshing = true;
  try {
    const hoje  = new Date().toISOString().slice(0, 10);
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const lista = await _fetchChamadosHubsoft(hoje, amanha, true);
    const chamados = _normalizarChamados(lista);
    const result = { ok: true, total: chamados.length, chamados, sincronizado_em: new Date().toISOString() };
    _chamadosCache.set('hoje', { data: result, ts: Date.now() });
    dbCacheSet('cache:chamados:hoje', result); // persiste no banco
    console.log(`[chamados] cache atualizado: ${chamados.length} OS`);
  } catch(e) { console.warn('[chamados] refresh falhou:', e.message); }
  _chamadosRefreshing = false;
}

// ── Ordens de Serviço (Chamados) ─────────────────────────────────
app.get('/api/chamados', async (req, res) => {
  try {
    const { data_inicio, data_fim, limit = 200, page = 1, all } = req.query;

    // Determina chave de cache
    const hoje  = new Date().toISOString().slice(0, 10);
    const isHoje = !data_inicio || data_inicio.slice(0, 10) === hoje;
    const cacheKey = isHoje && all === 'true' ? 'hoje'
      : `${(data_inicio||'').slice(0,10)}-${(data_fim||'').slice(0,10)}-${all||'false'}`;
    const ttl = isHoje ? CHAMADOS_HOJE_TTL : CHAMADOS_HIST_TTL;

    // 1) Cache em memória
    const mem = _chamadosCache.get(cacheKey);
    if (mem && (Date.now() - mem.ts) < ttl) {
      return res.json({ ...mem.data, cache: 'mem' });
    }
    // 2) Cache no PostgreSQL (sobrevive redeploy)
    const dbC = await dbCacheGet(`cache:chamados:${cacheKey}`, ttl);
    if (dbC) {
      _chamadosCache.set(cacheKey, { data: dbC, ts: Date.now() });
      return res.json({ ...dbC, cache: 'db' });
    }

    // 3) Busca no Hubsoft
    const lista    = await _fetchChamadosHubsoft(data_inicio, data_fim, all === 'true');
    const chamados = _normalizarChamados(lista);
    const result   = { ok: true, total: chamados.length, chamados, sincronizado_em: new Date().toISOString() };
    _chamadosCache.set(cacheKey, { data: result, ts: Date.now() });
    dbCacheSet(`cache:chamados:${cacheKey}`, result);

    res.json(result);
  } catch (err) {
    console.error('Erro /api/chamados:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Técnicos ──────────────────────────────────────────────────────
app.get('/api/tecnicos', async (req, res) => {
  try {
    const data = await hubsoftGet('v1/funcionario', { limit: 200 });
    const tecnicos = (data.data || data.items || data || []).map(t => ({
      id:   t.id,
      nome: t.nome || t.nome_completo || t.name || 'Sem nome',
    }));
    res.json({ ok: true, tecnicos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Cidades — extraídas das OS do dia ────────────────────────────
app.get('/api/cidades', async (req, res) => {
  try {
    const data = await hubsoftPost('v1/ordem_servico/consultar/paginado/500?page=1', bodyConsultaOS());
    const todos = extrairLista(data);
    const mapaC = {};
    todos.forEach(os => {
      const end  = os.atendimento?.cliente_servico?.endereco_instalacao;
      const nome = end?.endereco_numero?.cidade?.nome || end?.cidade?.nome || end?.cidade?.display;
      const id   = end?.endereco_numero?.id_cidade    || end?.id_cidade    || end?.cidade?.id_cidade;
      if (nome && id && !mapaC[id]) mapaC[id] = { id, nome };
    });
    res.json({ ok: true, cidades: Object.values(mapaC).sort((a,b) => a.nome.localeCompare(b.nome)) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Tipos de OS — extraídos das OS do dia ────────────────────────
app.get('/api/tipos-os', async (req, res) => {
  try {
    const data = await hubsoftPost('v1/ordem_servico/consultar/paginado/500?page=1', bodyConsultaOS());
    const todos = extrairLista(data);
    const mapaT = {};
    todos.forEach(os => {
      const nome = os.tipo_ordem_servico?.descricao;
      const id   = os.tipo_ordem_servico?.id_tipo_ordem_servico;
      if (nome && id && !mapaT[id]) mapaT[id] = { id, nome, cat: normalizarTipo(nome) };
    });
    res.json({ ok: true, tipos: Object.values(mapaT).sort((a,b) => a.nome.localeCompare(b.nome)) });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Cache Atendimentos ────────────────────────────────────────────
const _atendCacheMap = {};
const ATEND_CACHE_TTL = 5 * 60 * 1000; // 5 min

// ── Atendimentos — por período, agrupado por atendente/setor/tipo ─
app.get('/api/atendimentos', async (req, res) => {
  try {
    const { data_inicio, data_fim, all } = req.query;
    const agora = new Date();

    // Período selecionado — sempre ancora em BRT (UTC-3)
    // Aceita tanto 'YYYY-MM-DD' quanto ISO completo; usa só a parte da data
    const BRT = 3 * 3600 * 1000; // UTC-3 → midnight BRT = 03:00 UTC
    const iniStr = (data_inicio || '').slice(0, 10) ||
      (() => { const d = new Date(agora.getTime() - BRT); return d.toISOString().slice(0,10); })();
    const fimStr = (data_fim || '').slice(0, 10) || iniStr;
    const ini = new Date(iniStr + 'T03:00:00.000Z'); // 00:00 BRT
    const fim = new Date(fimStr + 'T03:00:00.000Z'); // 00:00 BRT do dia fim
    fim.setTime(fim.getTime() + 24 * 3600 * 1000);   // até 23:59:59 BRT (= próxima meia-noite)

    // Cache key
    const atendKey = `${iniStr}-${fimStr}-${all||'false'}`;
    const atendMem = _atendCacheMap[atendKey];
    if (atendMem && (Date.now() - atendMem.ts) < ATEND_CACHE_TTL) return res.json({ ...atendMem.data, cache: 'mem' });
    const atendDb = await dbCacheGet(`cache:atendimentos:${atendKey}`, ATEND_CACHE_TTL);
    if (atendDb) { _atendCacheMap[atendKey] = { data: atendDb, ts: Date.now() }; return res.json({ ...atendDb, cache: 'db' }); }

    // Período fixo 7 dias para recorrência (usado em fetchAtendPages abaixo)

    // Helper: fetch all pages in parallel for atendimentos
    async function fetchAtendPages(iniDate, fimDate, forceAll = false) {
      const PAGE_SIZE = 500;
      const MAX_PAGES = 100;
      const body1 = { data_inicio: iniDate.toISOString(), data_fim: fimDate.toISOString() };
      const d1 = await hubsoftPost(`v1/atendimento/consultar/paginado/${PAGE_SIZE}?page=1`, body1);
      const list1 = Array.isArray(d1?.atendimentos?.data) ? d1.atendimentos.data : [];
      if (!forceAll) return list1;
      const lastPage = d1?.atendimentos?.last_page || null;
      const total    = d1?.atendimentos?.total || null;
      const perPage  = d1?.atendimentos?.per_page || PAGE_SIZE;
      let totalPages = lastPage || (total ? Math.ceil(total / perPage) : null) || (list1.length >= PAGE_SIZE ? MAX_PAGES : 1);
      totalPages = Math.min(totalPages, MAX_PAGES);
      console.log(`[atendimentos] page 1: ${list1.length} | totalPages=${totalPages} | total=${total}`);
      if (totalPages <= 1) return list1;
      // Todas as páginas restantes em paralelo
      const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const results = await Promise.all(pages.map(async pg => {
        const d = await hubsoftPost(`v1/atendimento/consultar/paginado/${PAGE_SIZE}?page=${pg}`, body1);
        return Array.isArray(d?.atendimentos?.data) ? d.atendimentos.data : [];
      }));
      const all_list = [...list1];
      for (const r of results) all_list.push(...r);
      console.log(`[atendimentos] parallel ${pages.length} pages: total ${all_list.length}`);
      return all_list;
    }

    const useAll = all === 'true';
    const lista = await fetchAtendPages(ini, fim, useAll);

    function inferirSetor(tipo) {
      const t = (tipo || '').toUpperCase();
      if (t.includes('NOC') || t.includes('INSTABILIDADE') || t.includes('SEM SINAL') || t.includes('LENTIDÃO') || t.includes('LENTIDAO') || t.includes('FIBRA') || t.includes('SUPORTE TEC')) return 'NOC';
      if (t.includes('FINANCEIRO') || t.includes('PAGAMENTO') || t.includes('2ª VIA') || t.includes('2A VIA') || t.includes('BOLETO') || t.includes('SEGUNDA VIA')) return 'Financeiro';
      if (t.includes('COBRAN') || t.includes('VENCIMENTO') || t.includes('DISPARO') || t.includes('INADIMPL') || t.includes('SUSPENS') || t.includes('CORTE')) return 'Cobrança';
      if (t.includes('COMERCIAL') || t.includes('VENDA') || t.includes('CANCEL') || t.includes('CONTRATO') || t.includes('PLANO') || t.includes('UPGRADE') || t.includes('MIGRA')) return 'Comercial';
      if (t.includes('CALL') || t.includes('RECEP') || t.includes('GERAL') || t.includes('INFORMAÇ') || t.includes('INFORMAC')) return 'Call Center';
      return '';
    }

    function parseA(a) {
      const tipo      = a.tipo_atendimento?.descricao || 'Sem tipo';
      const statusRaw = a.status?.descricao || a.status?.prefixo || '';
      const temOS     = (a.ordem_servico_count || 0) > 0;
      const isFechado = !!a.data_fechamento;

      // Atendente: campo correto é usuarios_responsaveis[0].name
      const resps = Array.isArray(a.usuarios_responsaveis) ? a.usuarios_responsaveis : [];
      const atendente = resps.map(u => u.name || u.nome).filter(Boolean).join(', ')
                     || a.usuario_fechamento?.name || a.usuario_fechamento?.nome
                     || 'Sem atendente';

      // Setor: busca pelo ID do usuário responsável (mapeamento definitivo)
      const respPrincipal = resps[0] || a.usuario_fechamento || {};
      const setor = SETOR_POR_ID[respPrincipal.id]
                 || SETOR_POR_NOME[atendente]
                 || inferirSetor(tipo);

      // Cliente: cliente_servico.cliente.nome_razaosocial (não cliente_servico.display que é o plano)
      const cli    = a.cliente_servico?.cliente;
      const cliente   = cli?.nome_razaosocial || cli?.display
                     || a.cliente_servico?.display || 'Sem cliente';
      const clienteId = cli?.id_cliente || a.id_cliente_servico || cliente;

      let tmaMin = null;
      if (a.data_cadastro && a.data_fechamento) {
        const dur = (new Date(a.data_fechamento) - new Date(a.data_cadastro)) / 60000;
        if (dur > 0 && dur < 600) tmaMin = Math.round(dur);
      }

      return { tipo, atendente, setor, cliente, clienteId, temOS, isFechado, tmaMin };
    }

    // NOC fica separado (rede/infra) mas sem setor ('') agora é contado normalmente
    const SETORES_EXCLUIDOS = ['NOC'];
    const parsedAll = lista.map(parseA);
    const nocAll    = parsedAll.filter(a => a.setor === 'NOC');
    const parsed    = parsedAll.filter(a => !SETORES_EXCLUIDOS.includes(a.setor));

    const isLC = (nome) => (nome || '').toUpperCase().includes('LC VIRTUAL') || (nome || '').toUpperCase().includes('LCVIRTUAL');

    // Agrupa por atendente (inclui setor e tipos para cross-filter)
    const mapaAt = {};
    parsed.forEach(a => {
      const k = a.atendente;
      if (!mapaAt[k]) mapaAt[k] = { atendente:k, setor:a.setor, total:0, comOS:0, semOS:0, tmaTot:0, tmaCount:0, tipos:{} };
      mapaAt[k].total++;
      if (a.temOS) mapaAt[k].comOS++; else if (a.isFechado) mapaAt[k].semOS++;
      if (a.tmaMin !== null) { mapaAt[k].tmaTot += a.tmaMin; mapaAt[k].tmaCount++; }
      // Acumula tipos por atendente
      if (!mapaAt[k].tipos[a.tipo]) mapaAt[k].tipos[a.tipo] = { tipo: a.tipo, total: 0, comOS: 0, semOS: 0 };
      mapaAt[k].tipos[a.tipo].total++;
      if (a.temOS) mapaAt[k].tipos[a.tipo].comOS++; else if (a.isFechado) mapaAt[k].tipos[a.tipo].semOS++;
    });
    const por_atendente = Object.values(mapaAt)
      .map(a => ({ atendente:a.atendente, setor:a.setor, total:a.total, comOS:a.comOS, semOS:a.semOS,
                   pctSemOS: a.total ? Math.round(a.semOS/a.total*100) : 0,
                   tma: a.tmaCount ? Math.round(a.tmaTot/a.tmaCount) : null,
                   tipos: Object.values(a.tipos).sort((x,y) => y.total - x.total) }))
      .sort((a,b) => b.total - a.total);

    // Agrupa por setor
    const mapaSet = {};
    parsed.forEach(a => {
      const k = a.setor;
      if (!mapaSet[k]) mapaSet[k] = { setor:k, total:0, comOS:0, semOS:0 };
      mapaSet[k].total++;
      if (a.temOS) mapaSet[k].comOS++; else if (a.isFechado) mapaSet[k].semOS++;
    });
    const por_setor = Object.values(mapaSet)
      .map(s => ({ ...s, pctSemOS: s.total ? Math.round(s.semOS/s.total*100) : 0 }))
      .sort((a,b) => b.total - a.total);

    // Agrupa por tipo (backwards compat)
    const mapaTipo = {};
    parsed.forEach(a => {
      const k = a.tipo;
      if (!mapaTipo[k]) mapaTipo[k] = { tipo:k, total:0, comOS:0, semOS:0, tmaTot:0, tmaCount:0 };
      mapaTipo[k].total++;
      if (a.temOS) mapaTipo[k].comOS++; else if (a.isFechado) mapaTipo[k].semOS++;
      if (a.tmaMin !== null) { mapaTipo[k].tmaTot += a.tmaMin; mapaTipo[k].tmaCount++; }
    });
    const por_tipo = Object.values(mapaTipo)
      .map(t => ({ tipo:t.tipo, total:t.total, comOS:t.comOS, semOS:t.semOS,
                   pctSemOS: t.total ? Math.round(t.semOS/t.total*100) : 0,
                   tma: t.tmaCount ? Math.round(t.tmaTot/t.tmaCount) : null }))
      .sort((a,b) => b.total - a.total);

    // Clientes recorrentes — excluindo LC Virtual Net
    const mapaClientes = {};
    parsed.forEach(a => {
      if (isLC(a.cliente)) return;
      const k = a.clienteId;
      if (!mapaClientes[k]) mapaClientes[k] = { cliente:a.cliente, contatos:0, semOS:0, comOS:0, setor:a.setor, tipos:{} };
      mapaClientes[k].contatos++;
      if (a.temOS) mapaClientes[k].comOS++; else if (a.isFechado) mapaClientes[k].semOS++;
      mapaClientes[k].tipos[a.tipo] = (mapaClientes[k].tipos[a.tipo] || 0) + 1;
    });
    const clientes_recorrentes = Object.entries(mapaClientes)
      .filter(([,c]) => c.contatos > 1)
      .map(([clienteId, c]) => ({ ...c, clienteId, tipos: Object.entries(c.tipos).sort((a,b)=>b[1]-a[1]).map(([tipo,n])=>({tipo,n})) }))
      .sort((a,b) => b.contatos - a.contatos)
      .slice(0, 50);

    // Expansão, Correção e Construção de Rede — todos atendimentos cujo cliente é LC Virtual Net
    const mapaLC = {};
    parsedAll.filter(a => isLC(a.cliente)).forEach(a => {
      const k = a.cliente;
      if (!mapaLC[k]) mapaLC[k] = { cliente: k, clienteId: a.clienteId, total: 0, comOS: 0, semOS: 0, tipos: {} };
      mapaLC[k].total++;
      if (a.temOS) mapaLC[k].comOS++; else if (a.isFechado) mapaLC[k].semOS++;
      mapaLC[k].tipos[a.tipo] = (mapaLC[k].tipos[a.tipo] || 0) + 1;
    });
    const lc_virtual = Object.values(mapaLC)
      .map(g => ({ ...g, tipos: Object.entries(g.tipos).sort((a,b)=>b[1]-a[1]).map(([tipo,n])=>({tipo,n})) }))
      .sort((a, b) => b.total - a.total);

    // Estatísticas NOC separadas
    const nocPorTipo = {};
    nocAll.forEach(a => {
      nocPorTipo[a.tipo] = (nocPorTipo[a.tipo] || 0) + 1;
    });
    const noc = {
      total: nocAll.length,
      comOS: nocAll.filter(a => a.temOS).length,
      semOS: nocAll.filter(a => !a.temOS && a.isFechado).length,
      por_tipo: Object.entries(nocPorTipo).sort((a,b)=>b[1]-a[1]).map(([tipo,n])=>({tipo,n})),
    };

    const periodo = req.query.periodo || 'custom';
    const atendResult = {
      ok: true, total: parsed.length,
      por_atendente, por_setor, por_tipo, clientes_recorrentes, lc_virtual, noc, periodo,
      sincronizado_em: new Date().toISOString(),
    };
    _atendCacheMap[atendKey] = { data: atendResult, ts: Date.now() };
    dbCacheSet(`cache:atendimentos:${atendKey}`, atendResult);
    res.json(atendResult);
  } catch (err) {
    console.error('Erro /api/atendimentos:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});


// ── Cache Retenção (5 min por chave de período) ───────────────────
const _retCacheMap = {};
const RET_CACHE_TTL = 5 * 60 * 1000;

// ── Retenção — pedidos de cancelamento (atendimentos) por período ─
app.get('/api/retencao', async (req, res) => {
  try {
    const { data_inicio, data_fim, all } = req.query;
    const agora  = new Date();
    const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999);
    const ini = data_inicio || iniMes.toISOString();
    const fim = data_fim    || fimMes.toISOString();

    // 1) Cache em memória
    const retKey = `${ini.slice(0,10)}-${fim.slice(0,10)}-${all||'false'}`;
    const retCached = _retCacheMap[retKey];
    if (retCached && (Date.now() - retCached.ts) < RET_CACHE_TTL) {
      return res.json({ ...retCached.data, cache: true });
    }
    // 2) Cache no PostgreSQL
    const dbRetKey = `cache:retencao:${retKey}`;
    const dbRetCached = await dbCacheGet(dbRetKey, RET_CACHE_TTL);
    if (dbRetCached) {
      _retCacheMap[retKey] = { data: dbRetCached, ts: Date.now() };
      return res.json({ ...dbRetCached, cache: 'db' });
    }

    // Fetch all atendimentos in period (parallel pagination)
    const extractAtend = d => d?.atendimentos?.data || d?.atendimento?.data || d?.data || [];
    const extractPages = d => d?.atendimentos?.last_page || d?.atendimento?.last_page || d?.last_page || 1;
    const first = await hubsoftPost('v1/atendimento/consultar/paginado/500?page=1', { data_inicio: ini, data_fim: fim });
    const lista1     = extractAtend(first);
    const totalPages = extractPages(first);
    let lista = [...lista1];
    if (all === 'true' && totalPages > 1) {
      const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const results = await Promise.all(pages.map(async pg => {
        try {
          const d = await hubsoftPost(`v1/atendimento/consultar/paginado/500?page=${pg}`, { data_inicio: ini, data_fim: fim });
          return extractAtend(d);
        } catch { return []; }
      }));
      results.forEach(r => lista.push(...r));
    }

    // Desfecho via status.prefixo + id_motivo_fechamento_atendimento:
    const MOTIVO_CANCELADO = new Set([89]);
    const MOTIVO_REVERTIDO = new Set([75, 90]); // 75 = cliente aceitou proposta (confirmado via debug)
    const desfechoOf = (a) => {
      const sp = (a.status?.prefixo || '').toLowerCase();
      const sf = (a.status_fechamento || '').toLowerCase();
      if (!sf || sf === 'pendente' || sp === 'pendente' || sp === 'aguardando_analise') return 'pendente';
      // Verificar revertido ANTES de cancelado — "reverteu cancelamento" contém "cancel"
      if (sf.includes('revert')) return 'revertido';
      if (sf.includes('cancel') || sf.includes('rescis')) return 'cancelado';
      const idMotivo = a.id_motivo_fechamento_atendimento;
      if (idMotivo && MOTIVO_CANCELADO.has(idMotivo)) return 'cancelado';
      if (idMotivo && MOTIVO_REVERTIDO.has(idMotivo)) return 'revertido';
      const df = (a.descricao_fechamento || '').toLowerCase();
      if (df.includes('cancel') && !df.includes('não') && !df.includes('nao') && !df.includes('não irá')) return 'cancelado';
      return 'revertido';
    };

    // Pedidos de cancelamento = SOMENTE tipo "SOLICITAÇÃO DE CANCELAMENTO", qualquer status (aberto ou fechado)
    // Revertidos = mesmos pedidos fechados como "reverteu cancelamento"
    const norm = s => (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isSolicitacaoCancelamento = (tipo) => {
      const u = norm(tipo);
      return u.includes('SOLICIT') && u.includes('CANCELAMENTO');
    };

    const pedidos = lista
      .map(a => {
        const tipo      = a.tipo_atendimento?.descricao || 'Sem tipo';
        const desfecho  = desfechoOf(a);
        return { _raw: a, tipo, desfecho };
      })
      .filter(({ tipo }) => isSolicitacaoCancelamento(tipo))
      .map(({ _raw: a, tipo, desfecho }) => {
        const resps     = Array.isArray(a.usuarios_responsaveis) ? a.usuarios_responsaveis : [];
        const atendente = resps.map(u => u.name || u.nome).filter(Boolean).join(', ')
                       || a.usuario_fechamento?.name || a.usuario_fechamento?.nome
                       || 'Sem atendente';
        const cli       = a.cliente_servico?.cliente;
        const cliente   = cli?.nome_razaosocial || cli?.display || a.cliente_servico?.display || 'Sem cliente';
        const data      = a.data_fechamento || a.data_cadastro || null;
        const resumo    = a.descricao_fechamento || a.descricao_abertura || '';
        const txtOrig   = ((a.descricao_abertura || '') + ' ' + (a.descricao_fechamento || '')).toUpperCase();
        const origem    = txtOrig.includes('CHAT MIX') || txtOrig.includes('CHATMIX') ? 'ChatMix (WhatsApp)'
                        : txtOrig.includes('PRESENCIAL') ? 'Presencial'
                        : txtOrig.includes('LIGA') ? 'Ligação'
                        : 'Origem ausente';
        return { tipo, desfecho, atendente, cliente, data, resumo, origem };
      });

    const total      = pedidos.length;
    const revertidos = pedidos.filter(p => p.desfecho === 'revertido').length;
    const cancelados = pedidos.filter(p => p.desfecho === 'cancelado').length;
    const pendentes  = pedidos.filter(p => p.desfecho === 'pendente').length;
    const fechados   = revertidos + cancelados;
    const taxa_retencao = total > 0 ? Math.round(revertidos / total * 100) : null;

    // Cancelamento geral: qualquer atendimento fechado como cancelado, independente do tipo de abertura
    const todosCancel = lista.filter(a => desfechoOf(a) === 'cancelado');
    const cancelamento_geral = todosCancel.length;
    // Breakdown por tipo de abertura
    const mapaMotivoGeral = {};
    for (const a of todosCancel) {
      const tipo = a.tipo_atendimento?.descricao || 'Sem tipo';
      if (!mapaMotivoGeral[tipo]) mapaMotivoGeral[tipo] = { tipo, total: 0 };
      mapaMotivoGeral[tipo].total++;
    }
    const por_motivo_cancelamento_geral = Object.values(mapaMotivoGeral).sort((a,b) => b.total - a.total);

    // Por atendente
    const mapaAt = {};
    pedidos.forEach(p => {
      if (!mapaAt[p.atendente]) mapaAt[p.atendente] = { atendente: p.atendente, total: 0, revertidos: 0, cancelados: 0, pendentes: 0 };
      mapaAt[p.atendente].total++;
      if (p.desfecho === 'revertido') mapaAt[p.atendente].revertidos++;
      else if (p.desfecho === 'cancelado') mapaAt[p.atendente].cancelados++;
      else mapaAt[p.atendente].pendentes++;
    });
    const por_atendente = Object.values(mapaAt)
      .map(a => ({ ...a, taxa: (a.revertidos + a.cancelados) > 0 ? Math.round(a.revertidos / (a.revertidos + a.cancelados) * 100) : null }))
      .sort((a, b) => b.total - a.total);

    // Por origem de contato
    const mapaOrigem = {};
    pedidos.forEach(p => {
      if (!mapaOrigem[p.origem]) mapaOrigem[p.origem] = { origem: p.origem, total: 0, revertidos: 0, cancelados: 0 };
      mapaOrigem[p.origem].total++;
      if (p.desfecho === 'revertido') mapaOrigem[p.origem].revertidos++;
      else if (p.desfecho === 'cancelado') mapaOrigem[p.origem].cancelados++;
    });
    const por_origem = Object.values(mapaOrigem).sort((a, b) => b.total - a.total);

    const ultimos = [...pedidos]
      .sort((a, b) => (b.data || '') > (a.data || '') ? 1 : -1);

    const retResult = {
      ok: true,
      total, revertidos, cancelados, pendentes, taxa_retencao,
      cancelamento_geral, por_motivo_cancelamento_geral,
      por_atendente, por_origem, ultimos,
      sincronizado_em: new Date().toISOString(),
    };
    _retCacheMap[retKey] = { data: retResult, ts: Date.now() };
    dbCacheSet(dbRetKey, retResult); // salva no banco sem bloquear
    res.json(retResult);
  } catch (err) {
    console.error('Erro /api/retencao:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});




// ── Cancelamentos de Serviço — por motivo, com lista de clientes ──
const _cancelServCache = {};
const CANCEL_SERV_TTL  = 5 * 60 * 1000; // 5 min

app.get('/api/cancelamentos-servico', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const agora  = new Date();
    const iniStr = data_inicio ? data_inicio.slice(0, 10)
      : `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-01`;
    const fimStr = data_fim ? data_fim.slice(0, 10)
      : (() => { const fim = new Date(agora.getFullYear(), agora.getMonth()+1, 0); return fim.toISOString().slice(0,10); })();

    // Cache por chave de período
    const cacheKey = `${iniStr}-${fimStr}`;
    const cached = _cancelServCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < CANCEL_SERV_TTL) {
      return res.json({ ...cached.data, cache: true });
    }

    // Busca clientes com data_cancelamento no período via filtro nativo da API
    const token = await getToken();
    const params = {
      relacoes: 'endereco_instalacao',
      tipo_data_cliente_servico: 'data_cancelamento',
      data_inicio_cliente_servico: iniStr,
      data_fim_cliente_servico: fimStr,
    };
    // maxPag=15: filtro por data já limita bastante os resultados (1-5 páginas normalmente)
    const [ativos, cancelados] = await Promise.all([
      fetchIntegracaoClientes(token, { ...params, cancelado: 'nao' }, 15),
      fetchIntegracaoClientes(token, { ...params, cancelado: 'sim' }, 15),
    ]);
    const todos = [...ativos, ...cancelados];

    // Motivos que NÃO devem ser contados como cancelamento nesta aba
    // Usa includes() para ignorar prefixos como asterisco "* Desistência da Instalação"
    const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const MOTIVOS_IGNORADOS = [
      'desistencia da instalacao',
      'habilitado o user errado',
      'troca de titularidade',
    ];
    const ignorarMotivo = m => { const n = norm(m); return MOTIVOS_IGNORADOS.some(p => n.includes(p)); };

    const iniMs = new Date(iniStr).getTime();
    const fimMs = new Date(fimStr + 'T23:59:59').getTime();
    const seen  = new Set();
    const mapaMotivo = {};
    let total = 0;
    let total_ativo  = 0; // apenas inadimplência
    let total_passivo = 0; // demais motivos (cliente pediu cancelamento)

    const isInadimplencia = m => norm(m).includes('inadimp');

    for (const cli of todos) {
      const nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
      for (const s of (cli.servicos || [])) {
        const dc = parseDate(s.data_cancelamento);
        if (!dc) continue;
        const dcMs = dc.getTime();
        if (dcMs < iniMs || dcMs > fimMs) continue;

        // Ignora motivos que não são cancelamentos reais (somente nesta aba)
        const motivoRaw = (s.motivo_cancelamento || '').trim();
        if (ignorarMotivo(motivoRaw)) continue;

        // Dedup: mesmo cliente + plano + data cancelamento
        const chave = `${nome}|${s.nome||''}|${s.data_cancelamento||''}`;
        if (seen.has(chave)) continue;
        seen.add(chave);

        const motivo = motivoRaw || 'Não informado';
        const plano  = s.nome || '—';
        const endInst = typeof s.endereco_instalacao === 'object' && s.endereco_instalacao
          ? s.endereco_instalacao : {};
        const cidade = endInst.cidade || '—';

        if (!mapaMotivo[motivo]) mapaMotivo[motivo] = { motivo, total: 0, clientes: [] };
        mapaMotivo[motivo].total++;
        mapaMotivo[motivo].clientes.push({ nome, cidade, plano, motivo, data: s.data_cancelamento });
        total++;

        if (isInadimplencia(motivo)) total_ativo++;
        else total_passivo++;
      }
    }

    const por_motivo = Object.values(mapaMotivo)
      .sort((a, b) => b.total - a.total)
      .map(m => ({ ...m, clientes: m.clientes.sort((a,b) => (b.data||'') > (a.data||'') ? 1 : -1) }));

    const result = { ok: true, total, total_ativo, total_passivo, por_motivo, periodo: { ini: iniStr, fim: fimStr } };
    _cancelServCache[cacheKey] = { data: result, ts: Date.now() };
    res.json(result);
  } catch(err) {
    console.error('/api/cancelamentos-servico:', err.message);
    // Se tem cache antigo para este período, retorna stale
    const stale = _cancelServCache[`${iniStr}-${fimStr}`];
    if (stale) return res.json({ ...stale.data, cache: 'stale' });
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Remoções de Equipamentos — OS finalizadas com motivo "removido" ──
const _remCacheMap = {};
const REM_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/remocoes', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    const agora  = new Date();
    const iniStr = data_inicio ? data_inicio.slice(0, 10)
      : `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-01`;
    const fimStr = data_fim ? data_fim.slice(0, 10)
      : (() => { const f = new Date(agora.getFullYear(), agora.getMonth()+1, 0); return f.toISOString().slice(0,10); })();

    const remKey = `${iniStr}-${fimStr}`;
    // 1) Cache em memória
    const remCached = _remCacheMap[remKey];
    if (remCached && (Date.now() - remCached.ts) < REM_CACHE_TTL) {
      return res.json({ ...remCached.data, cache: true });
    }
    // 2) Cache no PostgreSQL
    const dbRemKey = `cache:remocoes:${remKey}`;
    const dbRemCached = await dbCacheGet(dbRemKey, REM_CACHE_TTL);
    if (dbRemCached) {
      _remCacheMap[remKey] = { data: dbRemCached, ts: Date.now() };
      return res.json({ ...dbRemCached, cache: 'db' });
    }

    const iniMs = new Date(iniStr).getTime();
    const fimMs = new Date(fimStr + 'T23:59:59').getTime();

    // Query com margem de 14 dias antes do início para capturar OS agendadas antes mas fechadas no período
    const queryIni = new Date(iniMs - 14 * 86400000).toISOString();
    const queryFim = new Date(fimMs + 86400000).toISOString();

    const normStr = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    const extrairMotivo = os => {
      const mf = os.motivo_fechamento;
      if (!mf) return '';
      if (typeof mf === 'string') return mf;
      if (Array.isArray(mf)) return mf.map(m => m?.descricao || m?.nome || '').filter(Boolean).join(', ');
      return mf?.descricao || mf?.nome || '';
    };

    // Busca paginada completa — apenas OS finalizadas
    const PAGE_SIZE = 500;
    const MAX_PAGES = 50;
    const bodyBase = {
      data_inicio: queryIni, data_fim: queryFim,
      agendas: [], assinatura_cliente: null, bairros: null, cidades: [],
      condominios: null, grupos_clientes: [], grupos_clientes_servicos: [],
      motivo_fechamento: [], order_by: 'data_inicio_programado', order_by_key: 'DESC',
      participantes: [], periodos: [], pop: [], prioridade: [], reservada: null,
      servico: [], servico_status: [], status_ordem_servico: ['finalizado'], tecnicos: [],
    };

    const data1 = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=1`, bodyBase);
    const lista  = [...extrairLista(data1)];
    const { lastPage, total, perPage } = extrairPaginacao(data1);
    let totalPages = lastPage || (total && perPage ? Math.ceil(total / perPage) : null);
    if (!totalPages) totalPages = lista.length >= PAGE_SIZE ? MAX_PAGES : 1;
    totalPages = Math.min(totalPages, MAX_PAGES);

    if (totalPages > 1) {
      const pages   = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const results = await Promise.all(pages.map(pg =>
        hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, bodyBase).then(extrairLista)
      ));
      for (const r of results) lista.push(...r);
    }

    console.log(`[remocoes] total OS finalizadas buscadas: ${lista.length}`);

    const norm = s => normStr(s);
    const categorizaTipo = t => {
      const u = norm(t);
      if (u.includes('spc'))    return 'spc';
      if (u.includes('cobran')) return 'cobr';
      if (u.includes('cancel')) return 'canc';
      return 'outro';
    };

    // Filtra por motivo "removido" E data de fechamento real dentro do período
    const remocoes = [];
    for (const os of lista) {
      const mf = extrairMotivo(os);
      if (!norm(mf).includes('removid')) continue;

      // Data de fechamento: prefere data_termino_executado, cai em data_inicio_programado
      const fechRaw = os.data_termino_executado || os.data_inicio_programado || os.data_cadastro;
      const fechMs  = fechRaw ? new Date(fechRaw).getTime() : 0;
      if (!fechMs || fechMs < iniMs || fechMs > fimMs) continue;

      const tecs  = os.tecnicos || [];
      const tec   = tecs.map(t => t.name || t.nome || t.display).filter(Boolean).join(', ') || 'Sem técnico';
      const cs    = os.atendimento?.cliente_servico;
      const end   = cs?.endereco_instalacao;
      const cli   = cs?.display || cs?.cliente?.nome_razaosocial || cs?.cliente?.display || '—';
      const cidade = end?.endereco_numero?.cidade?.nome || end?.cidade?.nome || end?.cidade?.display
                  || cs?.cliente?.cidade?.nome || '—';
      const tipo  = os.tipo_ordem_servico?.descricao || os.tipo_os?.nome || '—';

      remocoes.push({ cli, cidade, tec, tipo, motivoFech: mf, data: fechRaw });
    }

    console.log(`[remocoes] removidos no período ${iniStr}→${fimStr}: ${remocoes.length}`);

    // KPIs por tipo de abertura
    let tipoCanc = 0, tipoCobr = 0, tipoSpc = 0, tipoOutro = 0;
    const tecMap = {};
    for (const r of remocoes) {
      const cat = categorizaTipo(r.tipo);
      if (cat === 'canc') tipoCanc++; else if (cat === 'cobr') tipoCobr++;
      else if (cat === 'spc') tipoSpc++; else tipoOutro++;
      tecMap[r.tec] = (tecMap[r.tec] || 0) + 1;
    }

    const por_tecnico = Object.entries(tecMap)
      .sort((a, b) => b[1] - a[1])
      .map(([tec, total]) => ({ tec, total }));

    const ultimas = remocoes
      .sort((a, b) => (b.data || '') > (a.data || '') ? 1 : -1);

    const remResult = {
      ok: true,
      total: remocoes.length,
      tipo_canc: tipoCanc, tipo_cobr: tipoCobr, tipo_spc: tipoSpc, tipo_outro: tipoOutro,
      por_tecnico, ultimas,
      periodo: { ini: iniStr, fim: fimStr },
    };
    _remCacheMap[remKey] = { data: remResult, ts: Date.now() };
    dbCacheSet(dbRemKey, remResult); // salva no banco sem bloquear
    res.json(remResult);
  } catch(err) {
    console.error('/api/remocoes:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── COMERCIAL — GET /api/v1/integracao/cliente/todos ─────────────
// Helper: busca todas as páginas do endpoint de integração
// maxPag: limite de páginas (default 30 = 15.000 clientes); use menor para respostas rápidas
async function fetchIntegracaoClientes(token, params = {}, maxPag = 30) {
  const headers = { Authorization: `Bearer ${token}` };
  const todos = [];
  let pagina = 0;
  while (true) {
    const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/cliente/todos`, {
      headers, params: { itens_por_pagina: 500, ...params, pagina }, timeout: 15000,
    });
    const clientes  = r.data?.clientes || [];
    const ultimaPag = r.data?.paginacao?.ultima_pagina ?? 0;
    todos.push(...clientes);
    if (pagina >= ultimaPag || clientes.length === 0) break;
    pagina++;
    if (pagina > maxPag) break;
  }
  return todos;
}

// ── Cache do comercial ────────────────────────────────────────────
// _comAllClientes: todos os clientes ativos (15k+), atualizado em background
let _comAllClientes  = null;   // array de clientes normalizados
let _comCancelados   = null;   // clientes cancelados recentes (para capturar cancelados no mesmo mês)
let _comFetching     = false;  // lock
let _comFetchedAt    = 0;      // timestamp da última busca completa
let _comAllCancelados = null;  // todos os cancelados (histórico completo)
let _comAllCanceladosAt = 0;
let _comAllCanceladosFetching = false;

function buildVendasFromClientes(clientes, iniStr, fimStr) {
  // Usa apenas a parte da data (YYYY-MM-DD) para evitar bleed de timezone:
  // o frontend envia ISO com offset Brazil (-03:00), então "28/02 23:59 BRT" vira "01/03 02:59 UTC",
  // fazendo vendas do dia 1/3 entrarem no filtro de fevereiro.
  const iniMs = new Date(iniStr.slice(0, 10)).getTime();
  const fimMs = new Date(fimStr.slice(0, 10) + 'T23:59:59').getTime();
  const vendas = [];
  const seen   = new Set(); // dedup por chave composta — evita dupla contagem quando cliente aparece nos dois caches
  for (const cli of clientes) {
    const nome    = cli.nome_razaosocial || cli.nome_fantasia || '—';
    const servicos = cli.servicos || [];

    for (const s of servicos) {
      // Usa SOMENTE data_venda — igual ao filtro "Data da Venda" do Hubsoft
      const rawVenda  = s.data_venda || null;
      const vendaDate = rawVenda ? parseDate(rawVenda) : null;
      const vendaMs   = vendaDate ? vendaDate.getTime() : 0;
      // Para períodos passados, aplica limite superior (ex: março não mostra vendas de abril).
      // Para o mês atual e futuro, sem limite superior: datas erradas (ex: 31/12/2026) aparecem
      // para o usuário identificar e corrigir no Hubsoft.
      const todayMs = new Date(new Date().toISOString().slice(0, 10)).getTime();
      const isPastPeriod = fimMs < todayMs;
      if (!vendaMs || vendaMs < iniMs) continue;
      if (isPastPeriod && vendaMs > fimMs) continue;

      // Dedup por chave composta: mesmo cliente + mesmo plano + mesma data_venda
      const chave = `${nome}|${s.nome || ''}|${s.data_venda || ''}`;
      if (seen.has(chave)) continue;
      seen.add(chave);

      const endInst = typeof s.endereco_instalacao === 'object' && s.endereco_instalacao
        ? s.endereco_instalacao : {};
      const cidade  = endInst.cidade || 'Desconhecida';
      const plano   = s.nome || '—';
      const status  = s.status_prefixo || '';

      const vend = s.vendedor;
      const vendedor = typeof vend === 'string' ? vend
        : (vend?.nome || vend?.name || '—');

      const habDate = s.data_habilitacao ? parseDate(s.data_habilitacao) : null;
      const habMs   = habDate ? habDate.getTime() : 0;

      // Reativação: data_habilitacao existe e é mais de 30 dias antes da data_venda
      const reativacao = !!(habMs && vendaMs && (vendaMs - habMs) > 30 * 86400000);

      const cancelado = !!(s.data_cancelamento || status.includes('cancelado') || status.includes('rescindi') || status.includes('rescisao'));

      const dataVenda = vendaDate.toISOString().split('T')[0];
      const motivo = (s.motivo_cancelamento || '').trim() || null;
      vendas.push({ cliente: nome, cidade, plano, vendedor, status, dataCad: dataVenda, dataVenda, reativacao, cancelado, motivo });
    }
  }
  return vendas;
}

function buildComResult(vendas, iniStr, fimStr) {
  const cidadeMap   = {};
  const planoMap    = {};
  const vendedorMap = {};
  for (const v of vendas) {
    if (!cidadeMap[v.cidade]) cidadeMap[v.cidade] = { nome: v.cidade, total: 0, novas: 0, reat: 0 };
    cidadeMap[v.cidade].total++;
    if (v.reativacao) cidadeMap[v.cidade].reat++; else cidadeMap[v.cidade].novas++;
    if (!planoMap[v.plano]) planoMap[v.plano] = { nome: v.plano, total: 0 };
    planoMap[v.plano].total++;
    if (v.vendedor && v.vendedor !== '—') {
      if (!vendedorMap[v.vendedor]) vendedorMap[v.vendedor] = { nome: v.vendedor, total: 0, novas: 0, reat: 0, ativas: 0 };
      vendedorMap[v.vendedor].total++;
      if (!v.cancelado) vendedorMap[v.vendedor].ativas++;
      if (v.reativacao) vendedorMap[v.vendedor].reat++; else vendedorMap[v.vendedor].novas++;
    }
  }
  // Breakdown por status_prefixo
  const statusMap = {};
  for (const v of vendas) {
    const st = v.status || 'desconhecido';
    statusMap[st] = (statusMap[st] || 0) + 1;
  }
  const por_status = Object.entries(statusMap)
    .sort((a, b) => b[1] - a[1])
    .map(([status, total]) => ({ status, total }));

  const novas       = vendas.filter(v => !v.reativacao && !v.cancelado).length;
  const reativacoes = vendas.filter(v => v.reativacao && !v.cancelado).length;
  const cancelados  = vendas.filter(v => v.cancelado).length;
  const ativos      = vendas.filter(v => !v.cancelado).length;

  // Detalhe dos cancelados: motivos e vendedores
  const vendasCanceladas = vendas.filter(v => v.cancelado);
  const motivoMap = {};
  for (const v of vendasCanceladas) {
    const m = v.motivo || 'Não informado';
    if (!motivoMap[m]) motivoMap[m] = 0;
    motivoMap[m]++;
  }
  const cancelados_por_motivo = Object.entries(motivoMap)
    .sort((a, b) => b[1] - a[1])
    .map(([motivo, total]) => ({ motivo, total }));
  const cancelados_detalhe = vendasCanceladas
    .sort((a, b) => b.dataVenda > a.dataVenda ? 1 : -1)
    .map(v => ({ cliente: v.cliente, vendedor: v.vendedor, plano: v.plano, motivo: v.motivo || 'Não informado', dataVenda: v.dataVenda }));
  return {
    ok: true, fonte: 'integracao_cliente_todos',
    total: vendas.length,
    novas, reativacoes, cancelados, ativos,
    periodo: { ini: iniStr, fim: fimStr },
    por_status,
    cancelados_por_motivo, cancelados_detalhe,
    cidades:    Object.values(cidadeMap).sort((a,b) => b.total - a.total),
    vendedores: Object.values(vendedorMap).sort((a,b) => b.total - a.total),
    planos:     Object.values(planoMap).sort((a,b) => b.total - a.total),
    ultimas:    vendas.slice().sort((a, b) => b.dataVenda > a.dataVenda ? 1 : -1),
  };
}

// Dispara busca completa em background (sem bloquear requests HTTP)
async function warmupComercial() {
  if (_comFetching) return;
  if (_comAllClientes && (Date.now() - _comFetchedAt) < 1800000) return;
  _comFetching = true;
  try {
    console.log('[comercial] Iniciando warm-up em background...');
    const token    = await getToken();
    const clientes = await fetchIntegracaoClientes(token,
      { cancelado: 'nao', relacoes: 'endereco_instalacao' }, 999);
    // Só atualiza cache quando a busca completa (evita race condition)
    _comAllClientes = clientes;
    _comCancelados  = null;
    _comFetchedAt   = Date.now();
    // Não persiste clientes brutos no DB — array 15k+ estoura cota de transferência
    console.log(`[comercial] Cache populado: ${clientes.length} ativos`);
  } catch(e) {
    console.warn('[comercial] Warm-up falhou:', e.message);
  }
  _comFetching = false;
}

// ── Restaura TODOS os caches do banco no boot ────────────────────
(async () => {
  try {
    await new Promise(r => setTimeout(r, 2000)); // aguarda dbInit
    const agora = new Date();
    const hoje  = agora.toISOString().slice(0,10);
    const mesIni = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString().slice(0,10);
    const mesFim = new Date(agora.getFullYear(), agora.getMonth()+1, 0, 23,59,59).toISOString().slice(0,10);

    // Chamados hoje
    const ch = await dbCacheRestore('cache:chamados:hoje');
    if (ch) { _chamadosCache.set('hoje', { data: ch, ts: Date.now() }); console.log('[boot] chamados restaurados do banco'); }
    // Financeiro
    const fin = await dbCacheRestore('cache:financeiro');
    if (fin) { _finCache = fin; _finFetchedAt = Date.now(); console.log('[boot] financeiro restaurado'); }
    // Retenção
    const retKey = `${mesIni}-${mesFim}-false`;
    const ret = await dbCacheRestore(`cache:retencao:${retKey}`);
    if (ret) { _retCacheMap[retKey] = { data: ret, ts: Date.now() }; console.log('[boot] retencao restaurada'); }
    // Remoções
    const remKey = `${mesIni}-${mesFim}`;
    const rem = await dbCacheRestore(`cache:remocoes:${remKey}`);
    if (rem) { _remCacheMap[remKey] = { data: rem, ts: Date.now() }; console.log('[boot] remocoes restauradas'); }
    // Atendimentos hoje
    const atKey = `${hoje}-${hoje}-false`;
    const at = await dbCacheRestore(`cache:atendimentos:${atKey}`);
    if (at) { _atendCacheMap[atKey] = { data: at, ts: Date.now() }; console.log('[boot] atendimentos restaurados'); }
    // Fiscal
    const fsc = await dbCacheRestore('cache:fiscal');
    if (fsc) { _fiscalCache = fsc; _fiscalFetchedAt = Date.now(); console.log('[boot] fiscal restaurado'); }
    // Estoque
    const esq = await dbCacheRestore('cache:estoque');
    if (esq) { _estoqueCache = esq; _estoqueFetchedAt = Date.now(); console.log('[boot] estoque restaurado'); }
    // Conexões
    const cx = await dbCacheRestore('cache:conexoes');
    if (cx?.cidades) { _cxCache = { clientes: [], cidades: cx.cidades, ts: cx.ts }; console.log('[boot] conexoes restauradas'); }
    // Clientes brutos não são persistidos no DB (array grande) — warm-up em background aos 5s
  } catch(e) { console.warn('[boot] restauração do banco falhou:', e.message); }
})();

// Inicia warm-up assim que o servidor sobe (sem await — não bloqueia)
setTimeout(() => warmupComercial().catch(console.warn), 5000);
// Warm-up de conexões logo após o comercial (10s delay para não sobrecarregar)
setTimeout(() => fetchConexoesHubsoft().catch(console.warn), 10000);
// Warm-up do financeiro (65s — comercial leva ~55s; financeiro reutiliza _comAllClientes)
setTimeout(() => {
  // Só executa se cache está ausente ou vencido, e não há rebuild em andamento
  if (_finFetching || (_finCache && (Date.now() - _finFetchedAt) < FIN_CACHE_TTL)) return;
  _finFetching = true;
  buildFinanceiro().then(r => {
    _finCache = r; _finFetchedAt = Date.now(); _finFetching = false;
    dbCacheSet('cache:financeiro', r);
    console.log('[financeiro] warm-up OK + salvo no banco');
  }).catch(e => { _finFetching = false; console.warn('[financeiro] warm-up falhou:', e.message); });
}, 65000);
// Cron: renova cache do financeiro a cada 25min (antes do TTL de 30min expirar)
setInterval(() => {
  if (_finFetching || !_finCache) return; // não duplica rebuild
  _finFetching = true;
  buildFinanceiro().then(r => {
    _finCache = r; _finFetchedAt = Date.now(); _finFetching = false;
    dbCacheSet('cache:financeiro', r);
    console.log('[financeiro] cron 25min OK');
  }).catch(e => { _finFetching = false; console.warn('[financeiro] cron falhou:', e.message); });
}, 25 * 60 * 1000);
// Warm-up retenção mês atual (20s)
setTimeout(async () => {
  try {
    const agora = new Date();
    const ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString();
    const fim = new Date(agora.getFullYear(), agora.getMonth()+1, 0, 23, 59, 59, 999).toISOString();
    const retKey = `${ini.slice(0,10)}-${fim.slice(0,10)}-false`;
    if (!_retCacheMap[retKey]) {
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/retencao`);
      console.log('[retencao] warm-up OK');
    }
  } catch(e) { console.warn('[retencao] warm-up falhou:', e.message); }
}, 20000);
// Renova a cada 30 minutos
setInterval(() => warmupComercial().catch(console.warn), 1800000);
// Warm-up cancelados gerais (90s após boot — não bloqueia nada crítico)
function warmupCanceladosGeral() {
  if (_comAllCanceladosFetching) return;
  if (_comAllCancelados && (Date.now() - _comAllCanceladosAt) < 6 * 60 * 60 * 1000) return;
  _comAllCanceladosFetching = true;
  getToken().then(tk => fetchIntegracaoClientes(tk, { cancelado: 'sim' }, 200))
    .then(r => {
      _comAllCancelados = r; _comAllCanceladosAt = Date.now(); _comAllCanceladosFetching = false;
      console.log(`[cancelados-geral] warm-up OK: ${r.length}`);
      // Rebuild financeiro para incluir cancelados_geral na saúde por vendedor
      if (_finCache && !_finFetching) {
        _finFetching = true;
        buildFinanceiro().then(result => {
          _finCache = result; _finFetchedAt = Date.now(); _finFetching = false;
          dbCacheSet('cache:financeiro', result);
          console.log('[financeiro] rebuild pós cancelados-geral OK');
        }).catch(e => { _finFetching = false; console.warn('[financeiro] rebuild pós cancelados-geral falhou:', e.message); });
      }
    })
    .catch(e => { _comAllCanceladosFetching = false; console.warn('[cancelados-geral] falhou:', e.message); });
}
setTimeout(() => warmupCanceladosGeral(), 90000);
// Renova a cada 6h
setInterval(() => warmupCanceladosGeral(), 6 * 60 * 60 * 1000);

app.get('/api/comercial', async (req, res) => {
  try {
    const agora = new Date();
    const fmtDate = d => d.toISOString().slice(0, 10);
    const primeiroDiaMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const ultimoDiaMes   = new Date(agora.getFullYear(), agora.getMonth() + 1, 0);
    const iniStr = req.query.data_inicio || fmtDate(primeiroDiaMes);
    const fimStr = req.query.data_fim    || fmtDate(ultimoDiaMes);

    // Cache disponível → busca cancelados do PERÍODO via filtro nativo da API (rápido: 1-2 páginas)
    if (_comAllClientes) {
      let cancelados = [];
      try {
        const tkCanc = await getToken();
        cancelados = await fetchIntegracaoClientes(tkCanc, {
          cancelado: 'sim',
          relacoes: 'endereco_instalacao',
          tipo_data_cliente_servico: 'data_venda',
          data_inicio_cliente_servico: iniStr,
          data_fim_cliente_servico: fimStr,
        }, 10);
      } catch(e) {
        console.warn('[comercial] busca cancelados falhou (usando só ativos):', e.message);
      }
      const todos  = [..._comAllClientes, ...cancelados];
      const vendas = buildVendasFromClientes(todos, iniStr, fimStr);
      return res.json(buildComResult(vendas, iniStr, fimStr));
    }

    // Cache vazio → dispara warm-up e avisa o frontend
    warmupComercial().catch(console.warn);
    return res.json({
      ok: false,
      motivo: 'cache_warmup',
      warming: true,
      info: 'Base de clientes sendo carregada. Tente novamente em 60 segundos.',
    });
  } catch(e) {
    res.json({ ok: false, motivo: e.message, vendas: [], cidades: [], vendedores: [], planos: [] });
  }
});

// ── NOC/OLT/CTO Debug — descobre endpoints de rede ───────────────────
app.get('/api/noc/debug', async (req, res) => {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  // GET simples
  const getEps = [
    'v1/olt', 'v1/olts', 'v1/olt/listar',
    'v1/cto', 'v1/ctos', 'v1/cto/listar',
    'v1/noc', 'v1/noc/listar', 'v1/noc/rede',
    'v1/pop', 'v1/pops', 'v1/pop/listar',
    'v1/equipamento_rede', 'v1/dispositivo', 'v1/dispositivos',
    'v1/infraestrutura', 'v1/rede', 'v1/redes',
    'v1/olt/consultar', 'v1/cto/consultar',
  ];
  // POST paginado
  const postEps = [
    'v1/olt/consultar/paginado/5?page=1',
    'v1/cto/consultar/paginado/5?page=1',
    'v1/noc/consultar/paginado/5?page=1',
    'v1/pop/consultar/paginado/5?page=1',
    'v1/equipamento_rede/consultar/paginado/5?page=1',
  ];

  const resultados = {};
  for (const ep of getEps) {
    try {
      const r = await axios.get(`${HUBSOFT_HOST}/api/${ep}`, { headers, params: { limit: 5 }, timeout: 6000 });
      resultados[ep] = { method:'GET', ok: true, status: r.status, keys: Object.keys(r.data||{}), amostra: JSON.stringify(r.data).slice(0,300) };
    } catch(e) {
      resultados[ep] = { method:'GET', ok: false, status: e.response?.status };
    }
  }
  for (const ep of postEps) {
    try {
      const r = await axios.post(`${HUBSOFT_HOST}/api/${ep}`, {}, { headers, timeout: 6000 });
      resultados[ep] = { method:'POST', ok: true, status: r.status, keys: Object.keys(r.data||{}), amostra: JSON.stringify(r.data).slice(0,300) };
    } catch(e) {
      resultados[ep] = { method:'POST', ok: false, status: e.response?.status };
    }
  }
  res.json({ host: HUBSOFT_HOST, resultados });
});

// ── CONEXÕES: Debug — descobre endpoint de assinantes online/offline ──
app.get('/api/conexoes/debug', async (req, res) => {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const getEps = [
    'v1/assinante/online','v1/assinante/listar','v1/assinante/consultar',
    'v1/cliente/assinante','v1/radius/sessao','v1/radius/assinante',
    'v1/conexao/assinante','v1/cliente/online','v1/conexao/consultar',
  ];
  const resultados = {};
  for (const ep of getEps) {
    try {
      const r = await axios.get(`${HUBSOFT_HOST}/api/${ep}`, { headers, params: { limit: 1 }, timeout: 6000 });
      resultados[ep] = { ok: true, status: r.status, keys: Object.keys(r.data || {}), amostra: JSON.stringify(r.data).slice(0,200) };
    } catch(e) {
      resultados[ep] = { ok: false, status: e.response?.status, msg: e.message };
    }
  }
  res.json({ host: HUBSOFT_HOST, resultados });
});

// ── COMERCIAL: Debug — descobre endpoint correto ──────────────────
app.get('/api/comercial/debug', async (req, res) => {
  const eps = [
    'v1/cliente_servico/consultar/paginado/5?page=1',
    'v1/servico_cliente/consultar/paginado/5?page=1',
    'v1/contrato/consultar/paginado/5?page=1',
    'v1/plano_servico/consultar/paginado/5?page=1',
    'v1/cliente/servico/consultar/paginado/5?page=1',
    'v1/cliente/consultar/paginado/5?page=1',
    'v1/cliente_servico', 'v1/contrato', 'v1/plano_servico',
  ];
  const agora = new Date();
  const ini   = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const body  = { data_inicio: ini.toISOString(), data_fim: agora.toISOString() };
  const resultados = {};
  for (const ep of eps) {
    try {
      const r = ep.includes('paginado')
        ? await hubsoftPost(ep, body)
        : await hubsoftGet(ep);
      resultados[ep] = { ok: true, keys: Object.keys(r || {}), amostra: JSON.stringify(r).slice(0, 300) };
    } catch(e) {
      resultados[ep] = { ok: false, status: e.response?.status, msg: e.message };
    }
  }
  res.json(resultados);
});

// ── Debug: estrutura de usuários/setores ─────────────────────────
// ── Endpoint: busca usuários com grupo_permissao e popula mapa setor
app.get('/api/usuarios-setores', async (_req, res) => {
  try {
    // Busca atendimentos recentes para coletar IDs únicos de usuários
    const agora = new Date();
    const ini7  = new Date(agora.getTime() - 7*24*60*60*1000);
    const data  = await hubsoftPost('v1/atendimento/consultar/paginado/500?page=1', {
      data_inicio: ini7.toISOString(), data_fim: agora.toISOString()
    });
    const lista = data?.atendimentos?.data || data?.atendimento?.data || data?.data || [];
    // Coleta IDs únicos
    const idsMap = {};
    lista.forEach(a => {
      (a.usuarios_responsaveis || []).forEach(u => { if (u.id && u.name) idsMap[u.id] = u.name; });
      if (a.usuario_fechamento?.id) idsMap[a.usuario_fechamento.id] = a.usuario_fechamento.name;
    });
    // Retorna id + nome + setor (do mapeamento definitivo)
    const usuarios = Object.entries(idsMap)
      .map(([id, nome]) => ({ id: Number(id), nome, setor: SETOR_POR_ID[Number(id)] || SETOR_POR_NOME[nome] || '' }))
      .sort((a,b) => a.nome.localeCompare(b.nome));
    res.json({ ok: true, total: usuarios.length, usuarios });
  } catch(err) { res.status(500).json({ ok: false, erro: err.message }); }
});

app.get('/api/debug-usuarios', async (_req, res) => {
  try {
    // Try GET endpoints
    const getEps = [
      'v1/usuario', 'v1/usuario/listar', 'v1/usuario/consultar',
      'v1/funcionario', 'v1/funcionario/listar',
      'v1/acl/usuario', 'v1/acl/usuarios',
      'v1/configuracao/usuario', 'v1/configuracao/usuarios',
    ];
    // Try POST endpoints
    const postEps = [
      'v1/usuario/consultar/paginado/20?page=1',
      'v1/funcionario/consultar/paginado/20?page=1',
    ];
    const resultados = {};
    for (const ep of getEps) {
      try {
        const d = await hubsoftGet(ep, {});
        const lista = d.data || d.items || d || [];
        const primeiro = Array.isArray(lista) ? lista[0] : lista;
        resultados[`GET ${ep}`] = { ok: true, total: Array.isArray(lista) ? lista.length : 1, keys: primeiro ? Object.keys(primeiro) : [], primeiro };
      } catch(e) {
        resultados[`GET ${ep}`] = { ok: false, status: e.response?.status, erro: e.message };
      }
    }
    for (const ep of postEps) {
      try {
        const d = await hubsoftPost(ep, {});
        const lista = d.data || d.items || d.usuarios?.data || d.funcionarios?.data || d || [];
        const primeiro = Array.isArray(lista) ? lista[0] : lista;
        resultados[`POST ${ep}`] = { ok: true, total: Array.isArray(lista) ? lista.length : 1, keys: primeiro ? Object.keys(primeiro) : [], primeiro };
      } catch(e) {
        resultados[`POST ${ep}`] = { ok: false, status: e.response?.status, erro: e.message };
      }
    }
    res.json(resultados);
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Resumo / KPIs do dia ──────────────────────────────────────────
app.get('/api/resumo', async (req, res) => {
  try {
    const data = await hubsoftPost('v1/ordem_servico/consultar/paginado/500?page=1', bodyConsultaOS());
    const todos = extrairLista(data);
    const st = o => normalizarStatus(o.status_ordem_servico || o.status);

    const resumo = {
      total:      todos.length,
      execucao:   todos.filter(o => st(o) === 'execucao').length,
      aguardando: todos.filter(o => st(o) === 'aguardando').length,
      atrasado:   todos.filter(o => st(o) === 'atrasado').length,
      finalizado: todos.filter(o => st(o) === 'finalizado').length,
      reagendado: todos.filter(o => st(o) === 'reagendado').length,
      retrabalho: todos.filter(o => (o.tipo_ordem_servico?.descricao || '').toLowerCase().includes('retrabalho')).length,
      sincronizado_em: new Date().toISOString(),
    };
    res.json({ ok: true, resumo });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  FUNÇÕES AUXILIARES
// ════════════════════════════════════════════════════════════════

// Mapeia status do Hubsoft → status do dashboard
function normalizarStatus(status) {
  if (!status) return 'aguardando';
  const s = status.toLowerCase();
  if (s.includes('execu') || s.includes('andamento') || s.includes('iniciado')) return 'execucao';
  if (s.includes('conclu') || s.includes('finaliz') || s.includes('fechado') || s.includes('remov')) return 'finalizado';
  if (s.includes('atraso') || s.includes('vencido') || s.includes('prazo')) return 'atrasado';
  if (s.includes('reagend') || s.includes('remarca') || s.includes('agendamento')) return 'reagendado';
  if (s.includes('retrabalho')) return 'retrabalho';
  if (s.includes('aguard') || s.includes('pendente') || s.includes('aberto')) return 'aguardando';
  return 'aguardando';
}

// Mapeia nome do tipo de OS → categoria do dashboard
function normalizarTipo(nome) {
  if (!nome) return null;
  const n = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (n.includes('instal'))                                                          return 'instalacao';
  if (n.includes('retrabalho'))                                                      return 'retrabalho';
  if (n.includes('reparo') || n.includes('manuten') || n.includes('troca') || n.includes('conser')) return 'reparo';
  if (n.includes('remoc') || n.includes('cancelam') || n.includes('retirad'))       return 'remocao';
  if (n.includes('mudan') || n.includes('migra') || (n.includes('trans') && n.includes('ender'))) return 'mudanca';
  // Gera slug do nome real — nunca retorna 'outros'
  const slug = n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return slug || null;
}

function formatarHora(datetime) {
  if (!datetime) return '--:--';
  try {
    const d = new Date(datetime);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return '--:--'; }
}

// ════════════════════════════════════════════════════════════════
//  ROTAS — iCloud CalDAV Agenda
// ════════════════════════════════════════════════════════════════

// GET /api/agenda/debug-caldav → diagnóstico de autenticação CalDAV
app.get('/api/agenda/debug-caldav', async (req, res) => {
  if (!APPLE_ID || !APPLE_APP_PASSWORD) return res.json({ ok:false, erro:'nao_configurado', APPLE_ID: !!APPLE_ID, APPLE_APP_PASSWORD: !!APPLE_APP_PASSWORD });
  const auth = `Basic ${Buffer.from(`${APPLE_ID}:${APPLE_APP_PASSWORD}`).toString('base64')}`;
  const UA = 'OPS360/1.0 (Node.js; CalDAV Client)';
  const urls = ['https://caldav.icloud.com/', 'https://caldav.icloud.com/.well-known/caldav'];
  const results = {};
  for (const url of urls) {
    try {
      const r = await axios({
        method:'PROPFIND', url,
        data:'<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
        headers:{ Authorization:auth, 'Content-Type':'application/xml; charset=utf-8', 'User-Agent':UA, Depth:'0' },
        validateStatus:()=>true, maxRedirects:10,
      });
      results[url] = { status: r.status, headers: r.headers, body: String(r.data).slice(0,500) };
    } catch(e) { results[url] = { error: e.message }; }
  }
  res.json({ ok:true, APPLE_ID_SET: !!APPLE_ID, results });
});

// GET /api/agenda/eventos?mes=2026-03  → lista eventos do mês
app.get('/api/agenda/eventos', async (req, res) => {
  try {
    const { auth, baseUrl, calPath } = await getCaldavInfo();
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const [ano, mo] = mes.split('-').map(Number);
    const inicio = new Date(ano, mo-1, 1);
    const fim    = new Date(ano, mo,   1);
    const fmtD   = d => icsDateTime(d).slice(0,8);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmtD(inicio)}T000000Z" end="${fmtD(fim)}T000000Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
    const r = await axios({
      method:'REPORT', url:`${baseUrl}${calPath}`,
      data: body,
      headers:{ Authorization:auth, 'Content-Type':'application/xml; charset=utf-8', Depth:'1' },
      validateStatus:()=>true,
    });
    // Extrai blocos BEGIN:VCALENDAR de cada resposta
    const icsBlocks = [...(r.data||'').matchAll(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g)].map(m=>m[0]);
    const eventos = icsBlocks.flatMap(b => parseICS(b));
    res.json({ ok:true, eventos });
  } catch(err) {
    const msg = err.message;
    if (msg === 'nao_configurado') return res.status(503).json({ ok:false, erro:'nao_configurado' });
    console.error('[CalDAV eventos]', msg);
    res.status(500).json({ ok:false, erro: msg });
  }
});

// POST /api/agenda/criar  { titulo, inicio, fim?, descricao?, local? }
app.post('/api/agenda/criar', async (req, res) => {
  try {
    const { auth, baseUrl, calPath } = await getCaldavInfo();
    const ev = req.body;
    if (!ev.titulo || !ev.inicio) return res.status(400).json({ ok:false, erro:'titulo e inicio são obrigatórios' });
    const { ics, uid } = buildICS(ev);
    const url = `${baseUrl}${calPath}${uid}.ics`;
    const r = await axios({
      method:'PUT', url,
      data: ics,
      headers:{ Authorization:auth, 'Content-Type':'text/calendar; charset=utf-8', 'If-None-Match':'*' },
      validateStatus:()=>true,
    });
    if (r.status >= 200 && r.status < 300) {
      res.json({ ok:true, uid });
    } else {
      res.status(r.status).json({ ok:false, erro:`CalDAV respondeu ${r.status}`, body: r.data });
    }
  } catch(err) {
    const msg = err.message;
    if (msg === 'nao_configurado') return res.status(503).json({ ok:false, erro:'nao_configurado' });
    console.error('[CalDAV criar]', msg);
    res.status(500).json({ ok:false, erro: msg });
  }
});

// DELETE /api/agenda/deletar/:uid
app.delete('/api/agenda/deletar/:uid', async (req, res) => {
  try {
    const { auth, baseUrl, calPath } = await getCaldavInfo();
    const uid = req.params.uid;
    const url = `${baseUrl}${calPath}${uid}.ics`;
    const r = await axios({
      method:'DELETE', url,
      headers:{ Authorization:auth },
      validateStatus:()=>true,
    });
    if (r.status === 204 || r.status === 200) {
      res.json({ ok:true });
    } else if (r.status === 404) {
      res.status(404).json({ ok:false, erro:'Evento não encontrado' });
    } else {
      res.status(r.status).json({ ok:false, erro:`CalDAV respondeu ${r.status}` });
    }
  } catch(err) {
    const msg = err.message;
    if (msg === 'nao_configurado') return res.status(503).json({ ok:false, erro:'nao_configurado' });
    console.error('[CalDAV deletar]', msg);
    res.status(500).json({ ok:false, erro: msg });
  }
});

// ═══════════════════════════════════════════════════════════════
//  TAREFAS — Persistência, ICS, Email, WhatsApp
// ═══════════════════════════════════════════════════════════════

const fs         = require('fs');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');

const TASKS_FILE = path.join(__dirname, 'data', 'tasks.json');

async function loadTasks() {
  // Tenta DB primeiro, fallback arquivo
  const raw = await kvGet('tasks');
  if (raw) { try { return JSON.parse(raw); } catch {} }
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}
async function saveTasks(tasks) {
  const json = JSON.stringify(tasks, null, 2);
  await kvSet('tasks', json);
  // backup local
  try { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive:true }); fs.writeFileSync(TASKS_FILE, json); } catch {}
}

// ── CRUD ─────────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => res.json(await loadTasks()));

app.post('/api/tasks', async (req, res) => {
  const tasks = await loadTasks();
  const t = { ...req.body, id: Date.now().toString(), done: false, createdAt: new Date().toISOString() };
  tasks.push(t);
  await saveTasks(tasks);
  res.json(t);
});

app.put('/api/tasks/:id', async (req, res) => {
  const tasks = await loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  tasks[idx] = { ...tasks[idx], ...req.body };

  // Auto-criar próxima ocorrência ao concluir tarefa recorrente
  let _proximaTarefa = null;
  const rec = tasks[idx].recorrencia;
  if (req.body.done === true && rec && rec !== '') {
    const base = tasks[idx].dueAt ? new Date(tasks[idx].dueAt) : new Date();
    const next = new Date(base);
    if      (rec === 'diaria')  next.setDate(next.getDate() + 1);
    else if (rec === 'semanal') next.setDate(next.getDate() + 7);
    else if (rec === 'mensal')  next.setMonth(next.getMonth() + 1);
    else if (rec === 'anual')   next.setFullYear(next.getFullYear() + 1);
    const pad = n => String(n).padStart(2, '0');
    const nextStr = `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
    _proximaTarefa = { ...tasks[idx], id: Date.now().toString(), done: false, createdAt: new Date().toISOString(), dueAt: nextStr };
    tasks.push(_proximaTarefa);
  }

  await saveTasks(tasks);
  res.json({ ...tasks[idx], _proximaTarefa });
});

app.delete('/api/tasks/:id', async (req, res) => {
  let tasks = await loadTasks();
  tasks = tasks.filter(t => t.id !== req.params.id);
  await saveTasks(tasks);
  res.json({ ok: true });
});

// ── Configurações de notificação (em memória / env) ───────────────
function getNotifConfig() {
  return {
    email:       process.env.NOTIF_EMAIL       || '',
    smtpUser:    process.env.SMTP_USER         || '',
    smtpPass:    process.env.SMTP_PASS         || '',
    smtpHost:    process.env.SMTP_HOST         || 'smtp.gmail.com',
    smtpPort:    parseInt(process.env.SMTP_PORT||'587'),
    waPhone:     process.env.WA_PHONE          || '',  // ex: 5511999999999
    waApiKey:    process.env.WA_CALLMEBOT_KEY  || '',
  };
}

app.get('/api/notif-config', (req, res) => {
  const c = getNotifConfig();
  res.json({
    emailConfigured: !!(c.smtpUser && c.smtpPass),
    waConfigured:    !!(c.waPhone && c.waApiKey),
    email: c.email,
    waPhone: c.waPhone,
  });
});

// ── Email ─────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const c = getNotifConfig();
  if (!c.smtpUser || !c.smtpPass || !c.email) return false;
  const transporter = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465,
    auth: { user: c.smtpUser, pass: c.smtpPass },
  });
  await transporter.sendMail({ from: c.smtpUser, to: c.email, subject, html });
  return true;
}

// ── WhatsApp via CallMeBot ────────────────────────────────────────
async function sendWhatsApp(message) {
  const c = getNotifConfig();
  if (!c.waPhone || !c.waApiKey) return false;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${c.waPhone}&text=${encodeURIComponent(message)}&apikey=${c.waApiKey}`;
  await axios.get(url, { timeout: 8000 });
  return true;
}

// ── Endpoint para testar notificações ────────────────────────────
app.post('/api/tasks/test-notif', async (req, res) => {
  const { type } = req.body;
  try {
    if (type === 'email') {
      await sendEmail('✅ OPS360 — Teste de notificação',
        '<h2>Notificação de email funcionando!</h2><p>Suas tarefas serão enviadas por aqui.</p>');
      return res.json({ ok: true });
    }
    if (type === 'whatsapp') {
      await sendWhatsApp('✅ OPS360: Notificações WhatsApp ativadas!');
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'type inválido' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ICS Calendar feed (iPhone assina esta URL) ────────────────────
app.get('/api/tasks/calendar.ics', (req, res) => {
  const tasks = loadTasks().filter(t => !t.done && t.dueAt);
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
  const host  = req.get('host') || 'ops360.railway.app';

  const events = tasks.map(t => {
    const due   = new Date(t.dueAt);
    const start = due.toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
    const end   = new Date(due.getTime() + 30*60000).toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
    const alarm = t.notifyMin || 15;
    return [
      'BEGIN:VEVENT',
      `UID:ops360-${t.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${(t.title||t.t||'Tarefa').replace(/[,;]/g,' ')}`,
      `DESCRIPTION:${(t.tag||'')+(t.desc?' — '+t.desc:'')}`,
      `CATEGORIES:${t.tag||'Tarefas'}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:Lembrete: ${(t.title||t.t||'Tarefa')}`,
      `TRIGGER:-PT${alarm}M`,
      'END:VALARM',
      'END:VEVENT',
    ].join('\r\n');
  }).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OPS360//Tarefas//PT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:OPS360 Tarefas`,
    'X-WR-TIMEZONE:America/Sao_Paulo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    events,
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ops360-tarefas.ics"');
  res.send(ics);
});

// ── Cron: verifica tarefas e envia alertas ────────────────────────
const notifSent = new Set(); // evita enviar duplicado na mesma janela

cron.schedule('* * * * *', async () => {
  const tasks = loadTasks();
  const now   = Date.now();

  for (const t of tasks) {
    if (t.done || !t.dueAt) continue;
    const due     = new Date(t.dueAt).getTime();
    const diffMin = Math.round((due - now) / 60000);
    const alarm   = t.notifyMin || 15;

    // Avisa quando falta exatamente `alarm` minutos (janela ±1 min)
    if (Math.abs(diffMin - alarm) > 1) continue;

    const key = `${t.id}-${alarm}`;
    if (notifSent.has(key)) continue;
    notifSent.add(key);

    const titulo  = t.title || t.t || 'Tarefa';
    const hora    = new Date(t.dueAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });
    const msg     = `⏰ OPS360 — Lembrete: *${titulo}* às ${hora} (em ${alarm} min)`;

    if (t.notifEmail !== false) sendEmail(`⏰ Lembrete: ${titulo}`,
      `<h3>Lembrete de tarefa</h3><p><b>${titulo}</b></p><p>Prevista para <b>${hora}</b></p><p>Categoria: ${t.tag||'—'}</p>`
    ).catch(console.error);

    if (t.notifWA !== false) sendWhatsApp(msg).catch(console.error);
  }

  // Limpa chaves antigas após 2h
  if (notifSent.size > 500) notifSent.clear();
});

// ── DEBUG: estrutura de endereço/geo de uma OS real ──────────────
app.get('/api/geo/debug', async (req, res) => {
  try {
    const agora = new Date();
    const ini7  = new Date(agora.getTime() - 7 * 86400000);
    const body  = {
      data_inicio: ini7.toISOString(), data_fim: agora.toISOString(),
      status_ordem_servico: ['finalizado','em_execucao','em_andamento'],
      order_by: 'data_inicio_programado', order_by_key: 'DESC',
      agendas:[], bairros:null, cidades:[], condominios:null, grupos_clientes:[],
      grupos_clientes_servicos:[], motivo_fechamento:[], participantes:[],
      periodos:[], pop:[], prioridade:[], reservada:null, servico:[], servico_status:[], tecnicos:[],
    };
    const r = await hubsoftPost('v1/ordem_servico/consultar/paginado/3?page=1', body);
    const lista = extrairLista(r);
    if (!lista.length) return res.json({ ok: false, msg: 'Nenhuma OS encontrada' });

    // Pega a primeira OS e expõe campos de endereço e assinante
    const os  = lista[0];
    const cs  = os.atendimento?.cliente_servico;
    const end = cs?.endereco_instalacao || {};
    const token = await getToken();
    const cliId = cs?.cliente?.id || cs?.cliente_id;
    let assinante = null;
    if (cliId) {
      try {
        const ra = await axios.get(`${HUBSOFT_HOST}/api/v1/cliente/${cliId}/assinante`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 });
        assinante = ra.data;
      } catch(e) { assinante = { erro: e.message }; }
    }

    res.json({
      ok: true,
      cliente_id: cliId,
      endereco_instalacao_keys: Object.keys(end),
      endereco_instalacao: end,
      atendimento_endereco: os.atendimento?.endereco || null,
      cliente_raw: cs?.cliente || null,
      assinante_raw: assinante,
      // campos de topo da OS pra ver se tem lat/lng direto
      os_keys: Object.keys(os),
    });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ── CONEXÕES — Status online/offline de clientes ──────────────────
const offlineAlertSent = new Set(); // evita alertas duplicados

// Busca status de assinante por ID individual: GET /api/v1/cliente/{id}/assinante
async function getClienteAssinante(token, clienteId) {
  try {
    const r = await axios.get(`${HUBSOFT_HOST}/api/v1/cliente/${clienteId}/assinante`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 5000,
    });
    return r.data; // { status:'online'|'offline', ... }
  } catch { return null; }
}

// Debug: amostra bruta do endpoint integracao para diagnosticar campos
app.get('/api/integracao/raw', async (req, res) => {
  try {
    const token   = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/cliente/todos`, {
      headers,
      params: { itens_por_pagina: 3, pagina: 0, cancelado: 'nao',
                relacoes: 'status_conexao,ultima_conexao,assinante,endereco_instalacao' },
      timeout: 15000,
    });
    const clientes = r.data?.clientes || [];
    // Retorna estrutura completa dos primeiros 3 clientes para diagnóstico
    const amostra = clientes.slice(0, 3).map(c => ({
      id: c.id_cliente, nome: c.nome_razaosocial,
      keys_cli: Object.keys(c),
      servicos: (c.servicos || []).slice(0, 1).map(s => ({
        keys_svc: Object.keys(s),
        status_conexao: s.status_conexao,
        ultima_conexao: s.ultima_conexao,
        assinante: s.assinante,
        ipv4: s.ipv4,
        endereco_instalacao: s.endereco_instalacao,
      })),
    }));
    res.json({ ok: true, paginacao: r.data?.paginacao, amostra, raw_first: clientes[0] });
  } catch(e) {
    res.json({ ok: false, motivo: e.message, status: e.response?.status });
  }
});

// ── Cache de conexões (evita timeout: endpoint devolve cache instantâneo) ──
let _cxCache      = null;  // { clientes, cidades, ts }
let _cxFetching   = false; // lock para evitar fetch paralelo
const _offlineInicioMap = new Map(); // id_cliente -> timestamp quando detectado offline pela primeira vez

const CIDADES_EXCLUIDAS = ['SANTO ANTÔNIO DO MONTE'];

function buildCidadeMap(clientes) {
  const cidadeMap = {};
  for (const c of clientes) {
    if (CIDADES_EXCLUIDAS.includes((c.cidade || '').toUpperCase())) continue;
    if (!cidadeMap[c.cidade]) cidadeMap[c.cidade] = { nome: c.cidade, online: 0, offline: 0, lat: null, lng: null };
    if (c.online) cidadeMap[c.cidade].online++;
    else          cidadeMap[c.cidade].offline++;
    if (c.lat && !cidadeMap[c.cidade].lat) { cidadeMap[c.cidade].lat = c.lat; cidadeMap[c.cidade].lng = c.lng; }
  }
  return Object.values(cidadeMap).sort((a, b) => b.offline - a.offline);
}

// Busca TODOS os clientes ativos e popula o cache
async function fetchConexoesHubsoft() {
  if (_cxFetching) return _cxCache?.clientes || null;
  _cxFetching = true;
  try {
    const token    = await getToken();
    // endereco_instalacao como relação traz coordenadas; ipv4 já vem por padrão no serviço
    const clientes = await fetchIntegracaoClientes(token, {
      cancelado: 'nao',
      relacoes:  'endereco_instalacao',
    });
    if (!clientes.length) { _cxFetching = false; return null; }

    const resultado = [];
    for (const cli of clientes) {
      const nome       = cli.nome_razaosocial || '—';
      const alerta     = cli.alerta === true;
      const alertaMsgs = cli.alerta_mensagens || [];
      const servicos   = cli.servicos || [];

      if (!servicos.length) {
        resultado.push({ id: cli.id_cliente, nome, cidade: cli.cidade || 'Desconhecida',
          lat: null, lng: null, online: false, alerta, alertaMsgs });
        continue;
      }
      // Verifica TODOS os serviços: se qualquer um tem IP válido, cliente está online
      let cidade = cli.cidade || 'Desconhecida';
      let lat = null, lng = null;
      let online = false;
      for (const s of servicos) {
        const endInst = s.endereco_instalacao || {};
        // Usa coordenadas e cidade do primeiro serviço que tiver
        if (lat === null && endInst.coordenadas?.latitude != null) {
          lat = parseFloat(endInst.coordenadas.latitude);
          lng = parseFloat(endInst.coordenadas.longitude);
        }
        if (endInst.cidade) cidade = endInst.cidade;
        // Online se qualquer serviço ativo tem IP válido
        const ip = s.ipv4 || '';
        if (ip !== '' && ip !== '0.0.0.0') online = true;
      }
      resultado.push({ id: cli.id_cliente, nome, cidade, lat, lng, online, alerta, alertaMsgs });
    }

    // Atualiza mapa de tempo offline
    const agora_cx = Date.now();
    for (const c of resultado) {
      if (!c.online) {
        if (!_offlineInicioMap.has(c.id)) _offlineInicioMap.set(c.id, agora_cx);
      } else {
        _offlineInicioMap.delete(c.id);
      }
    }

    const cidades = buildCidadeMap(resultado);
    _cxCache = { clientes: resultado, cidades, ts: new Date().toISOString() };
    dbCacheSet('cache:conexoes', { cidades, ts: _cxCache.ts }); // persiste resumo no banco (sem clientes raw)
    console.log(`[conexoes] Cache atualizado: ${resultado.length} clientes, ${cidades.length} cidades`);
    _cxFetching = false;
    return resultado;
  } catch(e) {
    _cxFetching = false;
    throw e;
  }
}

app.get('/api/conexoes', async (req, res) => {
  try {
    // Serve o cache se disponível (resposta < 100ms)
    if (_cxCache) {
      return res.json({ ok: true, clientes: _cxCache.clientes.length,
        cidades: _cxCache.cidades, ts: _cxCache.ts, cache: true });
    }
    // Primeira chamada: busca agora (pode demorar)
    const clientes = await fetchConexoesHubsoft();
    if (!clientes) {
      return res.json({ ok: false, motivo: 'sem_clientes_na_base', clientes: [], cidades: [],
        info: 'Nenhum cliente ativo encontrado.' });
    }
    res.json({ ok: true, clientes: clientes.length, cidades: _cxCache.cidades, ts: _cxCache.ts });
  } catch(e) {
    console.error('[/api/conexoes]', e.message);
    // Se há cache antigo, usa mesmo assim
    if (_cxCache) {
      return res.json({ ok: true, clientes: _cxCache.clientes.length,
        cidades: _cxCache.cidades, ts: _cxCache.ts, cache: true, aviso: 'cache_antigo' });
    }
    res.json({ ok: false, motivo: e.message, clientes: [], cidades: [] });
  }
});

// ── FINANCEIRO ───────────────────────────────────────────────────
let _finCache    = null;
let _finFetching = false;
let _finFetchedAt = 0;
const FIN_CACHE_TTL = 30 * 60 * 1000; // 30 min

function parseDate(s) {
  if (!s) return null;
  // Formato brasileiro DD/MM/YYYY ou DD/MM/YYYY HH:mm
  const brMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brMatch) {
    const d = new Date(`${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function mesesEntre(d1, d2) {
  if (!d1 || !d2) return 0;
  return Math.max(0, (d2 - d1) / (1000 * 60 * 60 * 24 * 30.44));
}
function fmtTempoFin(meses) {
  if (meses < 1) return `${Math.round(meses * 30)} dias`;
  if (meses < 12) return `${Math.round(meses)} meses`;
  const anos = Math.floor(meses / 12);
  const m    = Math.round(meses % 12);
  return m > 0 ? `${anos}a ${m}m` : `${anos} ano${anos > 1 ? 's' : ''}`;
}
function getVendedorFin(s) {
  const v = s.vendedor;
  return typeof v === 'string' ? v : (v?.nome || v?.name || '—');
}
function getCidadeFin(s) {
  const end = typeof s.endereco_instalacao === 'object' && s.endereco_instalacao ? s.endereco_instalacao : {};
  return end.cidade || '—';
}

async function buildFinanceiro() {
  // Reutiliza cache comercial de clientes ativos (15k+)
  let ativos = _comAllClientes;
  if (!ativos) {
    const token = await getToken();
    ativos = await fetchIntegracaoClientes(token, { cancelado: 'nao', relacoes: 'endereco_instalacao' });
    _comAllClientes = ativos;
  }

  const agora          = new Date();
  const mesAtualIni    = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const mesAnteriorIni = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const mesAnteriorFim = new Date(agora.getFullYear(), agora.getMonth(), 0, 23, 59, 59);
  const h60            = new Date(agora.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Datas em string para os filtros de cancelamento
  const _dfmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const mesAtualIniStr = _dfmt(mesAtualIni);
  const mesAtualFimStr = _dfmt(new Date(agora.getFullYear(), agora.getMonth()+1, 0));
  const mesAntIniStr   = _dfmt(mesAnteriorIni);
  const mesAntFimStr   = _dfmt(mesAnteriorFim);

  // Status que representam suspensão real (Hubsoft)
  // 'servico_bloqueado' removido — Hubsoft não o conta como "Suspenso" no dashboard
  const STATUS_SUSPENSO   = new Set(['suspenso_debito','suspenso_pedido_cliente','bloqueio_temporario','suspenso_judicial']);
  const STATUS_PARCIAL    = new Set(['suspenso_parcialmente','suspenso_parcial','bloqueio_parcial']);
  const STATUS_IGNORADOS  = new Set(['aguardando_instalacao','em_instalacao','aguardando_ativacao','prospecto']);

  // ── Análise: clientes ativos ──────────────────────────────────
  const suspensos     = [];
  const parciaisSusp  = [];   // parcialmente suspensos
  const novosSusp     = [];   // primeira mensalidade não paga
  const novos60d      = [];   // todos os novos (denominador)
  const ltvCandidates = [];
  const mrr           = { total: 0, suspenso: 0, parcial: 0 };
  const vendMapAtivo  = {};
  let mrrNovo         = 0;
  let mrrNovoAnt      = 0;
  let mrrRecupAtual   = 0;
  let mrrRecupAnt     = 0;
  let novoAtual       = 0;
  let novoAnt         = 0;
  let reativAtual     = 0;
  let reativAnt       = 0;

  for (const cli of ativos) {
    const nome     = cli.nome_razaosocial || cli.nome_fantasia || '—';
    const dataCadCli = parseDate(cli.data_cadastro);

    for (const s of (cli.servicos || [])) {
      const status   = s.status_prefixo || '';
      const valor    = parseFloat(s.valor) || 0;
      const vendedor = getVendedorFin(s);
      const cidade   = getCidadeFin(s);
      const plano    = s.nome || '—';
      const dataHab  = parseDate(s.data_habilitacao);
      const isOn     = status === 'servico_habilitado';
      const isCan    = !!s.data_cancelamento;
      const isIgn    = STATUS_IGNORADOS.has(status);
      const isSusp   = STATUS_SUSPENSO.has(status);
      const isParcial = STATUS_PARCIAL.has(status);

      if (isOn && valor > 0)      mrr.total   += valor;
      if (isSusp && valor > 0)    mrr.suspenso += valor;
      if (isParcial && valor > 0) mrr.parcial  += valor;


      if (isSusp) {
        suspensos.push({ nome, plano, valor, cidade, vendedor, status, dataHab: s.data_habilitacao });
      }
      if (isParcial) {
        parciaisSusp.push({ nome, plano, valor, cidade, vendedor, status, dataHab: s.data_habilitacao });
      }

      // LTV: usa data_habilitacao do serviço ativo (não data_cadastro do cliente)
      // Evita puxar data de serviço cancelado ou data_cadastro desatualizada
      // Remove !isCan: serviço reativado pode ter data_cancelamento do passado mas status ativo agora
      if ((isOn || isSusp || isParcial) && dataHab) {
        const m = mesesEntre(dataHab, agora);
        // Converte para ISO YYYY-MM-DD (data_habilitacao vem em DD/MM/YYYY do Hubsoft)
        const _dh = dataHab;
        const dataCadISO = `${_dh.getFullYear()}-${String(_dh.getMonth()+1).padStart(2,'0')}-${String(_dh.getDate()).padStart(2,'0')}`;
        ltvCandidates.push({
          nome, cidade, plano, valor,
          dataCad:    dataCadISO,
          mesesAtivo: Math.round(m * 10) / 10,
          ltvDinheiro: Math.round(m * valor),
          tempoFmt:    fmtTempoFin(m),
          statusTipo: isSusp ? 'suspenso' : isParcial ? 'parcial' : 'ativo',
        });
      }

      if (dataHab && dataHab >= h60 && !isIgn) {
        const obj = { nome, plano, valor, cidade, vendedor, dataHab: s.data_habilitacao, status };
        novos60d.push(obj);
        if (isSusp || isParcial) novosSusp.push(obj);
      }

      // vendedor health
      if (!vendMapAtivo[vendedor]) vendMapAtivo[vendedor] = { vendedor, ativos: 0, suspensos: 0, parciais: 0, mrr: 0 };
      if (isOn)        { vendMapAtivo[vendedor].ativos++;   vendMapAtivo[vendedor].mrr += valor; }
      else if (isSusp)   vendMapAtivo[vendedor].suspensos++;
      else if (isParcial) vendMapAtivo[vendedor].parciais++;
    }
  }

  ltvCandidates.sort((a, b) => new Date(a.dataCad) - new Date(b.dataCad));

  // MRR Novo e Recuperado — mesma lógica do comercial (data_venda como referência, sem filtro isOn)
  // Garante que os números batem exatamente com a aba Comercial
  {
    const _iniAtMs  = mesAtualIni.getTime();
    const _iniAntMs = mesAnteriorIni.getTime();
    const _fimAntMs = mesAnteriorFim.getTime();
    const _seenMrr  = new Set();
    for (const cli of ativos) {
      const _nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
      for (const s of (cli.servicos || [])) {
        const _rawVenda = s.data_venda || null;
        const _venda    = _rawVenda ? parseDate(_rawVenda) : null;
        const _vendaMs  = _venda ? _venda.getTime() : 0;
        if (!_vendaMs) continue; // sem data_venda, não conta (igual ao comercial)
        const _chave = `${_nome}|${s.nome||''}|${_rawVenda}`;
        if (_seenMrr.has(_chave)) continue;
        _seenMrr.add(_chave);
        const _hab    = parseDate(s.data_habilitacao || null);
        const _habMs  = _hab ? _hab.getTime() : 0;
        const _valor  = parseFloat(s.valor) || 0;
        const _isCan  = !!(s.data_cancelamento || (s.status_prefixo||'').includes('cancelad') || (s.status_prefixo||'').includes('rescind'));
        const _isReat = !!(_habMs && _vendaMs && (_vendaMs - _habMs) > 30 * 86400 * 1000);
        if (_isCan) continue; // desistência — não conta em novo nem recuperado
        if (_vendaMs >= _iniAtMs) {
          if (_isReat) { mrrRecupAtual += _valor; reativAtual++; }
          else         { mrrNovo       += _valor; novoAtual++;   }
        } else if (_vendaMs >= _iniAntMs && _vendaMs <= _fimAntMs) {
          if (_isReat) { mrrRecupAnt += _valor; reativAnt++; }
          else         { mrrNovoAnt  += _valor; novoAnt++;   }
        }
      }
    }
  }

  // Primeira mensalidade por vendedor
  const primMap = {};
  for (const c of novos60d) {
    const v = c.vendedor || '—';
    if (!primMap[v]) primMap[v] = { vendedor: v, novos: 0, nao_pagou: 0, lista: [] };
    primMap[v].novos++;
    if (c.status !== 'servico_habilitado') {
      primMap[v].nao_pagou++;
      primMap[v].lista.push(c);
    }
  }

  // ── Análise: cancelados (mesmo método da aba Cancelamento/Retenção) ──────────
  // Busca com filtro nativo da API por data_cancelamento — garante consistência
  const token2 = await getToken();
  const [canAtualAtiv, canAtualCan, canAntAtiv, canAntCan] = await Promise.all([
    fetchIntegracaoClientes(token2, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: mesAtualIniStr, data_fim_cliente_servico: mesAtualFimStr, cancelado: 'nao' }, 30),
    fetchIntegracaoClientes(token2, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: mesAtualIniStr, data_fim_cliente_servico: mesAtualFimStr, cancelado: 'sim' }, 30),
    fetchIntegracaoClientes(token2, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: mesAntIniStr,   data_fim_cliente_servico: mesAntFimStr,   cancelado: 'nao' }, 30),
    fetchIntegracaoClientes(token2, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: mesAntIniStr,   data_fim_cliente_servico: mesAntFimStr,   cancelado: 'sim' }, 30),
  ]);

  // Cancelados all-time (histórico completo) para saúde da carteira por vendedor
  // Carregado em background independente — não bloqueia buildFinanceiro
  const canGeralList = _comAllCancelados || [];
  // Se vazio, dispara warm-up em background (não await)
  if (!_comAllCancelados && !_comAllCanceladosFetching) {
    _comAllCanceladosFetching = true;
    getToken().then(tk => fetchIntegracaoClientes(tk, { cancelado: 'sim' }, 200))
      .then(r => { _comAllCancelados = r; _comAllCanceladosAt = Date.now(); _comAllCanceladosFetching = false; })
      .catch(e => { _comAllCanceladosFetching = false; console.warn('[cancelados-geral] warm-up falhou:', e.message); });
  }

  const normFin = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const MOTIVOS_IGNORAR_FIN = ['desistencia da instalacao', 'habilitado o user errado', 'troca de titularidade'];
  const ignorarMotFin = m => { const n = normFin(m); return MOTIVOS_IGNORAR_FIN.some(p => n.includes(p)); };

  function filtrarCancelFin(clientesNao, clientesSim, iniStr, fimStr) {
    const iniMs = new Date(iniStr).getTime();
    const fimMs = new Date(fimStr + 'T23:59:59').getTime();
    const seen  = new Set();
    const lista = [];
    for (const cli of [...clientesNao, ...clientesSim]) {
      const nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
      for (const s of (cli.servicos || [])) {
        const dc = parseDate(s.data_cancelamento);
        if (!dc || dc.getTime() < iniMs || dc.getTime() > fimMs) continue;
        const motivoRaw = (s.motivo_cancelamento || '').trim();
        if (ignorarMotFin(motivoRaw)) continue;
        const chave = `${nome}|${s.nome||''}|${s.data_cancelamento||''}`;
        if (seen.has(chave)) continue;
        seen.add(chave);
        const dh    = parseDate(s.data_habilitacao);
        const valor = parseFloat(s.valor) || 0;
        const m     = mesesEntre(dh || dc, dc);
        lista.push({
          nome, motivo: motivoRaw || '—',
          vendedor: getVendedorFin(s), cidade: getCidadeFin(s),
          plano: s.nome || '—', valor,
          dataHab: s.data_habilitacao, dataCancelamento: s.data_cancelamento,
          mesesVida: Math.round(m * 10) / 10,
          ltvDinheiro: Math.round(m * valor),
          tempoFmt: fmtTempoFin(m),
        });
      }
    }
    return lista;
  }

  const cancelMesAtual    = filtrarCancelFin(canAtualAtiv, canAtualCan, mesAtualIniStr, mesAtualFimStr);
  const cancelMesAnterior = filtrarCancelFin(canAntAtiv,   canAntCan,   mesAntIniStr,  mesAntFimStr);

  function buildCancelStats(lista) {
    const porMotivo   = {};
    const porVendedor = {};
    lista.forEach(c => {
      porMotivo[c.motivo] = (porMotivo[c.motivo] || 0) + 1;
      if (!porVendedor[c.vendedor]) porVendedor[c.vendedor] = { vendedor: c.vendedor, n: 0, ltv: 0 };
      porVendedor[c.vendedor].n++;
      porVendedor[c.vendedor].ltv += c.ltvDinheiro;
    });

    // Filtra desistências de instalação dos cálculos de LTV e tempo médio
    const DESIST_KEYS = ['desistencia da instalacao', 'desistencia de instalacao'];
    const listaCalc = lista.filter(c => {
      const n = (c.motivo||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
      return !DESIST_KEYS.some(k => n.includes(k));
    });
    const ltv_medio_meses_calc = listaCalc.length
      ? listaCalc.reduce((s,c) => s+c.mesesVida, 0) / listaCalc.length : 0;

    return {
      total:            lista.length,
      ltv_total:        listaCalc.reduce((s, c) => s + c.ltvDinheiro, 0),
      ltv_medio_dinheiro: listaCalc.length ? Math.round(listaCalc.reduce((s,c)=>s+c.ltvDinheiro,0)/listaCalc.length) : 0,
      ltv_medio_meses:  Math.round(ltv_medio_meses_calc * 10) / 10,
      ltv_medio_tempo:  fmtTempoFin(ltv_medio_meses_calc),
      valor_mensal_perdido: Math.round(lista.reduce((s, c) => s + c.valor, 0) * 100) / 100,
      por_motivo:  Object.entries(porMotivo).sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
      por_vendedor: Object.values(porVendedor).sort((a, b) => b.n - a.n),
      lista:       lista.slice(0, 100),
    };
  }

  // Saúde por vendedor (add cancelamentos 60d)
  [...cancelMesAtual, ...cancelMesAnterior].forEach(c => {
    if (!vendMapAtivo[c.vendedor]) vendMapAtivo[c.vendedor] = { vendedor: c.vendedor, ativos: 0, suspensos: 0, parciais: 0, mrr: 0 };
    vendMapAtivo[c.vendedor].cancelados60d = (vendMapAtivo[c.vendedor].cancelados60d || 0) + 1;
  });

  // Cancelados gerais (all-time) por vendedor — conta apenas serviços com data_cancelamento preenchida
  {
    const seenGeral = new Set();
    for (const cli of canGeralList) {
      const nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
      for (const s of (cli.servicos || [])) {
        if (!s.data_cancelamento) continue;
        const chave = `${nome}|${s.nome||''}|${s.data_cancelamento}`;
        if (seenGeral.has(chave)) continue;
        seenGeral.add(chave);
        const v = getVendedorFin(s);
        if (!vendMapAtivo[v]) vendMapAtivo[v] = { vendedor: v, ativos: 0, suspensos: 0, parciais: 0, mrr: 0 };
        vendMapAtivo[v].cancelados_geral = (vendMapAtivo[v].cancelados_geral || 0) + 1;
      }
    }
  }

  const porVendedor = Object.values(vendMapAtivo)
    .filter(v => v.vendedor && v.vendedor !== '—')
    .map(v => ({
      ...v,
      cancelados60d:    v.cancelados60d || 0,
      cancelados_geral: v.cancelados_geral || 0,
      parciais:         v.parciais || 0,
      mrr:              Math.round(v.mrr * 100) / 100,
      pct_saude:        (v.ativos + v.suspensos + (v.parciais || 0)) > 0
        ? Math.round(v.ativos / (v.ativos + v.suspensos + (v.parciais || 0)) * 100) : 0,
    }))
    .sort((a, b) => b.ativos - a.ativos);

  return {
    ok: true,
    resumo: {
      mrr_total:           Math.round(mrr.total * 100) / 100,
      mrr_suspenso:        Math.round(mrr.suspenso * 100) / 100,
      mrr_parcial:         Math.round(mrr.parcial * 100) / 100,
      mrr_novo:            Math.round(mrrNovo * 100) / 100,
      mrr_novo_anterior:   Math.round(mrrNovoAnt * 100) / 100,
      novo_mes_atual:      novoAtual,
      novo_mes_anterior:   novoAnt,
      mrr_perdido:         Math.round(cancelMesAtual.reduce((s,c) => s + c.valor, 0) * 100) / 100,
      mrr_recup_atual:     Math.round(mrrRecupAtual * 100) / 100,
      mrr_recup_anterior:  Math.round(mrrRecupAnt * 100) / 100,
      reativ_mes_atual:    reativAtual,
      reativ_mes_anterior: reativAnt,
      total_ativos:        ativos.length,
      total_suspensos:     suspensos.length,
      total_parciais:      parciaisSusp.length,
      pct_suspensos:       ativos.length > 0 ? Math.round(suspensos.length / ativos.length * 1000) / 10 : 0,
      churn_mes_atual:     cancelMesAtual.length,
      churn_mes_anterior:  cancelMesAnterior.length,
      novos_60d:           novos60d.length,
      primeira_mens_risco: novosSusp.length,
      pct_primeira_mens:   novos60d.length > 0 ? Math.round(novosSusp.length / novos60d.length * 100) : 0,
    },
    suspensos:           suspensos.slice(0, 300).sort((a, b) => new Date(b.dataHab || 0) - new Date(a.dataHab || 0)),
    parciais:            parciaisSusp.slice(0, 100).sort((a, b) => new Date(b.dataHab || 0) - new Date(a.dataHab || 0)),
    ltv_top100:          ltvCandidates, // todos, agrupados por ano no frontend
    cancelamentos: {
      mes_atual:    buildCancelStats(cancelMesAtual),
      mes_anterior: buildCancelStats(cancelMesAnterior),
    },
    primeira_mensalidade: {
      total_novos:  novos60d.length,
      total_nao_pagou: novosSusp.length,
      pct:          novos60d.length > 0 ? Math.round(novosSusp.length / novos60d.length * 100) : 0,
      por_vendedor: Object.values(primMap)
        .map(v => ({ ...v, pct: v.novos > 0 ? Math.round(v.nao_pagou / v.novos * 100) : 0, lista: v.lista.slice(0, 20) }))
        .sort((a, b) => b.nao_pagou - a.nao_pagou),
      lista: novosSusp.slice(0, 100),
    },
    por_vendedor:        porVendedor,
    sincronizado_em:     new Date().toISOString(),
  };
}

// ── ADIÇÃO LÍQUIDA MENSAL ─────────────────────────────────────────────────────
let _alCache = null;
let _alFetchedAt = 0;
const AL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2h

const MOTIVOS_IGNORAR_AL = ['desistencia da instalacao', 'habilitado o user errado', 'troca de titularidade'];
const normAL = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const ignorarMotAL = m => { const n = normAL(m); return MOTIVOS_IGNORAR_AL.some(p => n.includes(p)); };

async function buildAdicaoLiquida() {
  const agora = new Date();
  const INICIO_ANO = 2025;
  const INICIO_MES = 0; // Janeiro
  const limiteAno = agora.getFullYear();
  const limiteMes = agora.getMonth();
  const _dfDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // Lista de meses a processar — inclui mês atual (parcial)
  const meses = [];
  for (let y = INICIO_ANO; y <= limiteAno; y++) {
    const mIni = (y === INICIO_ANO) ? INICIO_MES : 0;
    const mFim = (y === limiteAno) ? limiteMes : 11;
    for (let m = mIni; m <= mFim; m++) {
      const ini = new Date(y, m, 1);
      const isCurrent = y === limiteAno && m === limiteMes;
      const fim = isCurrent ? agora : new Date(y, m + 1, 0);
      meses.push({ ano: y, mes: m, iniStr: _dfDate(ini), fimStr: _dfDate(fim), label: ini.toLocaleString('pt-BR', {month:'short', year:'2-digit'}).replace('. ','/'), parcial: isCurrent });
    }
  }

  // Garante que o cache de clientes ativos está disponível
  if (!_comAllClientes) await warmupComercial();
  const token = await getToken();

  const NORM_MOTIVO_IGNORAR = ['desistencia da instalacao', 'habilitado o user errado', 'troca de titularidade'];

  // Processa meses em lotes de 3 para não sobrecarregar a API
  const resultados = [];
  for (let i = 0; i < meses.length; i += 3) {
    const lote = meses.slice(i, i + 3);
    const loteRes = await Promise.all(lote.map(async ({ ano, mes, iniStr, fimStr, label, parcial }) => {
      try {
        // Vendas (novas + reativações)
        const [cancelNao, cancelSim] = await Promise.all([
          fetchIntegracaoClientes(token, { tipo_data_cliente_servico: 'data_venda', data_inicio_cliente_servico: iniStr, data_fim_cliente_servico: fimStr, cancelado: 'nao' }, 10),
          fetchIntegracaoClientes(token, { tipo_data_cliente_servico: 'data_venda', data_inicio_cliente_servico: iniStr, data_fim_cliente_servico: fimStr, cancelado: 'sim' }, 10),
        ]);
        const vendas = buildVendasFromClientes([..._comAllClientes, ...cancelNao, ...cancelSim], iniStr, fimStr);
        const novas       = vendas.filter(v => !v.reativacao && !v.cancelado).length;
        const reativacoes = vendas.filter(v => v.reativacao && !v.cancelado).length;

        // Cancelamentos do mês (mesmo filtro da aba Cancelamento/Retenção)
        const [cNao, cSim] = await Promise.all([
          fetchIntegracaoClientes(token, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: iniStr, data_fim_cliente_servico: fimStr, cancelado: 'nao' }, 10),
          fetchIntegracaoClientes(token, { tipo_data_cliente_servico: 'data_cancelamento', data_inicio_cliente_servico: iniStr, data_fim_cliente_servico: fimStr, cancelado: 'sim' }, 10),
        ]);
        const iniMs = new Date(iniStr).getTime();
        const fimMs = new Date(fimStr + 'T23:59:59').getTime();
        const seen  = new Set();
        let cancelados = 0;
        const cancelLista = [];
        for (const cli of [...cNao, ...cSim]) {
          for (const s of (cli.servicos || [])) {
            const dc = parseDate(s.data_cancelamento);
            if (!dc || dc.getTime() < iniMs || dc.getTime() > fimMs) continue;
            if (ignorarMotAL(s.motivo_cancelamento)) continue;
            const chave = `${cli.nome_razaosocial||''}|${s.nome||''}|${s.data_cancelamento||''}`;
            if (seen.has(chave)) continue;
            seen.add(chave);
            cancelados++;
            cancelLista.push({ motivo_cancelamento: s.motivo_cancelamento, data_habilitacao: s.data_habilitacao, data_cancelamento: s.data_cancelamento });
          }
        }
        // Tempo médio de vida dos cancelados do mês (excluindo desistência de instalação)
        const DESIST_AL = ['desistencia da instalacao', 'desistencia de instalacao'];
        const normALfn  = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
        const cancelSemDesist = cancelLista.filter(c => !DESIST_AL.some(k => normALfn(c.motivo_cancelamento).includes(k)));
        let tempoMedioMeses = null;
        if (cancelSemDesist.length > 0) {
          const soma = cancelSemDesist.reduce((sum, s) => {
            const dh = parseDate(s.data_habilitacao);
            const dc = parseDate(s.data_cancelamento);
            if (!dh || !dc) return sum;
            return sum + mesesEntre(dh, dc);
          }, 0);
          tempoMedioMeses = soma / cancelSemDesist.length;
        }
        const adicao_liquida = novas + reativacoes - cancelados;
        return {
          ano, mes, iniStr, fimStr, label, parcial: parcial || false, novas, reativacoes, cancelados, adicao_liquida,
          tempo_medio_meses: tempoMedioMeses !== null ? Math.round(tempoMedioMeses * 10) / 10 : null,
          tempo_medio_fmt:   tempoMedioMeses !== null ? fmtTempoFin(tempoMedioMeses) : '—',
        };
      } catch(e) {
        const ini = new Date(ano, mes, 1);
        const lbl = ini.toLocaleString('pt-BR', {month:'short', year:'2-digit'}).replace('. ','');
        console.warn(`[adicao-liquida] Erro em ${iniStr}:`, e.message);
        return { ano, mes, iniStr, fimStr, label: lbl, parcial: parcial || false, novas: 0, reativacoes: 0, cancelados: 0, adicao_liquida: 0, erro: true };
      }
    }));
    resultados.push(...loteRes);
  }

  // Totais por ano
  const porAno = {};
  for (const r of resultados) {
    if (!porAno[r.ano]) porAno[r.ano] = { ano: r.ano, novas: 0, reativacoes: 0, cancelados: 0, adicao_liquida: 0, meses: 0 };
    porAno[r.ano].novas          += r.novas;
    porAno[r.ano].reativacoes    += r.reativacoes;
    porAno[r.ano].cancelados     += r.cancelados;
    porAno[r.ano].adicao_liquida += r.adicao_liquida;
    porAno[r.ano].meses++;
  }

  // Projeção 2026: média dos meses fechados de 2026 × 12 (exclui mês atual parcial)
  const meses2026 = resultados.filter(r => r.ano === 2026 && !r.parcial);
  let projecao2026 = null;
  if (meses2026.length > 0) {
    const mediaMensal = meses2026.reduce((s, r) => s + r.adicao_liquida, 0) / meses2026.length;
    const projetado   = Math.round(mediaMensal * 12);
    const acumulado   = meses2026.reduce((s, r) => s + r.adicao_liquida, 0);
    const restantes   = 12 - meses2026.length;
    const projetadoRestante = Math.round(mediaMensal * restantes);
    projecao2026 = {
      meses_fechados: meses2026.length,
      acumulado,
      media_mensal: Math.round(mediaMensal),
      projetado_anual: projetado,
      projetado_restante: projetadoRestante,
      estimativa_final: acumulado + projetadoRestante,
    };
  }

  return {
    ok: true,
    meses: resultados,
    por_ano: Object.values(porAno).sort((a, b) => a.ano - b.ano),
    projecao2026,
    gerado_em: new Date().toISOString(),
  };
}

app.get('/api/adicao-liquida', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const agora = Date.now();
    if (!force && _alCache && (agora - _alFetchedAt) < AL_CACHE_TTL) return res.json(_alCache);
    if (force) { _alCache = null; _alFetchedAt = 0; }
    if (!_comAllClientes) {
      warmupComercial().catch(console.warn);
      return res.json({ ok: false, motivo: 'cache_warmup', warming: true, info: 'Base de clientes sendo carregada. Tente em 60s.' });
    }
    const result  = await buildAdicaoLiquida();
    _alCache      = result;
    _alFetchedAt  = agora;
    res.json(result);
  } catch(e) {
    console.error('[/api/adicao-liquida]', e.message);
    if (_alCache) return res.json({ ..._alCache, aviso: e.message });
    res.json({ ok: false, motivo: e.message });
  }
});

app.get('/api/financeiro', async (req, res) => {
  try {
    const agora = Date.now();
    const force = req.query.force === '1';
    if (force) { _finCache = null; _finFetchedAt = 0; }

    // 1) Cache em memória fresco → retorna imediatamente
    if (!force && _finCache && (agora - _finFetchedAt) < FIN_CACHE_TTL) {
      return res.json(_finCache);
    }
    // 2) Cache no PostgreSQL fresco → retorna imediatamente
    if (!force) {
      const dbCached = await dbCacheGet('cache:financeiro', FIN_CACHE_TTL);
      if (dbCached) {
        _finCache = dbCached; _finFetchedAt = agora;
        return res.json({ ...dbCached, cache: 'db' });
      }
    }
    // 3) Cache expirado mas existe → retorna stale + rebuild em background (sem bloquear)
    if (_finCache && !_finFetching) {
      _finFetching = true;
      buildFinanceiro().then(r => {
        _finCache = r; _finFetchedAt = Date.now(); _finFetching = false;
        dbCacheSet('cache:financeiro', r);
        console.log('[financeiro] refresh em background OK');
      }).catch(e => { _finFetching = false; console.warn('[financeiro] bg refresh falhou:', e.message); });
      return res.json({ ..._finCache, cache: 'stale' });
    }
    // 4) Rebuild em andamento e tem cache antigo → retorna stale
    if (_finFetching && _finCache) return res.json({ ..._finCache, cache: 'stale' });
    // 5) Rebuild em andamento sem cache → aguarda
    if (_finFetching) {
      return res.json({ ok: false, motivo: 'carregando', info: 'Análise financeira em andamento. Aguarde ~30s.' });
    }
    // 6) Sem cache nenhum → dispara rebuild em background, responde imediatamente
    // NUNCA await buildFinanceiro() inline — demora 90-120s e estoura timeout Vercel (300s)
    _finFetching = true;
    buildFinanceiro().then(r => {
      _finCache = r; _finFetchedAt = Date.now(); _finFetching = false;
      dbCacheSet('cache:financeiro', r);
      console.log('[financeiro] primeiro build OK');
    }).catch(e => { _finFetching = false; console.warn('[financeiro] primeiro build falhou:', e.message); });
    return res.json({ ok: false, motivo: 'carregando', info: 'Análise financeira em andamento. Aguarde ~30s.' });
  } catch (e) {
    _finFetching = false;
    console.error('[/api/financeiro]', e.message);
    if (_finCache) return res.json({ ..._finCache, cache: true, aviso: e.message });
    res.json({ ok: false, motivo: e.message });
  }
});

// Cron: refresh chamados "hoje" a cada 15s (ao vivo)
setInterval(() => _refreshChamadosHoje().catch(console.warn), 15000);
// Dispara o primeiro refresh após 3s (após boot restore)
setTimeout(() => _refreshChamadosHoje().catch(console.warn), 3000);

// Cron: atualiza cache e detecta quedas (a cada 3 minutos)
const OFFLINE_THRESHOLD = parseInt(process.env.OFFLINE_THRESHOLD || '5');
cron.schedule('*/3 * * * *', async () => {
  try {
    const prevClientes = _cxCache?.clientes || [];
    const clientes = await fetchConexoesHubsoft(); // atualiza _cxCache
    if (!clientes) return;

    // Detecta quedas comparando com estado anterior
    const prev  = {};
    for (const c of prevClientes) {
      if (!prev[c.cidade]) prev[c.cidade] = { online: 0, offline: 0 };
      if (c.online) prev[c.cidade].online++; else prev[c.cidade].offline++;
    }
    const atual = {};
    for (const c of clientes) {
      if (!atual[c.cidade]) atual[c.cidade] = { online: 0, offline: 0 };
      if (c.online) atual[c.cidade].online++; else atual[c.cidade].offline++;
    }

    for (const [cidade, stats] of Object.entries(atual)) {
      const prevStats = prev[cidade] || { online: 0, offline: 0 };
      const deltaOff  = stats.offline - prevStats.offline;
      if (deltaOff >= OFFLINE_THRESHOLD) {
        const key = `${cidade}-${Math.floor(Date.now() / 600000)}`;
        if (!offlineAlertSent.has(key)) {
          offlineAlertSent.add(key);
          const alertas = clientes
            .filter(c => c.cidade === cidade && c.alertaMsgs?.length)
            .flatMap(c => c.alertaMsgs)
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 3);
          const alertaTxt = alertas.length ? `\n\n📋 *Hubsoft:*\n${alertas.join('\n')}` : '';
          const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
          const msg = `⚠️ OPS360 — ALERTA DE QUEDA\n*${deltaOff} clientes* ficaram offline em *${cidade}*\nOnline: ${stats.online} | Offline: ${stats.offline}\n🕐 ${hora}${alertaTxt}`;
          sendWhatsApp(msg).catch(console.error);
          console.log(`[ALERTA] Queda em ${cidade}: +${deltaOff} offline`);
        }
      }
    }
    if (offlineAlertSent.size > 200) offlineAlertSent.clear();
  } catch(e) {
    console.warn('[cron-conexoes]', e.message);
  }
});

// ── SAÚDE DA BASE ────────────────────────────────────────────────────────────
const STATUS_CONTRATO_SUSPENSO = new Set(['suspenso_debito','suspenso_pedido_cliente','bloqueio_temporario','suspenso_judicial']);
const STATUS_CONTRATO_PARCIAL  = new Set(['suspenso_parcialmente','suspenso_parcial','bloqueio_parcial']);

app.get('/api/saude-base', async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const agora = new Date();
    const agoraBRT = new Date(agora.getTime() - 3*60*60*1000);
    const dataFim = agoraBRT.toISOString().slice(0, 10);
    const dataIni = new Date(agoraBRT.getTime() - dias * 86400000).toISOString().slice(0, 10);

    // Busca OS do período
    const lista = await _fetchChamadosHubsoft(dataIni, dataFim, true);

    // Mapa de status de contrato (de _comAllClientes se disponível)
    const statusContratoMap = {};
    if (_comAllClientes) {
      for (const cli of _comAllClientes) {
        let sc = 'ativo';
        for (const s of (cli.servicos || [])) {
          const st = (s.status_servico || '').toLowerCase();
          if (STATUS_CONTRATO_SUSPENSO.has(st)) { sc = 'suspenso'; break; }
          if (STATUS_CONTRATO_PARCIAL.has(st))  { sc = 'parcial'; }
        }
        statusContratoMap[cli.id_cliente] = sc;
      }
    }

    // Agrupa OS por cliente com breakdown de categoria
    const LC_VIRTUAL = /^lc\s*virtual\s*net/i;
    const porCliente = {};
    for (const os of lista) {
      const cs    = os.atendimento?.cliente_servico;
      const idCli = cs?.cliente?.id_cliente || cs?.id_cliente;
      if (!idCli) continue;
      const nome  = cs?.display || cs?.cliente?.nome_razaosocial || cs?.nome_razaosocial || '—';
      if (LC_VIRTUAL.test(nome)) continue; // exclui LC Virtual Net (reparos de rede)
      const end    = cs?.endereco_instalacao;
      const cidade = end?.endereco_numero?.cidade?.nome || end?.cidade?.nome || end?.cidade?.display || cs?.cliente?.cidade?.nome || '—';
      const st     = normalizarStatus(os.status || '');
      const tipo   = os.tipo_ordem_servico?.descricao || '—';
      const cat    = normalizarTipo(tipo) || tipo;

      if (!porCliente[idCli]) porCliente[idCli] = { id: idCli, nome, cidade, osPend: 0, osFech: 0, categorias: {} };
      if (st === 'finalizado') porCliente[idCli].osFech++;
      else porCliente[idCli].osPend++;
      porCliente[idCli].categorias[cat] = (porCliente[idCli].categorias[cat] || 0) + 1;
    }

    // Status de conexão + tempo offline
    const cxClientes = _cxCache?.clientes || [];
    const cxMap = {};
    for (const c of cxClientes) cxMap[c.id] = c;

    // Inclui clientes offline/alerta sem OS
    for (const cx of cxClientes) {
      if (LC_VIRTUAL.test(cx.nome || '')) continue;
      if (!porCliente[cx.id] && (!cx.online || cx.alerta)) {
        porCliente[cx.id] = { id: cx.id, nome: cx.nome, cidade: cx.cidade, osPend: 0, osFech: 0, categorias: {} };
      }
    }

    const agora_ms = Date.now();
    const resultado = Object.values(porCliente).map(cli => {
      const cx         = cxMap[cli.id] || {};
      const online     = cx.online ?? true;
      const alerta     = cx.alerta || false;
      const desconexoes = (cx.alertaMsgs || []).length; // proxy para desconexões recentes
      const statusContrato = statusContratoMap[cli.id] || 'ativo';

      // Tempo offline em horas
      const offlineTs  = _offlineInicioMap.get(cli.id);
      const offlineHoras = (offlineTs && !online) ? Math.floor((agora_ms - offlineTs) / 3600000) : 0;

      // Score de saúde (0–100)
      let score = 100;
      score -= Math.min(cli.osPend * 20, 50);
      if (cli.osFech > 3) score -= Math.min((cli.osFech - 3) * 5, 15);
      if (!online) score -= 20;
      if (alerta)  score -= 10;
      if (desconexoes > 2) score -= Math.min((desconexoes - 2) * 5, 15);
      score = Math.max(0, Math.min(100, score));

      const status = score >= 80 ? 'normal' : score >= 50 ? 'atencao' : 'critico';
      return { ...cli, online, alerta, desconexoes, offlineHoras, statusContrato, score, status };
    });

    // Padrão: mais OS fechadas primeiro
    resultado.sort((a, b) => b.osFech - a.osFech);

    res.json({ ok: true, periodo: { dataIni, dataFim, dias }, total: resultado.length, clientes: resultado });
  } catch(e) {
    console.error('[/api/saude-base]', e.message);
    res.json({ ok: false, motivo: e.message });
  }
});

// ── FISCAL ─────────────────────────────────────────────────────────────────
let _fiscalCache = null; let _fiscalFetchedAt = 0;
const FISCAL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2h — dados históricos

async function fetchNfTipo(tipo, token, dataIni, dataFim) {
  // tipo: 'nfse' | 'telecom' | 'nfcom' | 'nfe' — pagina até 20 páginas (4000 itens)
  try {
    let todos = [];
    for (let p = 0; p < 20; p++) {
      const params = { tipo_data: 'data_emissao', data_inicio: dataIni, data_fim: dataFim, pagina: p, itens_por_pagina: 200 };
      if (tipo === 'telecom') params.modelo = '21';
      const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/nota_fiscal/${tipo}`, {
        headers: { Authorization: `Bearer ${token}` },
        params, timeout: 20000,
      });
      const arr = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.itens || r.data?.notas || []);
      todos = todos.concat(arr);
      if (arr.length < 200) break;
    }
    return { ok: true, itens: todos };
  } catch (e) {
    return { ok: false, erro: e.response?.status || e.message, itens: [] };
  }
}

app.get('/api/fiscal', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force && _fiscalCache && (Date.now() - _fiscalFetchedAt) < FISCAL_CACHE_TTL) return res.json(_fiscalCache);
    if (!force) {
      const dbF = await dbCacheGet('cache:fiscal', FISCAL_CACHE_TTL);
      if (dbF) {
        // Verifica formato novo (porMes com breakdown por tipo)
        const firstMes = Object.values(dbF.porMes || {})[0];
        if (firstMes && firstMes.nfse !== undefined) {
          _fiscalCache = dbF; _fiscalFetchedAt = Date.now(); return res.json({ ...dbF, cache: 'db' });
        }
        // Cache antigo sem breakdown — ignora e reconstrói
        console.log('[fiscal] cache antigo detectado, reconstruindo...');
      }
    }
    const token = await getToken();
    // Período: Jan 2025 → hoje (BRT)
    const agora = new Date();
    const agoraBRT = new Date(agora.getTime() - 3*60*60*1000);
    const dataFim = agoraBRT.toISOString().slice(0, 10);
    const dataIni = '2025-01-01';

    const [nfse, telecom, nfcom, nfe] = await Promise.all([
      fetchNfTipo('nfse', token, dataIni, dataFim),
      fetchNfTipo('telecom', token, dataIni, dataFim),
      fetchNfTipo('nfcom', token, dataIni, dataFim),
      fetchNfTipo('nfe', token, dataIni, dataFim),
    ]);

    const tipos = { nfse, telecom, nfcom, nfe };
    let totalNf = 0;
    let totalValor = 0;
    for (const [, v] of Object.entries(tipos)) {
      totalNf += v.itens.length;
      for (const nf of v.itens) {
        const val = parseFloat(nf.valor_total ?? nf.valor ?? nf.total ?? 0);
        if (!isNaN(val)) totalValor += val;
      }
    }

    // Agrupa por mês — breakdown por tipo de NF
    const porMes = {};
    for (const [tipo, v] of Object.entries(tipos)) {
      for (const nf of v.itens) {
        const dtStr = nf.data_emissao || nf.data || '';
        const mes = dtStr.slice(0, 7); // YYYY-MM
        if (!mes) continue;
        if (!porMes[mes]) porMes[mes] = { total: 0, valor: 0, nfse: 0, telecom: 0, nfcom: 0, nfe: 0 };
        porMes[mes].total++;
        porMes[mes][tipo] = (porMes[mes][tipo] || 0) + 1;
        const val = parseFloat(nf.valor_total ?? nf.valor ?? nf.total ?? 0);
        if (!isNaN(val)) porMes[mes].valor += val;
      }
    }

    // Meses mais recentes para a tabela de detalhe
    const mesAtual = agoraBRT.toISOString().slice(0, 7);
    const mesAnt = new Date(agoraBRT.getFullYear(), agoraBRT.getMonth() - 1, 1).toISOString().slice(0, 7);
    const fiscalResult = {
      ok: true, periodo: { dataIni, dataFim },
      totalNf, totalValor,
      tipos: {
        nfse:   { ok: nfse.ok,   total: nfse.itens.length,   erro: nfse.erro },
        telecom:{ ok: telecom.ok,total: telecom.itens.length, erro: telecom.erro },
        nfcom:  { ok: nfcom.ok,  total: nfcom.itens.length,  erro: nfcom.erro },
        nfe:    { ok: nfe.ok,    total: nfe.itens.length,    erro: nfe.erro },
      },
      porMes,
      // Detalhe: apenas mês atual e anterior
      nfse:   nfse.itens.filter(n => { const m = (n.data_emissao||n.data||'').slice(0,7); return m===mesAtual||m===mesAnt; }).slice(0, 200),
      telecom:telecom.itens.filter(n => { const m = (n.data_emissao||n.data||'').slice(0,7); return m===mesAtual||m===mesAnt; }).slice(0, 200),
      nfcom:  nfcom.itens.filter(n => { const m = (n.data_emissao||n.data||'').slice(0,7); return m===mesAtual||m===mesAnt; }).slice(0, 200),
      nfe:    nfe.itens.filter(n => { const m = (n.data_emissao||n.data||'').slice(0,7); return m===mesAtual||m===mesAnt; }).slice(0, 200),
    };
    _fiscalCache = fiscalResult; _fiscalFetchedAt = Date.now();
    dbCacheSet('cache:fiscal', fiscalResult);
    res.json(fiscalResult);
  } catch (e) {
    console.error('[/api/fiscal]', e.message);
    if (_fiscalCache) return res.json({ ..._fiscalCache, cache: true, aviso: e.message });
    res.json({ ok: false, motivo: e.message });
  }
});

// ── ESTOQUE ─────────────────────────────────────────────────────────────────
let _estoqueCache = null; let _estoqueFetchedAt = 0;
const ESTOQUE_CACHE_TTL = 30 * 60 * 1000;

async function fetchEstoqueProdutos(token) {
  // Descobre total de páginas na primeira chamada, depois pagina tudo
  const POR_PAG = 100;
  let todos = [];
  let ultimaPag = 0;
  try {
    const r0 = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/estoque/produto`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 0, itens_por_pagina: POR_PAG },
      timeout: 15000,
    });
    const arr0 = r0.data?.produtos || r0.data?.data || r0.data?.itens || (Array.isArray(r0.data) ? r0.data : []);
    todos = todos.concat(arr0);
    ultimaPag = r0.data?.paginacao?.ultima_pagina ?? (arr0.length >= POR_PAG ? 9 : 0);
  } catch(e) { return todos; }

  for (let p = 1; p <= Math.min(ultimaPag, 20); p++) {
    try {
      const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/estoque/produto`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { pagina: p, itens_por_pagina: POR_PAG },
        timeout: 15000,
      });
      const arr = r.data?.produtos || r.data?.data || r.data?.itens || (Array.isArray(r.data) ? r.data : []);
      todos = todos.concat(arr);
      if (arr.length < POR_PAG) break;
    } catch(e) { break; }
  }
  return todos;
}

async function fetchEstoqueSaldos(token) {
  const endpointsS = ['estoque/saldo','estoque/saldo_produto','estoque/inventario','estoque/produto_saldo'];
  try {
    for (const ep of endpointsS) {
      try {
        const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/${ep}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { pagina: 0, itens_por_pagina: 500 },
          timeout: 10000,
        });
        const arr = r.data?.saldos || r.data?.data || r.data?.itens || r.data?.produtos || (Array.isArray(r.data) ? r.data : []);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[estoque] saldos via /${ep}: ${arr.length} itens`);
          return { arr, ep };
        }
      } catch { /* endpoint não existe — tenta próximo */ }
    }
  } catch(e) {
    console.warn('[estoque/saldos] erro geral:', e.message);
  }
  return { arr: [], ep: null };
}

app.get('/api/estoque', async (req, res) => {
  try {
    const force = req.query.force === '1';
    if (!force && _estoqueCache && (Date.now() - _estoqueFetchedAt) < ESTOQUE_CACHE_TTL) return res.json(_estoqueCache);
    if (!force) {
      const dbE = await dbCacheGet('cache:estoque', ESTOQUE_CACHE_TTL);
      if (dbE) { _estoqueCache = dbE; _estoqueFetchedAt = Date.now(); return res.json({ ...dbE, cache: 'db' }); }
    }
    const token = await getToken();

    const [produtos, locaisRaw, saldosResult] = await Promise.all([
      fetchEstoqueProdutos(token),
      axios.get(`${HUBSOFT_HOST}/api/v1/integracao/estoque/local_estoque`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { pagina: 0, itens_por_pagina: 100 },
        timeout: 10000,
      }).then(r => Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.itens || r.data?.locais || [])).catch(() => []),
      fetchEstoqueSaldos(token),
    ]);

    // Mapa de saldo por id_produto (se endpoint de saldo existir)
    const _pf = (p, ...keys) => { for (const k of keys) { const v = parseFloat(p[k]); if (!isNaN(v) && v > 0) return v; } return 0; };
    const saldoMap = {};
    for (const s of (saldosResult.arr || [])) {
      const idP = s.id_produto || s.produto?.id_produto || s.id;
      if (!idP) continue;
      if (!saldoMap[idP]) saldoMap[idP] = { qtd: 0, disp: 0, aloc: 0, min: 0 };
      saldoMap[idP].qtd  += _pf(s,'quantidade','qtd','saldo','amount');
      saldoMap[idP].disp += _pf(s,'quantidade_disponivel','disponivel','qtd_disponivel','livre');
      saldoMap[idP].aloc += _pf(s,'quantidade_alocada','alocado','reservado','em_uso');
      saldoMap[idP].min   = Math.max(saldoMap[idP].min, _pf(s,'estoque_minimo','minimo','ponto_pedido'));
    }

    const items = produtos.map(p => {
      const idP  = p.id_produto ?? p.id ?? p.codigo ?? '';
      const sal  = saldoMap[idP] || null;
      // Campos reais do Hubsoft: produto_categoria[], unidade_medida
      const cat  = p.produto_categoria?.[0]?.descricao ?? p.categoria?.nome ?? p.categoria ?? '—';
      const un   = p.unidade_medida?.abreviacao ?? p.unidade_medida?.nome ?? p.unidade?.sigla ?? p.unidade?.nome ?? '—';
      const qtd  = sal ? sal.qtd  : _pf(p,'quantidade','qtd','saldo','estoque_atual','total');
      const disp = sal ? (sal.disp || sal.qtd) : (_pf(p,'quantidade_disponivel','disponivel') || qtd);
      const aloc = sal ? sal.aloc : _pf(p,'quantidade_alocada','alocado','reservado');
      const min  = sal ? sal.min  : _pf(p,'estoque_minimo','minimo','ponto_pedido');
      return {
        id:        idP,
        nome:      p.nome ?? p.descricao ?? '—',
        categoria: typeof cat === 'string' ? cat : '—',
        unidade:   typeof un  === 'string' ? un  : '—',
        quantidade: qtd, disponivel: disp, alocado: aloc, minimo: min,
      };
    });

    const total     = items.length;
    const dispTotal = items.filter(i => i.disponivel > 0).length;
    const usoTotal  = items.filter(i => i.alocado > 0).length;
    const criticos  = items.filter(i => i.minimo > 0 && i.disponivel < i.minimo).length;

    const estoqueResult = {
      ok: true, total,
      kpi: { total, disponivel: dispTotal, alocado: usoTotal, criticos },
      items,
      locais: locaisRaw.map(l => ({ id: l.id, nome: l.nome ?? l.descricao ?? '—' })),
    };
    _estoqueCache = estoqueResult; _estoqueFetchedAt = Date.now();
    dbCacheSet('cache:estoque', estoqueResult);
    res.json(estoqueResult);
  } catch (e) {
    console.error('[/api/estoque]', e.message);
    if (_estoqueCache) return res.json({ ..._estoqueCache, cache: true, aviso: e.message });
    res.json({ ok: false, motivo: e.message });
  }
});

// Debug: ver campos reais do produto Hubsoft
app.get('/api/estoque/debug-raw', async (req, res) => {
  try {
    const token = await getToken();
    const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/estoque/produto`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 0, itens_por_pagina: 3 },
      timeout: 15000,
    });
    res.json({ raw: r.data, keys_primeiro: Object.keys((Array.isArray(r.data) ? r.data[0] : r.data?.data?.[0]) || {}) });
  } catch(e) { res.json({ erro: e.message }); }
});

// Movimentos de estoque (entradas/saídas)
app.get('/api/estoque/movimentos', async (req, res) => {
  try {
    const token = await getToken();
    const agora = new Date();
    const agoraBRT = new Date(agora.getTime() - 3*60*60*1000);
    const dataFim = req.query.dataFim || agoraBRT.toISOString().slice(0, 10);
    const dias    = parseInt(req.query.dias) || 30;
    const dataIni = req.query.dataIni || new Date(agoraBRT.getTime() - dias * 86400000).toISOString().slice(0, 10);

    // Tenta endpoints conhecidos do Hubsoft para movimentação
    const endpoints = [
      'estoque/movimentacao', 'estoque/movimento', 'estoque/historico_movimentacao',
      'estoque/historico', 'estoque/movimentacoes',
    ];
    let dados = null;
    let endpointUsado = null;
    for (const ep of endpoints) {
      try {
        const r = await axios.get(`${HUBSOFT_HOST}/api/v1/integracao/${ep}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { data_inicio: dataIni, data_fim: dataFim, pagina: 0, itens_por_pagina: 200 },
          timeout: 10000,
        });
        const arr = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.itens || r.data?.movimentos || []);
        if (arr.length > 0) { dados = arr; endpointUsado = ep; break; }
      } catch { continue; }
    }

    if (!dados) return res.json({ ok: false, motivo: 'Endpoint de movimentação não encontrado no Hubsoft', tentativas: endpoints });

    // Agrupa por dia e por semana
    const porDia = {}, porSemana = {}, porMes = {};
    for (const mv of dados) {
      const dt  = mv.data_movimento || mv.data || mv.created_at || '';
      const dia = dt.slice(0, 10);
      if (!dia) continue;
      const [ano, mes, d] = dia.split('-');
      const semAno = `${ano}-S${Math.ceil(parseInt(d)/7)}`;
      const mesAno = `${ano}-${mes}`;
      const val   = parseFloat(mv.quantidade || mv.qtd || 0);
      const tipo  = (mv.tipo || mv.tipo_movimento || '').toLowerCase().includes('entrada') ? 'entrada' : 'saida';

      [porDia, porSemana, porMes].forEach((obj, i) => {
        const key = [dia, semAno, mesAno][i];
        if (!obj[key]) obj[key] = { entrada: 0, saida: 0, total: 0 };
        obj[key][tipo] += val; obj[key].total += val;
      });
    }

    res.json({ ok: true, endpoint: endpointUsado, periodo: { dataIni, dataFim, dias },
      total: dados.length, porDia, porSemana, porMes, itens: dados.slice(0, 100) });
  } catch(e) {
    console.error('[/api/estoque/movimentos]', e.message);
    res.json({ ok: false, motivo: e.message });
  }
});

// ── RHiD Integration ─────────────────────────────────────────────
const RHID_BASE   = 'https://rhid.com.br/v2/api.svc';
const RHID_EMAIL  = process.env.RHID_EMAIL    || '2026rangel@gmail.com';
const RHID_PASS   = process.env.RHID_PASSWORD || '166922';
const RH_CACHE_TTL = 60 * 60 * 1000; // 1h

let _rhToken    = null;
let _rhTokenAt  = 0;
let _rhCache    = null;
let _rhCacheAt  = 0;

async function rhidLogin() {
  // Reutiliza token por até 3.5h (expira em 4h)
  if (_rhToken && (Date.now() - _rhTokenAt) < 3.5 * 60 * 60 * 1000) return _rhToken;
  const r = await fetch(`${RHID_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: RHID_EMAIL, password: RHID_PASS })
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error('RHiD login falhou');
  _rhToken   = d.accessToken;
  _rhTokenAt = Date.now();
  return _rhToken;
}

async function rhidGet(path, token) {
  const r = await fetch(`${RHID_BASE}${path}`, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { throw new Error(`RHiD ${path} retornou HTML (${r.status})`); }
}

// Busca apuracao_ponto para lista de pessoas em paralelo (batches de 10)
async function fetchApuracaoAll(token, personIds, dataIni, dataFim) {
  const results = {};
  const batchSize = 10;
  for (let i = 0; i < personIds.length; i += batchSize) {
    const batch = personIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async id => {
      try {
        const url = `/apuracao_ponto?dataIni=${dataIni}&dataFinal=${dataFim}&idPerson=${id}`;
        const raw = await rhidGet(url, token);
        // API retorna JSON string (double-encoded às vezes)
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(data)) results[id] = data;
      } catch { /* ignora erros individuais */ }
    }));
  }
  return results;
}

async function buildRh() {
  const token = await rhidLogin();

  // Busca persons paginado (máx 100 por chamada)
  async function fetchAllPersons(token) {
    const pageSize = 100;
    let start = 0, all = [];
    while (true) {
      const d = await rhidGet(`/person?start=${start}&length=${pageSize}`, token);
      const recs = d.records || [];
      all = all.concat(recs);
      if (recs.length < pageSize) break;
      start += pageSize;
    }
    return all;
  }

  // Busca persons e departments em paralelo
  const [persons, ddRaw, dvRaw] = await Promise.all([
    fetchAllPersons(token),
    rhidGet('/department?start=0&length=100', token),
    rhidGet('/device?start=0&length=50', token),
  ]);

  const departments = ddRaw.records || [];
  const devices     = dvRaw.records || [];

  // Mapa id→dept name
  const deptMap = {};
  for (const d of departments) deptMap[d.id] = d.name;

  // Headcount por status
  const ativos    = persons.filter(p => p.status === 0);
  const afastados = persons.filter(p => p.status !== 0);

  // Headcount por departamento (ativos)
  const hcDept = {};
  for (const p of ativos) {
    const dname = deptMap[p.idDepartment] || 'Outros';
    hcDept[dname] = (hcDept[dname] || 0) + 1;
  }
  const hcDeptSorted = Object.entries(hcDept)
    .sort((a,b) => b[1]-a[1])
    .map(([nome, total]) => ({ nome, total }));

  return {
    headcount: persons.length,
    ativos:    ativos.length,
    afastados: afastados.length,
    hcDeptSorted,
    devices,
  };
}

// Cache separado para ponto (mais pesado)
let _rhPontoCache   = null;
let _rhPontoCacheAt = 0;

app.get('/api/rh', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const agora = Date.now();
    if (!force && _rhCache && (agora - _rhCacheAt) < RH_CACHE_TTL) return res.json(_rhCache);
    if (force) { _rhCache = null; _rhCacheAt = 0; }
    const result  = await buildRh();
    _rhCache  = result;
    _rhCacheAt = agora;
    res.json(result);
  } catch (e) {
    console.error('[/api/rh]', e.message);
    if (_rhCache) return res.json({ ..._rhCache, aviso: e.message });
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/rh/ponto', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const agora = Date.now();
    if (!force && _rhPontoCache && (agora - _rhPontoCacheAt) < RH_CACHE_TTL) return res.json(_rhPontoCache);
    if (force) { _rhPontoCache = null; _rhPontoCacheAt = 0; }

    const token   = await rhidLogin();
    const dpRaw   = await rhidGet('/person?start=0&length=100', token);
    const persons = dpRaw.records || [];
    const deptDRaw = await rhidGet('/department?start=0&length=100', token);
    const deptMap = {};
    for (const d of (deptDRaw.records||[])) deptMap[d.id] = d.name;

    const ativos = persons.filter(p => p.status === 0);
    const now    = new Date();
    const mesRef = now.getDate() < 5
      ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const anoRef = mesRef.getFullYear();
    const mRef   = String(mesRef.getMonth()+1).padStart(2,'0');
    const lastDayN = new Date(anoRef, mesRef.getMonth()+1, 0).getDate();
    const dataIni = `${anoRef}-${mRef}-01`;
    const dataFim = `${anoRef}-${mRef}-${lastDayN}`;

    const apurMap = await fetchApuracaoAll(token, ativos.map(p=>p.id), dataIni, dataFim);

    // Dias úteis do mês
    let duteis = 0;
    const d0 = new Date(dataIni), dfim = new Date(dataFim);
    for (let d=new Date(d0); d<=dfim; d.setDate(d.getDate()+1)) {
      const wd = d.getDay(); if(wd!==0&&wd!==6) duteis++;
    }

    const pessoaStats = ativos.map(p => {
      const days = apurMap[p.id] || [];
      const horasTrab  = days.reduce((s,d) => s+(d.totalHorasTrabalhadas||0), 0);
      const horasExtra = days.reduce((s,d) => s+(d.horasExtrasCalculadas||0), 0);
      const diasTrab   = days.filter(d => (d.totalHorasTrabalhadas||0)>0).length;
      const faltas     = days.filter(d => d.faltaDiaInteiro).length;
      const atrasos    = days.reduce((s,d) => s+(d.atrasoEntrada||0), 0);
      const lastD      = [...days].reverse().find(d => d.saldoBancoFinalDia != null);
      const bancHoras  = lastD ? lastD.saldoBancoFinalDia : 0;
      return {
        id: p.id, nome: p.name, depto: deptMap[p.idDepartment]||'Outros',
        horasTrab: Math.round(horasTrab/60), horasExtra: Math.round(horasExtra/60),
        diasTrab, faltas, atrasos: Math.round(atrasos), bancHoras: Math.round(bancHoras/60),
      };
    });

    const totFaltas = pessoaStats.reduce((s,p)=>s+p.faltas,0);
    const pctAbsent = duteis>0&&ativos.length>0
      ? ((totFaltas/(ativos.length*duteis))*100).toFixed(1) : '0.0';

    const absDept = {};
    for (const ps of pessoaStats) {
      if (!absDept[ps.depto]) absDept[ps.depto]={faltas:0,total:0};
      absDept[ps.depto].faltas+=ps.faltas; absDept[ps.depto].total+=1;
    }
    const absDeptList = Object.entries(absDept)
      .map(([nome,v])=>({nome,total:v.total,faltas:v.faltas,
        pct:duteis>0?((v.faltas/(v.total*duteis))*100).toFixed(1):'0.0'}))
      .sort((a,b)=>parseFloat(b.pct)-parseFloat(a.pct));

    const bancoLista = pessoaStats.filter(p=>p.bancHoras!==0)
      .sort((a,b)=>a.bancHoras-b.bancHoras);

    const result = {
      mesLabel: mesRef.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}),
      pctAbsent, absDeptList, bancoLista,
      pessoaStats: pessoaStats.sort((a,b)=>a.nome.localeCompare(b.nome)),
    };
    _rhPontoCache = result; _rhPontoCacheAt = agora;
    res.json(result);
  } catch(e) {
    console.error('[/api/rh/ponto]', e.message);
    if (_rhPontoCache) return res.json({..._rhPontoCache, aviso:e.message});
    res.status(500).json({erro:e.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  KV STORAGE — PostgreSQL (Vercel Postgres / Railway Postgres)
//  Tabela única kv_store(key TEXT PK, value TEXT, updated_at TIMESTAMPTZ)
//  Chaves usadas: rh_csv, rh_csv_meta, rh_nr_certs, tasks
// ════════════════════════════════════════════════════════════════

const { Pool } = require('pg');

// DATABASE_URL é injetado automaticamente pelo Vercel Postgres e Railway Postgres
let _pgPool = null;
function getPool() {
  if (!_pgPool) {
    // Vercel Neon com prefixo STORAGE → STORAGE_URL; sem prefixo → DATABASE_URL
    const connStr = process.env.DATABASE_URL
      || process.env.POSTGRES_URL
      || process.env.STORAGE_URL
      || process.env.POSTGRES_PRISMA_URL;
    if (!connStr) { console.warn('[db] Nenhuma DATABASE_URL encontrada'); return null; }
    _pgPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pgPool;
}

async function dbInit() {
  try {
    const pool = getPool(); if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Tabela de usuários para controle de acesso
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops360_users (
        id         SERIAL PRIMARY KEY,
        nome       TEXT NOT NULL,
        email      TEXT UNIQUE NOT NULL,
        senha_hash TEXT NOT NULL,
        paginas    TEXT NOT NULL DEFAULT 'comercial',
        admin      BOOLEAN NOT NULL DEFAULT FALSE,
        ativo      BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Cria admin padrão se não existir nenhum usuário
    const { rows } = await pool.query('SELECT COUNT(*) as n FROM ops360_users');
    if (parseInt(rows[0].n) === 0) {
      const crypto = require('crypto');
      const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@meuprovedor360.com';
      const ADMIN_PASS  = process.env.ADMIN_PASS  || 'admin360';
      const hash = crypto.createHash('sha256').update(ADMIN_PASS + AUTH_SECRET).digest('hex');
      await pool.query(
        `INSERT INTO ops360_users(nome,email,senha_hash,paginas,admin) VALUES($1,$2,$3,$4,TRUE)`,
        ['Administrador', ADMIN_EMAIL, hash, 'comercial,atendimento,chamados,retencao,financeiro,fiscal,estoque,rh,saude,conexoes,tarefas,integracoes']
      );
      console.log(`[auth] Admin criado: ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
    }
    console.log('[db] tabelas prontas');
  } catch(e) {
    console.warn('[db] sem banco PostgreSQL disponível:', e.message);
  }
}

async function kvGet(key) {
  try {
    const pool = getPool(); if (!pool) return null;
    const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  try {
    const pool = getPool(); if (!pool) return false;
    await pool.query(
      `INSERT INTO kv_store(key,value,updated_at) VALUES($1,$2,NOW())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value]
    );
    return true;
  } catch(e) {
    console.error('[kvSet]', e.message);
    return false;
  }
}

// ── Cache persistente com TTL (PostgreSQL) ────────────────────────
// dbCacheGet: retorna dados se chave existir e não estiver expirada
async function dbCacheGet(key, ttlMs) {
  try {
    const pool = getPool(); if (!pool) return null;
    const r = await pool.query(
      'SELECT value, updated_at FROM kv_store WHERE key=$1', [key]
    );
    if (!r.rows[0]) return null;
    const age = Date.now() - new Date(r.rows[0].updated_at).getTime();
    if (age > ttlMs) return null;
    return JSON.parse(r.rows[0].value);
  } catch { return null; }
}

// dbCacheSet: salva dados no PostgreSQL
async function dbCacheSet(key, data) {
  try {
    await kvSet(key, JSON.stringify(data));
  } catch(e) { console.warn('[dbCacheSet]', key, e.message); }
}

// dbCacheRestore: carrega cache do banco para memória sem verificar TTL
// (usado no boot para reaquecer variáveis de memória — mesmo dado "expirado"
//  é melhor que nada enquanto o warm-up real acontece em background)
async function dbCacheRestore(key) {
  try {
    const pool = getPool(); if (!pool) return null;
    const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]);
    return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
  } catch { return null; }
}

// ── Fallback arquivo (Railway sem Postgres, dev local) ────────────
const RH_DATA_DIR = path.join(__dirname, 'data');
function fileGet(name) {
  try {
    const p = path.join(RH_DATA_DIR, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch { return null; }
}
function fileSet(name, content) {
  try {
    fs.mkdirSync(RH_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(RH_DATA_DIR, name), content, 'utf8');
  } catch(e) { console.error('[fileSet]', e.message); }
}

async function storeGet(key) {
  const v = await kvGet(key);
  if (v !== null) return v;
  return fileGet(key.replace(/\//g, '_') + (key.endsWith('meta') ? '.json' : key === 'rh_csv' ? '.txt' : '.json'));
}
async function storeSet(key, value) {
  const ok = await kvSet(key, value);
  // Escreve no arquivo também como backup local
  fileSet(key.replace(/\//g, '_') + (key === 'rh_csv' ? '.txt' : '.json'), value);
  return ok;
}

// ── Endpoints RH storage ─────────────────────────────────────────

app.get('/api/rh/csv-store', async (req, res) => {
  try {
    const csv  = await storeGet('rh_csv');
    const metaRaw = await storeGet('rh_csv_meta');
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    res.json({ csv: csv || null, meta });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/rh/csv-store', async (req, res) => {
  try {
    const { csv, meta } = req.body;
    if (!csv) return res.status(400).json({ erro: 'csv obrigatório' });
    await storeSet('rh_csv', csv);
    await storeSet('rh_csv_meta', JSON.stringify({ ...(meta||{}), savedAt: new Date().toISOString() }));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/rh/nr-certs', async (req, res) => {
  try {
    const raw = await storeGet('rh_nr_certs');
    res.json(raw ? JSON.parse(raw) : []);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/rh/nr-certs', async (req, res) => {
  try {
    const lista = Array.isArray(req.body) ? req.body : [];
    await storeSet('rh_nr_certs', JSON.stringify(lista));
    res.json({ ok: true, total: lista.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Migra NR certs de fonte externa (Vercel → Railway)
app.post('/api/rh/nr-certs/migrate', async (req, res) => {
  try {
    const { source_url } = req.body;
    if (!source_url) return res.status(400).json({ erro: 'source_url obrigatório' });
    const r = await axios.get(source_url, { timeout: 10000 });
    // Suporta { ok, data: [...] } (nr-export) ou array direto
    const lista = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.data) ? r.data.data : []);
    if (!r.data?.ok && !Array.isArray(r.data)) return res.json({ ok: false, motivo: r.data?.motivo || 'Fonte retornou erro' });
    if (lista.length === 0) return res.json({ ok: false, motivo: 'Fonte retornou lista vazia' });
    await storeSet('rh_nr_certs', JSON.stringify(lista));
    res.json({ ok: true, total: lista.length, migrated: lista.map(c => c.nome) });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── RAX — Chat Agent (Claude) ─────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ erro: 'ANTHROPIC_API_KEY não configurada' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ erro: 'messages obrigatório' });

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: `Você é RAX (Rangel Analytics X), um agente de análise inteligente integrado ao sistema OPS360 de uma empresa de internet (ISP).
Responda sempre em português brasileiro de forma direta e objetiva.
Por padrão, responda apenas em texto simples — não envie imagens, arquivos ou links a menos que o usuário solicite explicitamente.
Quando precisar exibir dados estruturados, use listas ou tabelas em markdown.
Você tem acesso ao contexto do sistema OPS360: chamados, atendimento, comercial, cancelamentos, financeiro, RH, conexões.`,
      messages: messages.map(m => ({
        role: m.role,
        content: Array.isArray(m.content) ? m.content : m.content
      }))
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const text = response.data.content?.[0]?.text || '';
    res.json({ text });
  } catch(e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ erro: msg });
  }
});

// ── Fallback SPA: qualquer rota não-API serve o index.html ───────
// ── AUTH ──────────────────────────────────────────────────────────

// Usuários em memória (fallback quando banco não disponível)
const TODAS_PGS = 'comercial,atendimento,chamados,retencao,financeiro,fiscal,estoque,rh,saude,conexoes,tarefas,integracoes';
let _usersMemoria = null; // carregado do arquivo se banco offline

function _usersArquivo() { return path.join(__dirname, 'users.json'); }

function _usersCarregarArq() {
  if (_usersMemoria) return _usersMemoria;
  try {
    const fs = require('fs');
    const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@meuprovedor360.com').toLowerCase();
    const ADMIN_PASS  = process.env.ADMIN_PASS  || 'admin360';
    const defaultAdmin = { id:1, nome:'Administrador', email: ADMIN_EMAIL, senha_hash: _hashSenha(ADMIN_PASS), paginas: TODAS_PGS, admin: true, ativo: true };
    if (fs.existsSync(_usersArquivo())) {
      _usersMemoria = JSON.parse(fs.readFileSync(_usersArquivo(), 'utf8'));
      // Garante que admin padrão existe
      if (!_usersMemoria.find(u => u.admin)) _usersMemoria.unshift(defaultAdmin);
    } else {
      _usersMemoria = [defaultAdmin];
      fs.writeFileSync(_usersArquivo(), JSON.stringify(_usersMemoria, null, 2));
    }
  } catch { _usersMemoria = [{ id:1, nome:'Administrador', email:'admin@meuprovedor360.com', senha_hash: _hashSenha('admin360'), paginas: TODAS_PGS, admin:true, ativo:true }]; }
  return _usersMemoria;
}

function _usersSalvarArq() {
  try { require('fs').writeFileSync(_usersArquivo(), JSON.stringify(_usersMemoria, null, 2)); } catch {}
}

async function _findUser(email) {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query('SELECT * FROM ops360_users WHERE email=$1 AND ativo=TRUE', [email]);
      return r.rows[0] || null;
    } catch {}
  }
  // Fallback arquivo
  return _usersCarregarArq().find(u => u.email === email && u.ativo) || null;
}

async function _getUser(id) {
  const pool = getPool();
  if (pool) {
    try {
      const r = await pool.query('SELECT * FROM ops360_users WHERE id=$1 AND ativo=TRUE', [id]);
      return r.rows[0] || null;
    } catch {}
  }
  return _usersCarregarArq().find(u => u.id === id && u.ativo) || null;
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.json({ ok: false, motivo: 'Email e senha obrigatórios' });
    const user = await _findUser(email.trim().toLowerCase());
    if (!user) return res.json({ ok: false, motivo: 'Usuário não encontrado' });
    if (_hashSenha(senha) !== user.senha_hash) return res.json({ ok: false, motivo: 'Senha incorreta' });
    const token = _gerarToken(user.id);
    res.json({ ok: true, token, user: { id: user.id, nome: user.nome, email: user.email, paginas: user.paginas, admin: user.admin } });
  } catch(e) { res.json({ ok: false, motivo: e.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const uid = _validarToken(token);
  if (!uid) return res.json({ ok: false, motivo: 'Token inválido' });
  const user = await _getUser(uid);
  if (!user) return res.json({ ok: false, motivo: 'Usuário não encontrado' });
  res.json({ ok: true, user: { id: user.id, nome: user.nome, email: user.email, paginas: user.paginas, admin: user.admin } });
});

// ── GESTÃO DE USUÁRIOS (admin only) ──────────────────────────────
async function _authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const uid = _validarToken(token);
  if (!uid) return null;
  const user = await _getUser(uid);
  return (user && user.admin) ? user : null;
}

app.get('/api/auth/users', async (req, res) => {
  const admin = await _authAdmin(req);
  if (!admin) return res.status(403).json({ ok: false, motivo: 'Acesso negado' });
  try {
    const pool = getPool();
    if (pool) {
      const r = await pool.query('SELECT id,nome,email,paginas,admin,ativo FROM ops360_users ORDER BY nome');
      return res.json({ ok: true, users: r.rows });
    }
    // Fallback arquivo
    const users = _usersCarregarArq().map(u => ({ id:u.id, nome:u.nome, email:u.email, paginas:u.paginas, admin:u.admin, ativo:u.ativo }));
    res.json({ ok: true, users });
  } catch(e) { res.json({ ok: false, motivo: e.message }); }
});

app.post('/api/auth/users', async (req, res) => {
  const admin = await _authAdmin(req);
  if (!admin) return res.status(403).json({ ok: false, motivo: 'Acesso negado' });
  try {
    const { nome, email, senha, paginas, is_admin } = req.body || {};
    if (!nome || !email || !senha) return res.json({ ok: false, motivo: 'Nome, email e senha obrigatórios' });
    const hash = _hashSenha(senha);
    const emailNorm = email.trim().toLowerCase();
    const pool = getPool();
    if (pool) {
      const r = await pool.query(`INSERT INTO ops360_users(nome,email,senha_hash,paginas,admin) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [nome.trim(), emailNorm, hash, (paginas||'comercial'), !!is_admin]);
      return res.json({ ok: true, id: r.rows[0].id });
    }
    // Fallback arquivo
    const lista = _usersCarregarArq();
    if (lista.find(u => u.email === emailNorm)) return res.json({ ok: false, motivo: 'Email já cadastrado' });
    const newId = Math.max(0, ...lista.map(u => u.id)) + 1;
    lista.push({ id: newId, nome: nome.trim(), email: emailNorm, senha_hash: hash, paginas: paginas||'comercial', admin: !!is_admin, ativo: true });
    _usersSalvarArq();
    res.json({ ok: true, id: newId });
  } catch(e) { res.json({ ok: false, motivo: e.message }); }
});

app.put('/api/auth/users/:id', async (req, res) => {
  const admin = await _authAdmin(req);
  if (!admin) return res.status(403).json({ ok: false, motivo: 'Acesso negado' });
  try {
    const { nome, email, senha, paginas, is_admin, ativo } = req.body || {};
    const uid = parseInt(req.params.id);
    const pool = getPool();
    if (pool) {
      if (senha) {
        await pool.query(`UPDATE ops360_users SET nome=$1,email=$2,senha_hash=$3,paginas=$4,admin=$5,ativo=$6 WHERE id=$7`,
          [nome, email?.toLowerCase(), _hashSenha(senha), paginas, !!is_admin, ativo !== false, uid]);
      } else {
        await pool.query(`UPDATE ops360_users SET nome=$1,email=$2,paginas=$3,admin=$4,ativo=$5 WHERE id=$6`,
          [nome, email?.toLowerCase(), paginas, !!is_admin, ativo !== false, uid]);
      }
      return res.json({ ok: true });
    }
    // Fallback arquivo
    const lista = _usersCarregarArq();
    const idx = lista.findIndex(u => u.id === uid);
    if (idx < 0) return res.json({ ok: false, motivo: 'Usuário não encontrado' });
    lista[idx] = { ...lista[idx], nome, email: email?.toLowerCase()||lista[idx].email, paginas: paginas||lista[idx].paginas, admin: !!is_admin, ativo: ativo !== false };
    if (senha) lista[idx].senha_hash = _hashSenha(senha);
    _usersSalvarArq();
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, motivo: e.message }); }
});

app.delete('/api/auth/users/:id', async (req, res) => {
  const admin = await _authAdmin(req);
  if (!admin) return res.status(403).json({ ok: false, motivo: 'Acesso negado' });
  try {
    const uid = parseInt(req.params.id);
    if (uid === admin.id) return res.json({ ok: false, motivo: 'Não pode excluir a si mesmo' });
    const pool = getPool();
    if (pool) {
      await pool.query('DELETE FROM ops360_users WHERE id=$1', [uid]);
      return res.json({ ok: true });
    }
    const lista = _usersCarregarArq();
    _usersMemoria = lista.filter(u => u.id !== uid);
    _usersSalvarArq();
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, motivo: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Inicializa ────────────────────────────────────────────────────
dbInit(); // cria tabela se não existir (não bloqueia)

// Exporta para Vercel (serverless) — mantém listen para Railway/local
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 OPS360 Proxy rodando na porta ${PORT}`);
    console.log(`   Host Hubsoft: ${HUBSOFT_HOST}`);
    console.log(`   Dashboard:    http://localhost:${PORT}\n`);
  });
} else {
  module.exports = app;
}
