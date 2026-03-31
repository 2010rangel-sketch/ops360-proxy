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
const HUBSOFT_CLIENT_SECRET = process.env.HUBSOFT_CLIENT_SECRET || '';
const HUBSOFT_USERNAME      = process.env.HUBSOFT_USERNAME      || '2026rangel@gmail.com';
const HUBSOFT_PASSWORD      = process.env.HUBSOFT_PASSWORD      || '';
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
          // Todas as páginas restantes em paralelo (máxima velocidade)
          const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
          const results = await Promise.all(pages.map(async pg => {
            const body = bodyConsultaOS({ data_inicio, data_fim });
            const d = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${PAGE_SIZE}?page=${pg}`, body);
            return extrairLista(d);
          }));
          for (const r of results) lista.push(...r);
          console.log(`[chamados] parallel ${pages.length} pages: total ${lista.length}`);
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
        motivoFech: (() => {
          const mf = os.motivo_fechamento;
          if (!mf) return '';
          if (typeof mf === 'string') return mf;
          if (Array.isArray(mf)) return mf.map(m => m?.descricao || m?.nome || '').filter(Boolean).join(', ');
          return mf?.descricao || mf?.nome || '';
        })(),
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

    // Agrupa por atendente (inclui setor para filtro no cliente)
    const mapaAt = {};
    parsed.forEach(a => {
      const k = a.atendente;
      if (!mapaAt[k]) mapaAt[k] = { atendente:k, setor:a.setor, total:0, comOS:0, semOS:0, tmaTot:0, tmaCount:0 };
      mapaAt[k].total++;
      if (a.temOS) mapaAt[k].comOS++; else if (a.isFechado) mapaAt[k].semOS++;
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
    res.json({
      ok: true,
      total: parsed.length,
      por_atendente, por_setor, por_tipo, clientes_recorrentes, lc_virtual, noc, periodo,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erro /api/atendimentos:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});


// ── Retenção — pedidos de cancelamento (atendimentos) por período ─
app.get('/api/retencao', async (req, res) => {
  try {
    const { data_inicio, data_fim, all } = req.query;
    const agora  = new Date();
    const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999);
    const ini = data_inicio || iniMes.toISOString();
    const fim = data_fim    || fimMes.toISOString();

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
    const MOTIVO_REVERTIDO = new Set([90]);
    const desfechoOf = (a) => {
      const sp = (a.status?.prefixo || '').toLowerCase();
      const sf = (a.status_fechamento || '').toLowerCase();
      if (!sf || sf === 'pendente' || sp === 'pendente' || sp === 'aguardando_analise') return 'pendente';
      // status_fechamento indica cancelado/rescisão diretamente
      if (sf.includes('cancel') || sf.includes('rescis')) return 'cancelado';
      const idMotivo = a.id_motivo_fechamento_atendimento;
      if (idMotivo && MOTIVO_CANCELADO.has(idMotivo)) return 'cancelado';
      if (idMotivo && MOTIVO_REVERTIDO.has(idMotivo)) return 'revertido';
      const df = (a.descricao_fechamento || '').toLowerCase();
      if (df.includes('cancel') && !df.includes('não') && !df.includes('nao') && !df.includes('não irá')) return 'cancelado';
      return 'revertido';
    };

    // Regras de classificação de tipo:
    // - SOLICITAÇÃO DE CANCELAMENTO → sempre é pedido de cancelamento
    // - CANCELAMENTO COBRANÇA → NÃO é pedido de cancelamento
    // - INFORMAÇÃO SOBRE CANCELAMENTO → só conta se desfecho = "cancelado"
    // - Outros com CANCELAMENTO/RESCISÃO → conta (pedido genérico)
    const norm = s => (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isPedidoCancelamento = (tipo, desfecho) => {
      const u = norm(tipo);
      if (u.includes('SOLICIT') && u.includes('CANCELAMENTO'))  return true;   // SOLICITAÇÃO DE CANCELAMENTO
      if (u.includes('CANCELAMENTO') && u.includes('COBRAN'))   return false;  // CANCELAMENTO COBRANÇA
      if (u.includes('INFORMA') && u.includes('CANCELAMENTO'))  return desfecho === 'cancelado'; // INFORMAÇÃO SOBRE CANCELAMENTO — só se cancelado
      if (u.includes('CANCELAMENTO') || u.includes('RESCIS'))   return true;   // outros tipos de cancelamento
      return false;
    };

    const pedidos = lista
      .map(a => {
        const tipo      = a.tipo_atendimento?.descricao || 'Sem tipo';
        const desfecho  = desfechoOf(a);
        return { _raw: a, tipo, desfecho };
      })
      .filter(({ tipo, desfecho }) => isPedidoCancelamento(tipo, desfecho))
      .map(({ _raw: a, tipo, desfecho }) => {
        const resps     = Array.isArray(a.usuarios_responsaveis) ? a.usuarios_responsaveis : [];
        const atendente = resps.map(u => u.name || u.nome).filter(Boolean).join(', ')
                       || a.usuario_fechamento?.name || a.usuario_fechamento?.nome
                       || 'Sem atendente';
        const cli       = a.cliente_servico?.cliente;
        const cliente   = cli?.nome_razaosocial || cli?.display || a.cliente_servico?.display || 'Sem cliente';
        const data      = a.data_fechamento || a.data_cadastro || null;
        const resumo    = a.descricao_fechamento || a.descricao_abertura || '';
        return { tipo, desfecho, atendente, cliente, data, resumo };
      });

    const total      = pedidos.length;
    const revertidos = pedidos.filter(p => p.desfecho === 'revertido').length;
    const cancelados = pedidos.filter(p => p.desfecho === 'cancelado').length;
    const pendentes  = pedidos.filter(p => p.desfecho === 'pendente').length;
    const fechados   = revertidos + cancelados;
    const taxa_retencao = fechados > 0 ? Math.round(revertidos / fechados * 100) : null;

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

    // Por tipo de atendimento
    const mapaTipo = {};
    pedidos.forEach(p => {
      if (!mapaTipo[p.tipo]) mapaTipo[p.tipo] = { tipo: p.tipo, total: 0, revertidos: 0, cancelados: 0 };
      mapaTipo[p.tipo].total++;
      if (p.desfecho === 'revertido') mapaTipo[p.tipo].revertidos++;
      else if (p.desfecho === 'cancelado') mapaTipo[p.tipo].cancelados++;
    });
    const por_tipo = Object.values(mapaTipo).sort((a, b) => b.total - a.total);

    const ultimos = [...pedidos]
      .sort((a, b) => (b.data || '') > (a.data || '') ? 1 : -1)
      .slice(0, 30);

    res.json({
      ok: true,
      total, revertidos, cancelados, pendentes, taxa_retencao,
      cancelamento_geral, por_motivo_cancelamento_geral,
      por_atendente, por_tipo, ultimos,
      sincronizado_em: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erro /api/retencao:', err.message);
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
let _comFetching     = false;  // lock
let _comFetchedAt    = 0;      // timestamp da última busca completa

function buildVendasFromClientes(clientes, iniStr, fimStr) {
  const iniMs = new Date(iniStr).getTime();
  const fimMs = new Date(fimStr + 'T23:59:59').getTime();
  const vendas = [];
  for (const cli of clientes) {
    const nome    = cli.nome_razaosocial || cli.nome_fantasia || '—';
    const servicos = cli.servicos || [];

    for (const s of servicos) {
      // data_venda = data real da venda (para reativações é a data atual, não retroativa)
      // Fallback: data_habilitacao, data_cadastro do serviço
      const rawVenda = s.data_venda || s.data_habilitacao || null;
      const vendaDate = rawVenda ? parseDate(rawVenda) : null;
      const vendaMs   = vendaDate ? vendaDate.getTime() : 0;
      if (!vendaMs || vendaMs < iniMs || vendaMs > fimMs) continue;

      const endInst = typeof s.endereco_instalacao === 'object' && s.endereco_instalacao
        ? s.endereco_instalacao : {};
      const cidade  = endInst.cidade || 'Desconhecida';
      const plano   = s.nome || '—';
      const status  = s.status_prefixo || '';

      const vend = s.vendedor;
      const vendedor = typeof vend === 'string' ? vend
        : (vend?.nome || vend?.name || '—');

      // Reativação: data_venda é recente (no período) mas data_habilitacao é retroativa
      // Se data_venda != data_habilitacao e habilitacao > 30 dias antes → reativação
      const habDate = s.data_habilitacao ? parseDate(s.data_habilitacao) : null;
      const habMs   = habDate ? habDate.getTime() : 0;
      // data_venda existe e é diferente da data_habilitacao em > 30 dias → reativação
      const reativacao = !!(s.data_venda && habMs && vendaMs && (vendaMs - habMs) > 30 * 86400000);

      // Serviço cancelado após a venda?
      const cancelado = !!(s.data_cancelamento && status !== 'servico_habilitado' && status !== 'ativo');

      const dataVenda = vendaDate.toISOString().split('T')[0];
      vendas.push({ cliente: nome, cidade, plano, vendedor, status, dataCad: dataVenda, dataVenda, reativacao, cancelado });
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
      if (!vendedorMap[v.vendedor]) vendedorMap[v.vendedor] = { nome: v.vendedor, total: 0, novas: 0, reat: 0 };
      vendedorMap[v.vendedor].total++;
      if (v.reativacao) vendedorMap[v.vendedor].reat++; else vendedorMap[v.vendedor].novas++;
    }
  }
  const novas      = vendas.filter(v => !v.reativacao).length;
  const reativacoes = vendas.filter(v => v.reativacao).length;
  const cancelados = vendas.filter(v => v.cancelado).length;
  const ativos     = vendas.filter(v => !v.cancelado).length;
  return {
    ok: true, fonte: 'integracao_cliente_todos',
    total: vendas.length,
    novas, reativacoes, cancelados, ativos,
    periodo: { ini: iniStr, fim: fimStr },
    cidades:    Object.values(cidadeMap).sort((a,b) => b.total - a.total),
    vendedores: Object.values(vendedorMap).sort((a,b) => b.total - a.total),
    planos:     Object.values(planoMap).sort((a,b) => b.total - a.total),
    ultimas:    vendas, // sem limite — frontend pagina/scrolla
  };
}

// Dispara busca completa em background (sem bloquear requests HTTP)
async function warmupComercial() {
  if (_comFetching) return;
  // Só rebusca se cache > 30 minutos
  if (_comAllClientes && (Date.now() - _comFetchedAt) < 1800000) return;
  _comFetching = true;
  try {
    console.log('[comercial] Iniciando warm-up em background...');
    const token    = await getToken();
    // relacoes=endereco_instalacao traz cidade; vendedor já vem no serviço por padrão
    const clientes = await fetchIntegracaoClientes(token,
      { cancelado: 'nao', relacoes: 'endereco_instalacao' }, 30);
    _comAllClientes = clientes;
    _comFetchedAt   = Date.now();
    console.log(`[comercial] Cache populado: ${clientes.length} clientes`);
  } catch(e) {
    console.warn('[comercial] Warm-up falhou:', e.message);
  }
  _comFetching = false;
}

// Inicia warm-up assim que o servidor sobe (sem await — não bloqueia)
setTimeout(() => warmupComercial().catch(console.warn), 5000);
// Warm-up de conexões logo após o comercial (10s delay para não sobrecarregar)
setTimeout(() => fetchConexoesHubsoft().catch(console.warn), 10000);
// Renova a cada 30 minutos
setInterval(() => warmupComercial().catch(console.warn), 1800000);

app.get('/api/comercial', async (req, res) => {
  try {
    const agora = new Date();
    const fmtDate = d => d.toISOString().slice(0, 10);
    const primeiroDiaMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const ultimoDiaMes   = new Date(agora.getFullYear(), agora.getMonth() + 1, 0);
    const iniStr = req.query.data_inicio || fmtDate(primeiroDiaMes);
    const fimStr = req.query.data_fim    || fmtDate(ultimoDiaMes);

    // Cache disponível → responde instantaneamente
    if (_comAllClientes) {
      const vendas = buildVendasFromClientes(_comAllClientes, iniStr, fimStr);
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

function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}
function saveTasks(tasks) {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive:true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch(e) { console.error('[tasks] save error', e.message); }
}

// ── CRUD ─────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => res.json(loadTasks()));

app.post('/api/tasks', (req, res) => {
  const tasks = loadTasks();
  const t = { ...req.body, id: Date.now().toString(), done: false, createdAt: new Date().toISOString() };
  tasks.push(t);
  saveTasks(tasks);
  res.json(t);
});

app.put('/api/tasks/:id', (req, res) => {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  tasks[idx] = { ...tasks[idx], ...req.body };
  saveTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  let tasks = loadTasks();
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveTasks(tasks);
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

    const cidades = buildCidadeMap(resultado);
    _cxCache = { clientes: resultado, cidades, ts: new Date().toISOString() };
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

  // Busca cancelados recentes (max 10 páginas = 5000)
  const token2     = await getToken();
  const canceladosRaw = await fetchIntegracaoClientes(token2, { cancelado: 'sim' }, 10);

  const agora          = new Date();
  const mesAtualIni    = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const mesAnteriorIni = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
  const mesAnteriorFim = new Date(agora.getFullYear(), agora.getMonth(), 0, 23, 59, 59);
  const h60            = new Date(agora.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Status que representam suspensão real (Hubsoft)
  const STATUS_SUSPENSO   = new Set(['suspenso_debito','suspenso_pedido_cliente','bloqueio_temporario','suspenso_judicial','servico_bloqueado']);
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

      if (isOn && dataCadCli) {
        const m = mesesEntre(dataCadCli, agora);
        ltvCandidates.push({
          nome, cidade, plano, valor,
          dataCad:    cli.data_cadastro,
          mesesAtivo: Math.round(m * 10) / 10,
          ltvDinheiro: Math.round(m * valor),
          tempoFmt:    fmtTempoFin(m),
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

  // ── Análise: cancelados ───────────────────────────────────────
  const cancelMesAtual    = [];
  const cancelMesAnterior = [];

  // Helper: processa serviço cancelado e adiciona ao mês correto
  function processaCancelado(nome, s) {
    const dc = parseDate(s.data_cancelamento);
    if (!dc) return;
    const dh    = parseDate(s.data_habilitacao);
    const valor = parseFloat(s.valor) || 0;
    const m     = mesesEntre(dh, dc);
    const obj   = {
      nome,
      motivo:           s.motivo_cancelamento || '—',
      vendedor:         getVendedorFin(s),
      cidade:           getCidadeFin(s),
      plano:            s.nome || '—',
      valor,
      dataHab:          s.data_habilitacao,
      dataCancelamento: s.data_cancelamento,
      mesesVida:        Math.round(m * 10) / 10,
      ltvDinheiro:      Math.round(m * valor),
      tempoFmt:         fmtTempoFin(m),
    };
    if (dc >= mesAtualIni)                                cancelMesAtual.push(obj);
    else if (dc >= mesAnteriorIni && dc <= mesAnteriorFim) cancelMesAnterior.push(obj);
  }

  // 1) Clientes totalmente cancelados (cancelado=sim)
  for (const cli of canceladosRaw) {
    const nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
    for (const s of (cli.servicos || [])) processaCancelado(nome, s);
  }

  // 2) Clientes ativos com serviços cancelados dentro do período (cancelou 1 serviço mas ficou com outro)
  for (const cli of ativos) {
    const nome = cli.nome_razaosocial || cli.nome_fantasia || '—';
    for (const s of (cli.servicos || [])) {
      const dc = parseDate(s.data_cancelamento);
      if (!dc) continue;
      if (dc >= mesAnteriorIni) processaCancelado(nome, s); // só captura se é recente
    }
  }

  function buildCancelStats(lista) {
    const porMotivo   = {};
    const porVendedor = {};
    lista.forEach(c => {
      porMotivo[c.motivo] = (porMotivo[c.motivo] || 0) + 1;
      if (!porVendedor[c.vendedor]) porVendedor[c.vendedor] = { vendedor: c.vendedor, n: 0, ltv: 0 };
      porVendedor[c.vendedor].n++;
      porVendedor[c.vendedor].ltv += c.ltvDinheiro;
    });
    const ltv_medio_meses = lista.length
      ? lista.reduce((s, c) => s + c.mesesVida, 0) / lista.length : 0;
    return {
      total:            lista.length,
      ltv_total:        lista.reduce((s, c) => s + c.ltvDinheiro, 0),
      ltv_medio_dinheiro: lista.length ? Math.round(lista.reduce((s,c)=>s+c.ltvDinheiro,0)/lista.length) : 0,
      ltv_medio_meses:  Math.round(ltv_medio_meses * 10) / 10,
      ltv_medio_tempo:  fmtTempoFin(ltv_medio_meses),
      valor_mensal_perdido: Math.round(lista.reduce((s, c) => s + c.valor, 0) * 100) / 100,
      por_motivo:  Object.entries(porMotivo).sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
      por_vendedor: Object.values(porVendedor).sort((a, b) => b.n - a.n),
      lista:       lista.slice(0, 100),
    };
  }

  // Saúde por vendedor (add cancelamentos)
  [...cancelMesAtual, ...cancelMesAnterior].forEach(c => {
    if (!vendMapAtivo[c.vendedor]) vendMapAtivo[c.vendedor] = { vendedor: c.vendedor, ativos: 0, suspensos: 0, parciais: 0, mrr: 0 };
    vendMapAtivo[c.vendedor].cancelados60d = (vendMapAtivo[c.vendedor].cancelados60d || 0) + 1;
  });
  const porVendedor = Object.values(vendMapAtivo)
    .filter(v => v.vendedor && v.vendedor !== '—')
    .map(v => ({
      ...v,
      cancelados60d: v.cancelados60d || 0,
      parciais:      v.parciais || 0,
      mrr:           Math.round(v.mrr * 100) / 100,
      pct_saude:     (v.ativos + v.suspensos + (v.parciais || 0)) > 0
        ? Math.round(v.ativos / (v.ativos + v.suspensos + (v.parciais || 0)) * 100) : 0,
    }))
    .sort((a, b) => b.ativos - a.ativos);

  return {
    ok: true,
    resumo: {
      mrr_total:           Math.round(mrr.total * 100) / 100,
      mrr_suspenso:        Math.round(mrr.suspenso * 100) / 100,
      mrr_parcial:         Math.round(mrr.parcial * 100) / 100,
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
    ltv_top100:          ltvCandidates.slice(0, 100),
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

app.get('/api/financeiro', async (req, res) => {
  try {
    const agora = Date.now();
    if (_finCache && (agora - _finFetchedAt) < FIN_CACHE_TTL) {
      return res.json(_finCache);
    }
    if (_finFetching) {
      if (_finCache) return res.json({ ..._finCache, cache: true });
      return res.json({ ok: false, motivo: 'carregando', info: 'Análise financeira em andamento. Aguarde ~30s.' });
    }
    _finFetching = true;
    const result      = await buildFinanceiro();
    _finCache         = result;
    _finFetchedAt     = agora;
    _finFetching      = false;
    res.json(result);
  } catch (e) {
    _finFetching = false;
    console.error('[/api/financeiro]', e.message);
    if (_finCache) return res.json({ ..._finCache, cache: true, aviso: e.message });
    res.json({ ok: false, motivo: e.message });
  }
});

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

// ── Inicializa ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 OPS360 Proxy rodando na porta ${PORT}`);
  console.log(`   Host Hubsoft: ${HUBSOFT_HOST}`);
  console.log(`   Dashboard:    http://localhost:${PORT}\n`);
});
