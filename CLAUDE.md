# OPS360 — Mapa do projeto para Claude

> **INSTRUÇÃO CRÍTICA**: NUNCA leia `server.js` ou `public/index.html` inteiros.
> Use sempre `Read` com `offset` + `limit` para ler só o trecho necessário.
> Use `Grep` para localizar a linha exata antes de ler.
>
> `server.js`        = 5.750 linhas / ~280 KB / ~70k tokens se lido inteiro
> `public/index.html` = 11.495 linhas / ~666 KB / ~140k tokens se lido inteiro

---

## Stack

- **Backend**: Node.js/Express — `server.js` — deploy **Railway** (processo persistente, cache em RAM)
- **Frontend**: Vanilla JS SPA — `public/index.html` (CSS + HTML + JS em arquivo único)
- **DB**: PostgreSQL (`kv_store`, `ops360_users`) — helpers `kvGet/kvSet/dbCacheGet/dbCacheSet`
- **API externa**: Hubsoft (ERP ISP) — token Bearer renovado automaticamente via `hubsoftPost()`
- **Auth**: HMAC-SHA256 token; middleware global protege todas as rotas `/api/`; `_INTERNAL_TOKEN` para chamadas servidor→servidor

---

## Arquivos do núcleo (os únicos que precisam ser lidos)

| Arquivo | Linhas | Descrição |
|---|---|---|
| `server.js` | 5.750 | API backend completo — leia só trechos via Grep+offset |
| `public/index.html` | 11.495 | SPA completo — leia só trechos via Grep+offset |
| `package.json` | ~25 | dependências |

---

## Padrões obrigatórios

### Datas / Fuso horário (BRT = UTC-3)
- "Hoje" no servidor: `new Date(Date.now() - 3*60*60*1000)`
- Início do mês em BRT: `${ano}-${mes}-01T03:00:00.000Z`
- Fim do mês em BRT: `${anoProx}-${mesProx}-01T02:59:59.999Z` (1º dia do mês seguinte)
- Datas do Hubsoft chegam `DD/MM/YYYY` → converter via `parseDate()`

### Hubsoft
- SEMPRE `hubsoftPost(endpoint, body)` — retry automático + token refresh
- Paginação paralela com `pLimit` (concurrency 5)
- Cache com `lruSet(cache, key, value, maxSize=50)`

### Deploy
- Commit + push = deploy automático no Railway
- Containers são efêmeros — dados críticos só no PostgreSQL
- Alterações cirúrgicas — nunca reescrever blocos grandes

---

## Mapa rápido do server.js (linhas aproximadas)

| Região | O que tem |
|---|---|
| 1–100 | imports, auth helpers (`_hashSenha`, `_gerarToken`, `_validarToken`) |
| 100–400 | Hubsoft helpers (`getToken`, `hubsoftPost`, `parseDate`, `fetchPaginado`) |
| 400–600 | Debug endpoints (`/api/debug-*`) |
| 600–800 | Cache chamados (`_refreshChamadosCache`) |
| 800–1060 | Cancelamentos-serviço, remoções, `/api/chamados` |
| 1060–1300 | `/api/retencao` |
| 1300–1500 | `/api/cancelamentos-servico`, `/api/remocoes` |
| 1500–1970 | Vendas / Comercial helpers (`buildVendasFromClientes`) |
| 1970–2200 | Boot init, `/api/comercial` |
| 2200–2470 | Agenda / CalDAV |
| 2470–3100 | Atendimento, NPS, relatórios |
| 3100–3600 | Saúde da base (`_buildRisco`, `_buildSaudeBase`) |
| 3600–3800 | `/api/info-cancelamento` |
| 3800–4200 | Financeiro, inadimplência |
| 4200–5000 | RH, tarefas, chat |
| 5000–5750 | Analista IA (`_iaRodar`, `_iaSalvar`, `_iaFetchLocal`) |

---

## Mapa rápido do public/index.html (linhas aproximadas)

| Região | O que tem |
|---|---|
| 1–300 | `<head>`, CSS variáveis, reset |
| 300–900 | Sidebar, nav, estrutura HTML das páginas |
| 900–2000 | Páginas: Comercial, Atendimento, Chamados |
| 2000–3500 | Páginas: Retenção, Remoção, Saúde da Base |
| 3500–5000 | Páginas: RH, Agenda, IA, Financeiro |
| 5000–7000 | JS: funções de carregamento de dados por painel |
| 7000–9000 | JS: utilitários, gráficos, formatação |
| 9000–11495 | JS: auth, fetch patch, inicialização, eventos |
