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

    // Testa padrão real do Hubsoft: /acesso/paginado/{limit}?page={page}
    const endpointsAcesso = [
      'ordem_servico/acesso/paginado/10?page=1',
      'atendimento_os/acesso/paginado/10?page=1',
      'atendimento/os/acesso/paginado/10?page=1',
      'os/acesso/paginado/10?page=1',
      'ordem_servico/paginado/10?page=1',
      'ordem_servico/listar/10?page=1',
    ];

    for (const ep of endpointsAcesso) {
      try {
        const r = await axios.get(`${HUBSOFT_HOST}/api/v1/${ep}`, { headers, timeout: 8000 });
        resultados[ep] = { status: r.status, keys: Object.keys(r.data), dado: r.data };
      } catch(e) { resultados[ep] = { erro: e.response?.status, body: e.response?.data }; }
    }

    res.json(resultados);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Ordens de Serviço (Chamados) ─────────────────────────────────
app.get('/api/chamados', async (req, res) => {
  try {
    const { data_inicio, data_fim, tecnico_id, cidade_id, tipo_os_id, status, limit = 200, page = 1 } = req.query;

    // Formato de data: DD/MM/YYYY (padrão Hubsoft)
    const hoje = new Date().toLocaleDateString('pt-BR');
    const toDataBR = iso => iso ? iso.split('-').reverse().join('/') : hoje;

    const params = {
      data_inicio: data_inicio ? toDataBR(data_inicio) : hoje,
      data_fim:    data_fim    ? toDataBR(data_fim)    : hoje,
      limit,
      page,
    };
    if (tecnico_id) params.tecnico_id = tecnico_id;
    if (cidade_id)  params.cidade_id  = cidade_id;
    if (tipo_os_id) params.tipo_os_id = tipo_os_id;
    if (status)     params.status     = status;

    const data = await hubsoftGet('v1/ordem_servico', params);

    // Chave real da API Hubsoft é "ordem_servico"
    const lista = Array.isArray(data.ordem_servico)
      ? data.ordem_servico
      : (Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []));

    const chamados = lista.map(os => {
      const tipo  = os.tipo_ordem_servico?.descricao || os.tipo_os?.nome || 'Sem tipo';
      const tecs  = os.tecnicos || [];
      const tec   = tecs.map(t => t.name || t.nome || t.display).filter(Boolean).join(', ') || 'Sem técnico';
      const end   = os.atendimento?.cliente_servico?.endereco_instalacao;
      const cidade = end?.cidade?.nome || end?.cidade?.display || 'Sem cidade';
      const cidId  = end?.id_cidade || end?.cidade?.id_cidade || null;
      const cli    = os.atendimento?.cliente_servico?.display
                  || os.atendimento?.cliente_servico?.cliente?.nome_razaosocial
                  || 'Cliente';
      return {
        id:         `#${os.id_ordem_servico || os.id}`,
        cli,
        cat:        normalizarTipo(tipo),
        tipo,
        tec,
        cidade,
        cidadeId:   cidId,
        ab:         os.hora_inicio_programado || formatarHora(os.data_inicio_programado || os.data_cadastro),
        slaMin:     os.tipo_ordem_servico?.prazo_execucao || 240,
        st:         normalizarStatus(os.status),
        rtb:        tipo.toLowerCase().includes('retrabalho'),
        rtbOrig:    os.id_ordem_servico_origem ? `#${os.id_ordem_servico_origem}` : null,
        rtbMotivo:  os.descricao_retrabalho || null,
        reagMotivo: normalizarStatus(os.status) === 'reagendado' ? (os.motivo_reagendamento || 'Reagendado') : null,
        lat:        parseFloat(end?.coordenadas?.lat || 0) || null,
        lng:        parseFloat(end?.coordenadas?.lng || 0) || null,
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
    const hoje = new Date().toLocaleDateString('pt-BR');
    const data = await hubsoftGet('v1/ordem_servico', { data_inicio: hoje, data_fim: hoje, limit: 500 });
    const todos = Array.isArray(data.ordem_servico) ? data.ordem_servico : (Array.isArray(data.data) ? data.data : []);
    const mapaC = {};
    todos.forEach(os => {
      const end  = os.atendimento?.cliente_servico?.endereco_instalacao;
      const nome = end?.cidade?.nome || end?.cidade?.display;
      const id   = end?.id_cidade    || end?.cidade?.id_cidade;
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
    const hoje = new Date().toLocaleDateString('pt-BR');
    const data = await hubsoftGet('v1/ordem_servico', { data_inicio: hoje, data_fim: hoje, limit: 500 });
    const todos = Array.isArray(data.ordem_servico) ? data.ordem_servico : (Array.isArray(data.data) ? data.data : []);
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
    const hoje = new Date().toLocaleDateString('pt-BR');
    const data = await hubsoftGet('v1/ordem_servico', { data_inicio: hoje, data_fim: hoje, limit: 500 });
    const todos = Array.isArray(data.ordem_servico) ? data.ordem_servico : (Array.isArray(data.data) ? data.data : []);

    const resumo = {
      total:      todos.length,
      execucao:   todos.filter(o => normalizarStatus(o.status) === 'execucao').length,
      aguardando: todos.filter(o => normalizarStatus(o.status) === 'aguardando').length,
      atrasado:   todos.filter(o => normalizarStatus(o.status) === 'atrasado').length,
      finalizado: todos.filter(o => normalizarStatus(o.status) === 'finalizado').length,
      reagendado: todos.filter(o => normalizarStatus(o.status) === 'reagendado').length,
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
