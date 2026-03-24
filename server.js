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

// ── Helper para chamar a API Hubsoft ─────────────────────────────
async function hubsoftGet(endpoint, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${HUBSOFT_HOST}/api/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });
  return res.data;
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
    // técnicos / usuários
    'v1/colaborador', 'v1/colaboradores', 'v1/funcionario', 'v1/funcionarios',
    'v1/atendente', 'v1/atendentes', 'v1/operador', 'v1/operadores',
    'v1/agente', 'v1/agentes', 'v1/equipe', 'v1/membro',
    // cidades / localidades
    'v1/municipio', 'v1/municipios', 'v1/localidade', 'v1/localidades',
    'v1/bairro', 'v1/regiao', 'v1/zona', 'v1/area',
    // tipos de OS / categorias
    'v1/categoria', 'v1/categorias', 'v1/tipo', 'v1/tipos',
    'v1/tipo_ordem_servico', 'v1/tipo_chamado', 'v1/assunto',
    'v1/servico', 'v1/servicos', 'v1/produto', 'v1/produtos',
    // outros
    'v1/contrato', 'v1/plano', 'v1/planos', 'v1/agenda',
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

// ── Ordens de Serviço (Chamados) ─────────────────────────────────
// Retorna OS filtradas por data, técnico, cidade, tipo
// Params: data_inicio, data_fim, tecnico_id, cidade_id, tipo_os_id, status, limit, page
app.get('/api/chamados', async (req, res) => {
  try {
    const { data_inicio, data_fim, tecnico_id, cidade_id, tipo_os_id, status, limit = 200, page = 1 } = req.query;

    // Data padrão: hoje
    const hoje = new Date().toISOString().split('T')[0];

    const params = {
      data_inicio: data_inicio || hoje,
      data_fim:    data_fim    || hoje,
      limit,
      page,
    };
    if (tecnico_id) params.tecnico_id = tecnico_id;
    if (cidade_id)  params.cidade_id  = cidade_id;
    if (tipo_os_id) params.tipo_os_id = tipo_os_id;
    if (status)     params.status     = status;

    const data = await hubsoftGet('ordem_servico', params);

    // Normaliza para o formato esperado pelo dashboard
    const chamados = (data.data || data.items || data || []).map(os => ({
      id:         `#${os.id}`,
      cli:        os.cliente?.nome_completo || os.cliente?.razao_social || 'Cliente',
      cat:        normalizarTipo(os.tipo_os?.nome || ''),
      tipo:       os.tipo_os?.nome || 'Sem tipo',
      tec:        os.tecnico?.nome || 'Sem técnico',
      cidade:     os.cidade?.nome  || os.cliente?.cidade?.nome || 'Sem cidade',
      ab:         formatarHora(os.data_inicio || os.created_at),
      slaMin:     os.tipo_os?.prazo_execucao || 240,
      st:         normalizarStatus(os.status),
      rtb:        (os.tipo_os?.nome || '').toLowerCase().includes('retrabalho'),
      rtbOrig:    os.ordem_servico_origem_id ? `#${os.ordem_servico_origem_id}` : null,
      rtbMotivo:  os.descricao_retrabalho || null,
      reagMotivo: normalizarStatus(os.status) === 'reagendado' ? (os.motivo_reagendamento || 'Reagendado') : null,
      reagDe:     normalizarStatus(os.status) === 'reagendado' ? formatarHora(os.data_inicio_original) : null,
      lat:        parseFloat(os.cliente?.latitude  || os.latitude  || 0) || null,
      lng:        parseFloat(os.cliente?.longitude || os.longitude || 0) || null,
      raw:        os, // dados completos para debug
    }));

    res.json({ ok: true, total: chamados.length, chamados, sincronizado_em: new Date().toISOString() });
  } catch (err) {
    console.error('Erro /api/chamados:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Técnicos ──────────────────────────────────────────────────────
app.get('/api/tecnicos', async (req, res) => {
  try {
    const data = await hubsoftGet('usuario', { tipo: 'tecnico', limit: 100 });
    const tecnicos = (data.data || data.items || data || []).map(t => ({
      id:   t.id,
      nome: t.nome,
    }));
    res.json({ ok: true, tecnicos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Cidades ───────────────────────────────────────────────────────
app.get('/api/cidades', async (req, res) => {
  try {
    const data = await hubsoftGet('cidade', { limit: 200 });
    const cidades = (data.data || data.items || data || []).map(c => ({
      id:   c.id,
      nome: c.nome,
    }));
    res.json({ ok: true, cidades });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Tipos de OS (categorias) ──────────────────────────────────────
app.get('/api/tipos-os', async (req, res) => {
  try {
    const data = await hubsoftGet('tipo_servico', { limit: 100 });
    const tipos = (data.data || data.items || data || []).map(t => ({
      id:   t.id,
      nome: t.nome,
      cat:  normalizarTipo(t.nome),
    }));
    res.json({ ok: true, tipos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── Resumo / KPIs do dia ──────────────────────────────────────────
app.get('/api/resumo', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const data = await hubsoftGet('ordem_servico', { data_inicio: hoje, data_fim: hoje, limit: 500 });
    const todos = data.data || data.items || data || [];

    const resumo = {
      total:      todos.length,
      execucao:   todos.filter(o => normalizarStatus(o.status) === 'execucao').length,
      aguardando: todos.filter(o => normalizarStatus(o.status) === 'aguardando').length,
      atrasado:   todos.filter(o => normalizarStatus(o.status) === 'atrasado').length,
      finalizado: todos.filter(o => normalizarStatus(o.status) === 'finalizado').length,
      reagendado: todos.filter(o => normalizarStatus(o.status) === 'reagendado').length,
      retrabalho: todos.filter(o => (o.tipo_os?.nome || '').toLowerCase().includes('retrabalho')).length,
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
  if (!nome) return 'suporte';
  const n = nome.toLowerCase();
  if (n.includes('instal')) return 'instalacao';
  if (n.includes('reparo') || n.includes('manuten') || n.includes('troca') || n.includes('conser')) return 'reparo';
  if (n.includes('mudan') || n.includes('migra') || n.includes('transfer')) return 'mudanca';
  if (n.includes('retrabalho') || n.includes('revis')) return 'retrabalho';
  return 'suporte';
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
