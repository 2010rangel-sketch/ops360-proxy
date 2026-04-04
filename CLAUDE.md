# OPS360 — Mapa do projeto para Claude (NÃO LER OS ARQUIVOS INTEIROS)

> **INSTRUÇÃO**: Antes de ler qualquer arquivo, consulte as linhas exatas aqui.
> `server.js` = 3.454 linhas / ~162 KB (~41k tokens se lido inteiro)
> `public/index.html` = 8.135 linhas / ~482 KB (~121k tokens se lido inteiro)
> Use `Read` com `offset` + `limit` para ler só o trecho necessário.

---

## Stack
- **Backend**: Node.js/Express — `server.js` — deploy no **Railway** (processo persistente, cache em RAM)
- **Frontend**: Vanilla JS SPA — `public/index.html` (CSS + HTML + JS em arquivo único) — deploy no **Vercel** (estático)
- **DB**: PostgreSQL (`kv_store`) para cache persistente; helpers `kvGet/kvSet/dbCacheGet/dbCacheSet`
- **API externa**: Hubsoft (ERP ISP) — token Bearer renovado automaticamente
- **Arquitetura**: Vercel serve só `public/index.html`; todas as chamadas `/api/*` são proxied para Railway

---

## Arquivos relevantes
| Arquivo | Linhas | Descrição |
|---|---|---|
| `server.js` | 3.454 | Proxy/API backend completo |
| `public/index.html` | 8.135 | SPA completo (CSS + HTML + JS) |
| `package.json` | ~20 | dependências |
| `package-lock.json` | — | lock file (necessário para Railway build) |
| `railway.toml` | ~5 | config deploy Railway |
| `nixpacks.toml` | ~8 | força `npm install` no build (Railway usa nixpacks) |
| `vercel.json` | ~12 | serve HTML estático + proxy `/api/*` → Railway |
| `data/tasks.json` | variável | tarefas (JSON) |

---

## MAPA server.js — seções e funções por linha

| Linhas | O que é |
|---|---|
| 1–52 | Config: mapa setor→usuário, credenciais Hubsoft, constantes iCloud |
| 53–175 | iCloud CalDAV: `icsDateTime`, `buildICS`, `parseICS`, `getCaldavInfo` |
| 176–223 | Auth Hubsoft: `getToken()` (renova token), `hubsoftGet`, `hubsoftPost` |
| 225–280 | Helpers OS: `bodyConsultaOS`, `extrairLista`, `extrairPaginacao` |
| 282–496 | Endpoints debug/raw, endpoints de usuários |
| 498–596 | **Cache Chamados**: vars `_chamadosCache`, funções `_fetchChamadosHubsoft`, `_normalizarChamados`, `_refreshChamadosHoje` |
| 597–683 | **Endpoints Chamados**: `/api/chamados` (multi-tier cache), `/api/tecnicos`, `/api/cidades`, `/api/tipos` |
| 684–898 | **Atendimentos**: cache `_atendCacheMap` (5min + DB), endpoint `/api/atendimentos` — datas BRT-anchored (`T03:00:00.000Z`) |
| 899–1058 | **Retenção**: cache `_retCacheMap` (5min + DB), endpoint `/api/retencao` |
| 1059–1165 | **Cancelamentos de Serviço**: cache `_cancelServCache` (5min por período), endpoint `/api/cancelamentos-servico` |
| 1166–1307 | **Remoções**: cache `_remCacheMap` (5min + DB), endpoint `/api/remocoes` |
| 1308–1448 | **Comercial**: `fetchIntegracaoClientes`, `buildVendasFromClientes`, `buildComResult` |
| 1449–1468 | `warmupComercial()` — aquece cache de clientes ativos no boot (não persiste no DB — array grande) |
| 1469–1570 | **Boot restore + warm-ups**: restaura caches do PostgreSQL; warm-up comercial 5s; financeiro 65s; cancelados-geral 90s; cron financeiro 25min |
| 1552–1565 | `warmupCanceladosGeral()` — cancelados históricos em background (6h TTL, não persiste no DB) |
| 1571–1730 | Endpoints debug (raramente modificados) |
| 1731–1753 | `/api/resumo` — KPIs do dia |
| 1754–1910 | **Financeiro helper**: `normalizarStatus`, `normalizarTipo`, endpoint `/api/financeiro` |
| 1911–1975 | **Tarefas CRUD**: `loadTasks`, `saveTasks`, endpoints GET/POST/PUT/DELETE |
| 1976–2120 | **Notificações**: `getNotifConfig`, `sendEmail`, `sendWhatsApp` |
| 2168–2315 | **Conexões**: `getClienteAssinante`, `buildCidadeMap`, `fetchConexoesHubsoft`, endpoint `/api/conexoes` |
| 2316–2650 | **Financeiro `buildFinanceiro()`**: análise completa; LTV usa `s.data_habilitacao` (ISO) do serviço ativo; MRR recuperado por mês |
| 2651–2870 | **Adição Líquida**: `buildAdicaoLiquida`, endpoint `/api/financeiro/adicao-liquida` |
| 2871–2920 | **Fiscal**: cache `_fiscalCache` (30min), endpoint `/api/fiscal` |
| 2921–2965 | **Estoque**: cache `_estoqueCache` (30min), endpoint `/api/estoque` |
| 2966–3170 | **RH (RHiD)**: `rhidLogin`, `rhidGet`, `buildRh`, endpoint `/api/rh` |
| 3171–3220 | Fallback arquivo (sem Postgres), storage RH endpoints |
| 3221–3340 | **PostgreSQL**: `getPool`, `dbInit`, `kvGet`, `kvSet`, `dbCacheGet`, `dbCacheSet`, `dbCacheRestore` |
| 3341–3410 | **RAX (chat agent Claude)**: endpoint `/api/rax` |
| 3413–3454 | `app.listen` / inicialização |

