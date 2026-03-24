// ═══════════════════════════════════════════════════════════════
//  OPS360 — Servidor Proxy Hubsoft
//  Hospede no Railway.app — funciona sem configuração extra
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credenciais via variáveis de ambiente (configure no Railway) ──
const HUBSOFT_HOST          = process.env.HUBSOFT_HOST          || 'https://api.lcvirtual.hubsoft.com.br';
const HUBSOFT_CLIENT_ID     = process.env.HUBSOFT_CLIENT_ID     || '71';
const HUBSOFT_CLIENT_SECRET = process.env.HUBSOFT_CLIENT_SECRET || 'OOZnYHxKg5R8FHKSJpSys6N1mmb2AR1eNA0ogpbb';
const HUBSOFT_USERNAME      = process.env.HUBSOFT_USERNAME      || '2026rangel@gmail.com';
const HUBSOFT_PASSWORD      = process.env.HUBSOFT_PASSWORD      || 'Rangel26@';
const grant_type           = process.env.grant_type             || 'password';

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
  // Chave real: ordens_servico.data (paginado)
  if (Array.isArray(data.ordens_servico?.data)) return data.ordens_servico.data;
  if (Array.isArray(data.ordens_servico))       return data.ordens_servico;
  if (Array.isArray(data.ordem_servico?.data))  return data.ordem_servico.data;
  if (Array.isArray(data.ordem_servico))        return data.ordem_servico;
  if (Array.isArray(data.data))                 return data.data;
  return [];
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
      status: os.status,
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
    const { data_inicio, data_fim, limit = 200, page = 1 } = req.query;
    const body = bodyConsultaOS({ data_inicio, data_fim, limit, page });
    const data = await hubsoftPost(`v1/ordem_servico/consultar/paginado/${limit}?page=${page}`, body);
    const lista = extrairLista(data);

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
      const stVal  = os.status || '';
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
  if (s.includes('reagend') || s.includes('remarca')) return 'reagendado';
  if (s.includes('retrabalho')) return 'retrabalho';
  if (s.includes('aguard') || s.includes('pendente') || s.includes('aberto')) return 'aguardando';
  return 'aguardando';
}

// Mapeia nome do tipo de OS → categoria do dashboard
function normalizarTipo(nome) {
  if (!nome) return 'outros';
  const n = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (n.includes('instal'))                                                    return 'instalacao';
  if (n.includes('reparo') || n.includes('manuten') || n.includes('troca') || n.includes('conser')) return 'reparo';
  if (n.includes('mudan') || n.includes('migra') || n.includes('transfer'))   return 'mudanca';
  if (n.includes('retrabalho'))                                                return 'retrabalho';
  // Para qualquer outro tipo: gera slug do nome real (sem espaço/acento)
  return n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'outros';
}

function formatarHora(datetime) {
  if (!datetime) return '--:--';
  try {
    const d = new Date(datetime);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return '--:--'; }
}

// ── Inicializa ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 OPS360 Proxy rodando na porta ${PORT}`);
  console.log(`   Host Hubsoft: ${HUBSOFT_HOST}`);
  console.log(`   Dashboard:    http://localhost:${PORT}\n`);
});
