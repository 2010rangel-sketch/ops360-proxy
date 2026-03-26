// ═══════════════════════════════════════════════════════════════
//  OPS360 — Servidor Proxy Hubsoft
//  Hospede no Railway.app — funciona sem configuração extra
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');

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

// ── Credenciais via variáveis de ambiente (configure no Railway) ──
const HUBSOFT_HOST          = process.env.HUBSOFT_HOST          || 'https://api.lcvirtual.hubsoft.com.br';
const HUBSOFT_CLIENT_ID     = process.env.HUBSOFT_CLIENT_ID     || '71';
const HUBSOFT_CLIENT_SECRET = process.env.HUBSOFT_CLIENT_SECRET || 'OOZnYHxKg5R8FHKSJpSys6N1mmb2AR1eNA0ogpbb';
const HUBSOFT_USERNAME      = process.env.HUBSOFT_USERNAME      || '2026rangel@gmail.com';
const HUBSOFT_PASSWORD      = process.env.HUBSOFT_PASSWORD      || 'Rangel26@';
const grant_type           = process.env.grant_type             || 'password';

// ── Apple iCloud CalDAV ───────────────────────────────────────────
const APPLE_ID           = process.env.APPLE_ID           || '';
const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD || '';
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
app.use(express.json());

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

// ── Ordens de Serviço (Chamados) ─────────────────────────────────
app.get('/api/chamados', async (req, res) => {
  try {
    const { data_inicio, data_fim, limit = 200, page = 1, all } = req.query;

    let lista = [];
    if (all === 'true') {
      const PAGE_SIZE = 500;
      const MAX_PAGES = 50;
      // Fetch page 1 to discover total pages
      const body1 = bodyConsultaOS({ data_inicio, data_fim });
      const data1 = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=1`, body1);
      const page1Lista = extrairLista(data1);
      lista.push(...page1Lista);
      const { lastPage, total, perPage } = extrairPaginacao(data1);
      // Determine total pages from metadata
      let totalPages = lastPage || (total && perPage ? Math.ceil(total / perPage) : null);
      const knowsTotal = !!totalPages;
      if (!totalPages) totalPages = page1Lista.length >= PAGE_SIZE ? MAX_PAGES : 1;
      totalPages = Math.min(totalPages, MAX_PAGES);
      console.log(`[chamados] page 1: ${page1Lista.length} | totalPages=${totalPages} | total=${total} | knowsTotal=${knowsTotal}`);

      if (totalPages > 1) {
        if (knowsTotal) {
          // Parallel fetch — we know exactly how many pages
          const BATCH = 10;
          for (let start = 2; start <= totalPages; start += BATCH) {
            const end = Math.min(start + BATCH - 1, totalPages);
            const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
            const results = await Promise.all(pages.map(async pg => {
              const body = bodyConsultaOS({ data_inicio, data_fim });
              const d = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, body);
              return extrairLista(d);
            }));
            for (const r of results) lista.push(...r);
            console.log(`[chamados] batch ${start}-${end}: total so far ${lista.length}`);
          }
        } else {
          // Sequential fallback — stop as soon as a page returns < PAGE_SIZE
          let pg = 2;
          while (pg <= MAX_PAGES) {
            const body = bodyConsultaOS({ data_inicio, data_fim });
            const d = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, body);
            const r = extrairLista(d);
            lista.push(...r);
            console.log(`[chamados] seq page ${pg}: ${r.length} records`);
            if (r.length < PAGE_SIZE) break;
            pg++;
          }
        }
      }
    } else {
      const body = bodyConsultaOS({ data_inicio, data_fim, limit, page });
      const data = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${limit}?page=${page}`, body);
      lista = extrairLista(data);
    }

    const chamados = lista.map(os => {
      const tipo  = os.tipo_ordem_servico?.descricao || os.tipo_os?.nome || 'Sem tipo';
      const tecs  = os.tecnicos || [];
      const tec   = tecs.map(t => t.name || t.nome || t.display).filter(Boolean).join(', ') || 'Sem técnico';
      const cs     = os.atendimento?.cliente_servico;
      const end    = cs?.endereco_instalacao;
      const coords = end?.endereco_numero?.coordenadas?.coordinates || end?.coordenadas?.coordinates;
      const cidade = end?.endereco_numero?.cidade?.nome
                  || end?.cidade?.nome
                  || end?.cidade?.display
                  || cs?.cliente?.cidade?.nome
                  || 'Sem cidade';
      const cidId  = end?.endereco_numero?.id_cidade
                  || end?.id_cidade
                  || end?.cidade?.id_cidade
                  || null;
      const cli    = cs?.display || cs?.cliente?.nome_razaosocial || cs?.cliente?.display || 'Cliente';
      const statusBase = os.status || '';
      // Hubsoft mobile: status fica "pendente" mas reserva tem servico_iniciado=true,desreservada=false
      // Só eleva para execucao se ainda NÃO finalizado (evita reclassificar finalizados com reservas antigas)
      const stBase = normalizarStatus(statusBase);
      const execAtiva = stBase === 'aguardando' && (
        os.executando === true ||
        (Array.isArray(os.reservas) && os.reservas.some(r => r.servico_iniciado && !r.desreservada))
      );
      const stVal = execAtiva ? 'em_execucao' : statusBase;
      return {
        id:         `#${os.id_ordem_servico || os.id}`,
        cli,
        cat:        normalizarTipo(tipo),
        tipo,
        tec,
        cidade,
        cidadeId:   cidId,
        ab:             (os.hora_inicio_programado||'').slice(0,5) || formatarHora(os.data_inicio_programado || os.data_cadastro),
        dataProgramada: os.data_inicio_programado || os.data_cadastro || null,
        slaMin:         os.tipo_ordem_servico?.prazo_execucao || 240,
        inicioExec:     (os.hora_inicio_executado||'').slice(0,5) || null,
        fimExec:        (os.hora_termino_executado||'').slice(0,5) || null,
        tsInicioExec:   os.data_inicio_executado || null,
        tsFimExec:      os.data_termino_executado || null,
        st:         normalizarStatus(stVal),
        rtb:        tipo.toLowerCase().includes('retrabalho'),
        rtbOrig:    os.id_ordem_servico_origem ? `#${os.id_ordem_servico_origem}` : null,
        rtbMotivo:  os.descricao_retrabalho || null,
        reagMotivo: normalizarStatus(stVal) === 'reagendado' ? (os.motivo_reagendamento || 'Reagendado') : null,
        lat:        coords ? parseFloat(coords[1]) || null : null,
        lng:        coords ? parseFloat(coords[0]) || null : null,
        raw:        os,
      };
    });

    res.json({ ok: true, total: chamados.length, chamados, sincronizado_em: new Date().toISOString() });
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

// ── Atendimentos — por período, agrupado por atendente/setor/tipo ─
app.get('/api/atendimentos', async (req, res) => {
  try {
    const { data_inicio, data_fim, all } = req.query;
    const agora = new Date();

    // Período selecionado (ou hoje por default)
    let ini, fim;
    if (data_inicio) {
      ini = new Date(data_inicio);
      fim = data_fim ? new Date(new Date(data_fim).setHours(23,59,59,999))
                     : new Date(ini.getTime() + 24*60*60*1000);
    } else {
      ini = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
      fim = new Date(ini.getTime() + 24*60*60*1000);
    }

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
      const BATCH = 10;
      let all_list = [...list1];
      for (let start = 2; start <= totalPages; start += BATCH) {
        const end = Math.min(start + BATCH - 1, totalPages);
        const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
        const results = await Promise.all(pages.map(async pg => {
          const d = await hubsoftPost(`v1/atendimento/consultar/paginado/${PAGE_SIZE}?page=${pg}`, body1);
          return Array.isArray(d?.atendimentos?.data) ? d.atendimentos.data : [];
        }));
        for (const r of results) all_list.push(...r);
        console.log(`[atendimentos] batch ${start}-${end}: total so far ${all_list.length}`);
      }
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

      return { tipo, atendente, setor, cliente, clienteId, temOS, tmaMin };
    }

    const SETORES_EXCLUIDOS = ['NOC', ''];
    const parsedAll = lista.map(parseA);
    const parsed = parsedAll.filter(a => !SETORES_EXCLUIDOS.includes(a.setor));

    const isLC = (nome) => (nome || '').toUpperCase().includes('LC VIRTUAL') || (nome || '').toUpperCase().includes('LCVIRTUAL');

    // Agrupa por atendente (inclui setor para filtro no cliente)
    const mapaAt = {};
    parsed.forEach(a => {
      const k = a.atendente;
      if (!mapaAt[k]) mapaAt[k] = { atendente:k, setor:a.setor, total:0, comOS:0, semOS:0, tmaTot:0, tmaCount:0 };
      mapaAt[k].total++;
      if (a.temOS) mapaAt[k].comOS++; else mapaAt[k].semOS++;
      if (a.tmaMin !== null) { mapaAt[k].tmaTot += a.tmaMin; mapaAt[k].tmaCount++; }
    });
    const por_atendente = Object.values(mapaAt)
      .map(a => ({ atendente:a.atendente, setor:a.setor, total:a.total, comOS:a.comOS, semOS:a.semOS,
                   pctSemOS: a.total ? Math.round(a.semOS/a.total*100) : 0,
                   tma: a.tmaCount ? Math.round(a.tmaTot/a.tmaCount) : null }))
      .sort((a,b) => b.total - a.total);

    // Agrupa por setor
    const mapaSet = {};
    parsed.forEach(a => {
      const k = a.setor;
      if (!mapaSet[k]) mapaSet[k] = { setor:k, total:0, comOS:0, semOS:0 };
      mapaSet[k].total++;
      if (a.temOS) mapaSet[k].comOS++; else mapaSet[k].semOS++;
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
      if (a.temOS) mapaTipo[k].comOS++; else mapaTipo[k].semOS++;
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
      if (a.temOS) mapaClientes[k].comOS++; else mapaClientes[k].semOS++;
      mapaClientes[k].tipos[a.tipo] = (mapaClientes[k].tipos[a.tipo] || 0) + 1;
    });
    const clientes_recorrentes = Object.entries(mapaClientes)
      .filter(([,c]) => c.contatos > 1)
      .map(([clienteId, c]) => ({ ...c, clienteId, tipos: Object.entries(c.tipos).sort((a,b)=>b[1]-a[1]).map(([tipo,n])=>({tipo,n})) }))
      .sort((a,b) => b.contatos - a.contatos)
      .slice(0, 50);

    // LC Virtual Net — agrupa por Expansão / Correção / Construção de Rede
    // com sub-tipos para o modal (igual a clientes recorrentes)
    const mapaLC = {};
    parsedAll.filter(a => isLC(a.cliente)).forEach(a => {
      const t = (a.tipo || '').toUpperCase();
      let grupo = null;
      if (t.includes('EXPANS'))  grupo = 'Expansão de Rede';
      else if (t.includes('CORRE'))   grupo = 'Correção de Rede';
      else if (t.includes('CONSTRU')) grupo = 'Construção de Rede';
      if (!grupo) return;
      if (!mapaLC[grupo]) mapaLC[grupo] = { tipo: grupo, total: 0, comOS: 0, semOS: 0, subtipos: {} };
      mapaLC[grupo].total++;
      if (a.temOS) mapaLC[grupo].comOS++; else mapaLC[grupo].semOS++;
      mapaLC[grupo].subtipos[a.tipo] = (mapaLC[grupo].subtipos[a.tipo] || 0) + 1;
    });
    const lc_virtual = Object.values(mapaLC)
      .map(g => ({ ...g, subtipos: Object.entries(g.subtipos).sort((a,b)=>b[1]-a[1]).map(([tipo,n])=>({tipo,n})) }))
      .sort((a, b) => b.total - a.total);

    const periodo = req.query.periodo || 'custom';
    res.json({
      ok: true,
      total: parsed.length,
      por_atendente, por_setor, por_tipo, clientes_recorrentes, lc_virtual, periodo,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erro /api/atendimentos:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Contratos — cadastros e cancelamentos do mês ──────────────────
app.get('/api/contratos', async (req, res) => {
  try {
    const agora  = new Date();
    const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999);
    const body   = { data_inicio: iniMes.toISOString(), data_fim: fimMes.toISOString() };

    let cancelamentos = [], cadastros = [], vendedores = {}, erros = [];

    // Helper para extrair lista de contratos de várias estruturas
    function extrairContratos(d) {
      return d?.clientes_servicos?.data || d?.cliente_servico?.data
          || d?.contratos?.data || d?.contrato?.data
          || d?.data || [];
    }

    // Cancelados
    try {
      const dc = await hubsoftPost('v1/cliente_servico/consultar/paginado/500?page=1', { ...body, situacao: ['cancelado'] });
      const lista = extrairContratos(dc);
      if (Array.isArray(lista) && lista.length) {
        cancelamentos = lista.map(c => ({
          cliente:  c.cliente?.nome_razaosocial || c.cliente?.display || c.display || 'Cliente',
          plano:    c.plano?.descricao || c.plano?.nome || c.servico?.nome || '—',
          motivo:   c.motivo_cancelamento?.descricao || c.motivo?.descricao || '—',
          vendedor: c.vendedor?.nome || c.vendedor?.display || c.usuario?.nome || '—',
          data:     c.data_cancelamento || c.updated_at || c.data_alteracao || null,
        })).sort((a,b) => (b.data||'') > (a.data||'') ? 1 : -1).slice(0, 30);

        lista.forEach(c => {
          const v = c.vendedor?.nome || c.vendedor?.display || c.usuario?.nome;
          if (v) { if (!vendedores[v]) vendedores[v] = { nome:v, ativados:0, cancelados:0 }; vendedores[v].cancelados++; }
        });
      }
    } catch(e) { erros.push({ ep:'cancelados', msg: e.response?.status || e.message }); }

    // Novos ativados
    try {
      const da = await hubsoftPost('v1/cliente_servico/consultar/paginado/500?page=1', { ...body, situacao: ['ativo'] });
      const lista = extrairContratos(da);
      if (Array.isArray(lista) && lista.length) {
        cadastros = lista.map(c => ({
          cliente:  c.cliente?.nome_razaosocial || c.cliente?.display || c.display || 'Cliente',
          plano:    c.plano?.descricao || c.plano?.nome || c.servico?.nome || '—',
          vendedor: c.vendedor?.nome || c.vendedor?.display || c.usuario?.nome || '—',
          cidade:   c.endereco?.cidade?.nome || c.cliente?.cidade?.nome || '—',
          data:     c.data_cadastro || c.data_ativacao || c.created_at || null,
        })).sort((a,b) => (b.data||'') > (a.data||'') ? 1 : -1).slice(0, 30);

        lista.forEach(c => {
          const v = c.vendedor?.nome || c.vendedor?.display || c.usuario?.nome;
          if (v) { if (!vendedores[v]) vendedores[v] = { nome:v, ativados:0, cancelados:0 }; vendedores[v].ativados++; }
        });
      }
    } catch(e) { erros.push({ ep:'ativados', msg: e.response?.status || e.message }); }

    const rankVendedores = Object.values(vendedores).sort((a,b) => b.ativados - a.ativados);
    const saldo = cadastros.length - cancelamentos.length;

    res.json({
      ok: true,
      novos: cadastros.length, cancelados: cancelamentos.length, saldo,
      cadastros, cancelamentos, vendedores: rankVendedores,
      erros: erros.length ? erros : undefined,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erro /api/contratos:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Debug: mostra um atendimento bruto para descobrir campos ──────
app.get('/api/debug-atendimento-raw', async (req, res) => {
  try {
    const agora = new Date();
    const ini   = new Date(agora.getTime() - 7*24*60*60*1000);
    const data  = await hubsoftPost('v1/atendimento/consultar/paginado/3?page=1', {
      data_inicio: ini.toISOString(), data_fim: agora.toISOString(),
    });
    const lista = Array.isArray(data?.atendimentos?.data) ? data.atendimentos.data : [];
    res.json({ keys_raiz: lista[0] ? Object.keys(lista[0]) : [], primeiro: lista[0] || null, segundo: lista[1] || null });
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Debug: descobre estrutura de contratos ────────────────────────
app.get('/api/debug-contratos', async (req, res) => {
  try {
    const token  = await getToken();
    const agora  = new Date();
    const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59);
    const body   = { data_inicio: iniMes.toISOString(), data_fim: fimMes.toISOString() };
    const resultados = {};

    // ── Testa GET em endpoints comuns de cadastro/contrato ──
    const getEps = [
      'v1/assinatura','v1/assinaturas',
      'v1/contrato','v1/contratos',
      'v1/cliente','v1/clientes',
      'v1/plano','v1/planos',
      'v1/cliente_servico','v1/clientes_servicos',
      'v1/contrato_cliente','v1/servico_cliente',
      'v1/cadastro','v1/cancelamento','v1/cancelamentos',
      'v1/plano_cliente','v1/servico',
    ];
    for (const ep of getEps) {
      try {
        const r = await axios.get(`${HUBSOFT_HOST}/api/${ep}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { limit: 1, page: 1 },
          timeout: 5000,
        });
        resultados[`GET_${ep}`] = { ok: true, status: r.status, keys: Object.keys(r.data), sample: r.data };
      } catch(e) { resultados[`GET_${ep}`] = { ok: false, status: e.response?.status }; }
    }

    // ── Testa POST paginado em endpoints prováveis ──
    const postEps = [
      'v1/cliente/consultar/paginado/3?page=1',
      'v1/assinatura/consultar/paginado/3?page=1',
      'v1/contrato/consultar/paginado/3?page=1',
      'v1/cliente_servico/consultar/paginado/3?page=1',
      'v1/plano_cliente/consultar/paginado/3?page=1',
      'v1/cadastro/consultar/paginado/3?page=1',
      'v1/cancelamento/consultar/paginado/3?page=1',
      'v1/servico_cliente/consultar/paginado/3?page=1',
      'v1/contrato_servico/consultar/paginado/3?page=1',
    ];
    // Tenta com body de data e também body vazio
    for (const ep of postEps) {
      const key = ep.split('/')[1];
      try {
        const d = await hubsoftPost(ep, body);
        resultados[`POST_${key}`] = { ok: true, keys: Object.keys(d), sample: d };
      } catch(e) { resultados[`POST_${key}`] = { ok: false, status: e.response?.status }; }
      // Tenta com body vazio também
      try {
        const d = await hubsoftPost(ep, {});
        resultados[`POST_${key}_vazio`] = { ok: true, keys: Object.keys(d), sample: d };
      } catch(e) { resultados[`POST_${key}_vazio`] = { ok: false, status: e.response?.status }; }
    }

    // ── Tenta variantes v2 e endpoints específicos de ISP ──
    const maisEps = [
      // v2
      { m:'GET', ep:'v2/cliente' }, { m:'GET', ep:'v2/contrato' }, { m:'GET', ep:'v2/assinatura' },
      // ISP/telecom específicos
      { m:'GET', ep:'v1/proposta' }, { m:'GET', ep:'v1/adesao' }, { m:'GET', ep:'v1/fatura' },
      { m:'GET', ep:'v1/internet' }, { m:'GET', ep:'v1/plano_internet' },
      { m:'GET', ep:'v1/contrato_internet' }, { m:'GET', ep:'v1/novo_cliente' },
      // com /consultar suffix
      { m:'POST', ep:'v2/cliente/consultar/paginado/3?page=1' },
      { m:'POST', ep:'v1/cliente/pesquisar/paginado/3?page=1' },
      { m:'POST', ep:'v1/cliente/listar/paginado/3?page=1' },
      { m:'POST', ep:'v1/adesao/consultar/paginado/3?page=1' },
      { m:'POST', ep:'v1/fatura/consultar/paginado/3?page=1' },
    ];
    for (const { m, ep } of maisEps) {
      const key = `${m}_${ep.replace(/\//g,'_').replace(/\?.*$/,'')}`;
      try {
        let r;
        if (m === 'GET') {
          r = await axios.get(`${HUBSOFT_HOST}/api/${ep}`, { headers: { Authorization:`Bearer ${token}` }, timeout:5000 });
          resultados[key] = { ok:true, status:r.status, keys:Object.keys(r.data), sample:r.data };
        } else {
          const d = await hubsoftPost(ep, body);
          resultados[key] = { ok:true, keys:Object.keys(d), sample:d };
        }
      } catch(e) { resultados[key] = { ok:false, status:e.response?.status }; }
    }

    res.json(resultados);
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ── Debug: descobre estrutura da API de atendimentos ──────────────
app.get('/api/debug-atendimentos', async (req, res) => {
  try {
    const agora = new Date();
    const ini   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
    const fim   = new Date(ini.getTime() + 24 * 60 * 60 * 1000);
    const body  = { data_inicio: ini.toISOString(), data_fim: fim.toISOString() };
    const resultados = {};
    for (const ep of ['v1/atendimento/consultar/paginado/3?page=1']) {
      try {
        const d = await hubsoftPost(ep, body);
        resultados[ep] = { ok: true, keys: Object.keys(d), amostra: d };
      } catch(e) {
        resultados[ep] = { ok: false, status: e.response?.status, erro: e.response?.data || e.message };
      }
    }
    res.json(resultados);
  } catch(err) { res.status(500).json({ erro: err.message }); }
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
    const lista = Array.isArray(data?.atendimentos?.data) ? data.atendimentos.data : [];
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
  if (s.includes('conclu') || s.includes('finaliz') || s.includes('fechado')) return 'finalizado';
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

// ── Inicializa ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 OPS360 Proxy rodando na porta ${PORT}`);
  console.log(`   Host Hubsoft: ${HUBSOFT_HOST}`);
  console.log(`   Dashboard:    http://localhost:${PORT}\n`);
});