### Cache TTLs (server.js)
| Cache | TTL RAM | Persiste DB? |
|---|---|---|
| Chamados hoje | 20s | sim |
| Chamados histórico | 5min | sim |
| Atendimentos | 5min | sim |
| Retenção / Remoções | 5min | sim |
| Cancelamentos serviço | 5min por período | não |
| Financeiro | 30min | sim |
| Fiscal / Estoque | 30min | não |
| Comercial (clientes ativos) | 30min | **não** — array 15k+ estoura cota KV |
| Cancelados históricos | 6h | **não** — array grande |
| Conexões | ~5min | sim (só cidades, sem clientes raw) |

---

## MAPA index.html — páginas HTML por linha

| Linhas | Página |
|---|---|
| 1–502 | `<head>`: CSS completo |
| 503–714 | `id="page-dashboard"` — Dashboard |
| 715–944 | `id="page-chamados"` — Chamados ao vivo |
| 945–1087 | `id="page-atendimento"` — Atendimento |
| 1088–1158 | `id="page-conexoes"` — Conexões |
| 1159–1339 | `id="page-comercial"` — Comercial (**página inicial** — tem `class="page active"`) |
| 1340–1509 | `id="page-retencao"` — Retenção/Cancelamento |
| 1510–1702 | `id="page-financeiro"` — Financeiro |
| 1703–1742 | `id="page-fiscal"` — Fiscal |
| 1743–1783 | `id="page-estoque"` — Estoque |
| 1784–1965 | `id="page-rh"` — RH |
| 1966–2098 | `id="page-tarefas"` — Tarefas |
| 2099–2310 | `id="page-integracoes"` — Integrações |

---

## MAPA index.html — funções JS por linha

### Navegação (2311–2410)
| Linha | Função |
|---|---|
| 2327 | `goPage(id, el)` — troca de página; reseta live-pill para "Ao vivo" ao sair do Comercial |

