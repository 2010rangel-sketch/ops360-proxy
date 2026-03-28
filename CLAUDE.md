# OPS360 — Documentação do Projeto para Claude

## Stack
- **Backend**: Node.js/Express em `server.js` — deploy no Railway.app
- **Frontend**: Vanilla JS SPA em `public/index.html` (5.200+ linhas, arquivo único)
- **API externa**: Hubsoft (ERP de ISP) — autenticado via token Bearer

---

## Arquivos do projeto
| Arquivo | Tamanho | Para que serve |
|---|---|---|
| `server.js` | ~1.800 linhas | Proxy/API backend |
| `public/index.html` | ~5.200 linhas | SPA completo (CSS + HTML + JS) |
| `package.json` | pequeno | dependências |
| `railway.toml` | pequeno | config deploy |
| `data/tasks.json` | variável | tarefas (JSON) |

---

## Arquitetura do server.js

### Cache de startup (evita timeout no Railway)
```
setTimeout(() => warmupComercial(), 5000)      // aquece cache comercial
setTimeout(() => fetchConexoesHubsoft(), 10000) // aquece cache conexões
setInterval(() => warmupComercial(), 1800000)   // refresh a cada 30min
```

### Variáveis de cache globais
- `_cxCache` → `{ clientes, cidades, ts }` — cache de conexões
- `_cxFetching` → lock para evitar fetches paralelos
- `_comAllClientes` → cache de todos os clientes para comercial

### Endpoints principais
| Rota | Descrição |
|---|---|
| `GET /api/conexoes` | Retorna `{ ok, cidades, ts }` do `_cxCache` |
| `GET /api/comercial` | Retorna `{ ok, total, novas, reativacoes, cidades[], vendedores[], planos[], ultimas[] }` |
| `GET /api/atendimentos` | Busca atendimentos; retorna `{ total, por_atendente, por_setor, por_tipo, clientes_recorrentes, lc_virtual, noc, periodo }` |
| `GET /api/retencao` | Pedidos de cancelamento filtrados |
| `GET /api/chamados` | OS do sistema de chamados |
| `GET /api/integracao/raw` | Debug — primeiros 3 clientes com todos os campos |

### Hubsoft — endpoint de clientes
`GET /api/v1/integracao/cliente/todos?pagina=0&itens_por_pagina=500&cancelado=nao&relacoes=endereco_instalacao`
- **IMPORTANTE**: `status_conexao` e `ultima_conexao` NÃO são relações válidas
- Online = `ipv4 !== '' && ipv4 !== '0.0.0.0'` (campo nativo no objeto de serviço)
- Cidade vem de `endereco_instalacao.nome_cidade` (requer `relacoes=endereco_instalacao`)

### Atendimentos — NOC separado
- `SETORES_EXCLUIDOS = ['NOC']` — NOC não entra nos totais de atendimento
- Campo `noc` na resposta: `{ total, comOS, semOS, por_tipo[] }` — rede/infra separado
- Setor `''` (sem setor) agora é contado normalmente (era excluído por bug)

### Conexões — multi-serviço
- Cliente com múltiplos serviços: online se **qualquer** serviço tem IP válido
- Bug corrigido: antes só o 1º serviço era checado (`break` removido)

### buildComResult() / buildVendasFromClientes()
- Reativação = `s.data_cancelamento` presente + status ativo
- Vendedor = `s.vendedor` (string ou objeto com `.nome`)

---

## Arquitetura do index.html

### Navegação — SPA
```javascript
goPage('id', navEl)    // troca de página
showDashTab('nome')    // troca aba do dashboard
```

### Páginas disponíveis (IDs)
`dashboard`, `chamados`, `atendimento`, `comercial`, `retencao`, `conexoes`, `tarefas`, `integracoes`

### Dashboard — 5 abas
`chamados`, `atendimento`, `retencao`, `comercial`, `conexoes`

### Cache global do frontend
| Variável | Conteúdo |
|---|---|
| `chamadosDB` | array de todas as OS |
| `chamadosFiltrados` | OS após filtros aplicados |
| `filtros` | `{ periodo, tec, cidade, cat, st, rangeIni, rangeFim }` |
| `_atendData` | dados de atendimentos |
| `_retData` | dados de retenção |
| `_comData` | dados comerciais |
| `window._cxCidades` | cidades de conexões `[{ nome, online, offline, lat, lng }]` |
| `window._cxTs` | timestamp do cache de conexões |
| `_cxMap` | instância do Leaflet map |
| `_cxMarkers` | markers no mapa |

### Estado de filtros interativos
```javascript
_comFiltro      = { type: '', val: '' }  // 'cidade' | 'vendedor' | 'plano'
_retFiltroAt    = ''                     // atendente ativo na retenção
_retFiltroTip   = ''                     // tipo ativo na retenção
```

### Funções de filtro (Comercial)
- `setComFiltro(type, val)` — toggle filtro, re-render barras + badge
- `renderComercialFiltrado(data)` — aplica `_comFiltro` na tabela ultimas
- `renderComBarras(containerId, items, maxVal, colorNew, colorReat)` — barras clicáveis

### Funções de filtro (Retenção)
- `setRetFiltro(tipo, val)` — toggle; 'atendente' ou 'tipo', limpam um ao outro

### Interatividade implementada
| Elemento | Ação ao clicar |
|---|---|
| Barras de cidade/vendedor (Comercial) | Filtra tabela ultimas |
| Donut de planos (Comercial) | Filtra tabela ultimas |
| Linhas de ultimas vendas | Abre modal com detalhes |
| Linhas Por Atendente (Retenção) | Filtra últimos pedidos |
| Linhas Por Tipo (Retenção) | Filtra últimos pedidos |
| Cidade na lista (Conexões) | Zoom no mapa Leaflet |
| Barras de técnico (Chamados chart) | Navega p/ Chamados filtrado |
| Barras de cidade (Chamados chart) | Navega p/ Chamados filtrado |
| Bars de atendente (Dash Atendimento) | Navega p/ página Atendimento |
| Barras tipo (Dash Atendimento) | Navega p/ página Atendimento |
| Barras tipo/atendente (Dash Retenção) | Navega p/ página Retenção |
| Barras rtb técnico (Dash Chamados) | Navega p/ Chamados filtrado |
| Barras cidade/vendedor (Dash Comercial) | Set filtro + navega Comercial |
| Barras cidades (Dash Conexões) | Navega Conexões + zoom mapa |

### Modais disponíveis
- `modalClienteDetalhe` — reutilizado para: detalhes de cliente recorrente, detalhes de venda (`verDetalhesVenda(idx)`)

### Período de Chamados/Dashboard
Botões: **Hoje**, **Amanhã**, **Período** (custom) — NÃO tem "Ontem"

### Auto-refresh
- Chamados: a cada 30s quando página ativa
- Conexões: a cada 2min quando página ativa
- Atendimento: loadAtendimentos() no init

---

## Variáveis CSS (tema dark/light)
`--bg, --bg2, --bg3, --surface, --surface2, --border, --border2`
`--text, --text2, --text3`
`--accent, --accent-light, --green, --green-light, --red, --red-light`
`--amber, --amber-light, --cyan, --cyan-light, --purple, --purple-light`

---

## Deploy
- Push para `main` no GitHub → Railway faz deploy automático
- Railway reinicia o servidor em cada deploy (perde cache → warmup no startup resolve isso)
- URL Railway: configurada no frontend como `PROXY_URL`