### Chamados (2411–3545)
| Linha | Função |
|---|---|
| 2477 | `setPeriodo(p, el)` |
| 2521 | `getPeriodDates()` |
| 2555 | `buscarPeriodo()` |
| 2584 | `applyFilters()` |
| 2691 | `_makeCatCard()` |
| 2754 | `renderCatCards()` |
| 2817 | `renderStatusLanes()` |
| 2967 | `renderMainTable()` |
| 3052 | `renderFeed()` |
| 3094 | `renderTecChart()` |
| 3198 | `renderCidadeChart()` |
| 3295 | `renderDashboard()` |
| 3507 | `rebuildAll()` |
| 3591 | `buscarChamadosHubsoft(params)` |
| 3727 | `autoRefresh()` — intervalo 10s |

### Atendimento (3746–4160)
| Linha | Função |
|---|---|
| 3843 | `getAtendDates()` — retorna `{ ini, fim }` como strings `YYYY-MM-DD` (sem hora) |
| 3888 | `loadAtendimentos()` — badge: `atend-page-sync-badge` |
| 3907 | `renderAtendimentos(data)` |
| 3946 | `renderAtendimentosFiltrado()` |

### Dashboard tabs (4470–5060)
| Linha | Função |
|---|---|
| 4470 | `showDashTab()` — chama render*, incluindo `renderDashFinanceiro`, `renderDashRh` |
| 4986 | `renderDashFinanceiro()` — exibe `mrr_recup_atual`, `mrr_recup_anterior` |
| 5003 | `renderDashRh()` |
| 5026 | `renderDashConexoes()` |

### Retenção (~4340–4420)
| Linha | Função |
|---|---|
| 4340 | `loadRetencaoAtend()` — badge: `ret-atend-sync` |
| 4362 | `renderRetencao(data)` |

### Comercial (5485–5945)
| Linha | Função |
|---|---|
| 5485 | `getComDates()` |
| 5510 | `setComPeriodo(p, el)` |
| 5542 | `setComFiltro(type, val)` |
| 5570 | `renderComercialAtualiza(data)` |
| 5666 | `renderComBarras(...)` |
| 5828 | `renderComUltimas(ultimas)` |
| 5882 | `loadComercial()` — badge: `com-sync-badge`; escreve horário na live-pill do topbar; retry em 30s em erro não-403 |

### Remoções (6030–6155)
| Linha | Função |
|---|---|
| 6030 | `loadRemocoes()` |

### Conexões (6156–6370)
| Linha | Função |
|---|---|
| 6156 | `initConexoesMap()` |
| 6268 | `loadConexoes()` |

### Financeiro (6342–6755)
| Linha | Função |
|---|---|
| 6342 | `loadFinanceiro(force)` — badge: `fin-sync-badge`; retry em 20s se `motivo==='carregando'` |
| 6372 | `renderFinanceiro(d)` — preenche `fin-mrr-recup-atual`, `fin-mrr-recup-ant`, `fin-reat-atual-n`, `fin-reat-ant-n` |
| 6582 | `loadAdicaoLiquida(force)` |

### Fiscal / Estoque / RH (6755–8020)
| Linha | Função |
|---|---|
| 6750 | `loadFiscal(force)` |
| 6813 | `loadEstoque(force)` |
| 6922 | `loadRh(force)` |
| 7141 | `_aplicarRhDados(employees, nome)` — chama `renderRhDashboard()` + `renderDashRh()` |
| 7346 | `renderRhDashboard(emps)` |

### RAX + Init (~7910–8135)
| Linha | O que faz |
|---|---|
| ~7914 | `_restoreRhFromStorage()`, `_nrRestoreFromServer()`, `renderRhNR()` — init RH |
| ~7983 | RAX chat widget: `raxToggle`, `raxEnviar` (linha 8022/8053) |

---

## IDs de badges — evitar duplicatas!

| Badge ID | Onde fica | Atualizado em |
|---|---|---|
| `atend-sync-badge` | Dashboard (oculto) | `renderDashAtendimento()` |
| `atend-page-sync-badge` | Página Atendimento | `loadAtendimentos()`, `renderAtendimentos()` |
| `ret-atend-sync` | Página Retenção | `loadRetencaoAtend()`, `renderRetencao()` |
| `com-sync-badge` | Página Comercial | `loadComercial()` |
| `fin-sync-badge` | Página Financeiro | `loadFinanceiro()` |
| `lastSyncChamados` | Chamados (AO VIVO) | `rebuildAll()`, `autoRefresh()` |
| `lastSync` | Dashboard | `rebuildAll()`, `autoRefresh()` |
| `live-pill-text` | Topbar (span dentro da pill) | `loadComercial()` escreve horário; `goPage()` reseta para "Ao vivo" |

> ⚠️ NUNCA duplicar `id=` no HTML. Antes de criar um id, grep para confirmar que não existe.

---

## Variáveis globais JS importantes

```js
chamadosDB          // array todas as OS
chamadosFiltrados   // OS após filtros
filtros             // { periodo, tec, cidade, cat, st, rangeIni, rangeFim }
_atendData          // dados atendimentos
_retData            // dados retenção
_comData            // dados comerciais
_finData            // dados financeiro
_fiscData           // dados fiscal
_esqData            // dados estoque
window._rhEmployees // array funcionários RH
window._cxCidades   // [{ nome, online, offline, lat, lng }]
_cxMap              // instância Leaflet map
_comFiltro          // { type: 'cidade'|'vendedor'|'plano', val: string }
```

---

## Gotchas conhecidos
1. **IDs duplicados**: SEMPRE grep antes de criar novo `id=` — causou bugs em `atend-sync-badge` e `lastSync`
2. **Comercial é página inicial**: `id="page-comercial"` tem `class="page active"`
3. **`autoRefresh` a cada 10s**: só busca chamados se período = "hoje"
4. **Background refresh chamados**: servidor faz `_refreshChamadosHoje` a cada 15s, independente do frontend
5. **Hubsoft paginação**: `fetchIntegracaoClientes` percorre até 30 páginas de 500 clientes
6. **Fuso horário BRT (UTC-3)**: NUNCA usar `.setHours()` no servidor — o servidor Railway roda em UTC. Sempre ancorar datas BRT como `new Date(dataStr + 'T03:00:00.000Z')`. Frontend envia datas como `YYYY-MM-DD` (sem hora).
7. **Financeiro NUNCA síncrono**: `buildFinanceiro()` demora 90-120s. NUNCA fazer `await buildFinanceiro()` inline em request handler — sempre disparar em background e responder imediatamente.
8. **Não persistir arrays brutos no DB**: `_comAllClientes` (15k+) e `_comAllCancelados` nunca são salvos no DB — estouram a cota de transferência do Vercel KV. Apenas dados computados (pequenos) são persistidos.
9. **LTV usa `s.data_habilitacao` do serviço ativo**: não usar `cli.data_cadastro` (pode refletir data de atualização do cadastro). Converter para ISO `YYYY-MM-DD` antes de salvar em `dataCad` (Hubsoft retorna em `DD/MM/YYYY`). Serviços reativados têm `data_cancelamento` preenchida mas status ativo — não filtrar por `!isCan`.
10. **Comercial cancelados em try-catch**: fetch de cancelados pode falhar — fallback de array vazio. Frontend faz retry em 30s para erros não-403.
11. **Railway build**: usa Nixpacks com `nixpacks.toml` forçando `npm install` (não `npm ci`). `package-lock.json` deve estar no repo para evitar falha de build.
12. **Vercel é só estático**: `server.js` NÃO roda no Vercel. Vercel serve `public/index.html` e faz proxy de `/api/*` para Railway. Qualquer lógica de servidor deve estar no Railway.

---

## Deploy
- Push `main` → Railway (backend, processo persistente) + Vercel (frontend estático) deploy automático
- Railway reinicia servidor: caches RAM perdidos, PostgreSQL restaura em ~2s
- Boot sequence: 2s (dbInit) → 5s (warmup comercial ~55s) → 65s (warmup financeiro) → 90s (warmup cancelados-geral)
- URL Railway: `ops360-proxy-production.up.railway.app`
- URL Vercel: `ops360-proxy.vercel.app`
