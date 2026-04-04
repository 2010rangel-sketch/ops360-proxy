# OPS360 — Mapa do projeto para Claude (NÃO LER OS ARQUIVOS INTEIROS)

> **INSTRUÇÃO**: Antes de ler qualquer arquivo, consulte as linhas exatas aqui.
> `server.js` = 3.365 linhas / 158 KB (~39k tokens se lido inteiro)
> `public/index.html` = 8.108 linhas / 476 KB (~120k tokens se lido inteiro)
> Use `Read` com `offset` + `limit` para ler só o trecho necessário.

---

## Stack
- **Backend**: Node.js/Express — `server.js` — deploy no Railway + Vercel
- **Frontend**: Vanilla JS SPA — `public/index.html` (CSS + HTML + JS em arquivo único)
- **DB**: PostgreSQL (`kv_store`) para cache persistente; helpers `kvGet/kvSet/dbCacheGet/dbCacheSet`
- **API externa**: Hubsoft (ERP ISP) — token Bearer renovado automaticamente

---

## Arquivos relevantes
| Arquivo | Linhas | Descrição |
|---|---|---|
| `server.js` | 3.365 | Proxy/API backend completo |
| `public/index.html` | 8.108 | SPA completo (CSS + HTML + JS) |
| `package.json` | ~20 | dependências |
| `railway.toml` | ~5 | config deploy Railway |
| `vercel.json` | ~10 | config deploy Vercel |
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
| 684–898 | **Atendimentos**: cache `_atendCacheMap` (5min), endpoint `/api/atendimentos` |
| 899–1058 | **Retenção**: cache `_retCacheMap` (5min + DB), endpoint `/api/retencao` |
| 1059–1146 | **Cancelamentos de Serviço**: endpoint `/api/cancelamento-servico` |
| 1147–1286 | **Remoções**: cache `_remCacheMap` (5min + DB), endpoint `/api/remocoes` |
| 1287–1433 | **Comercial**: `fetchIntegracaoClientes`, `buildVendasFromClientes`, `buildComResult` |
| 1434–1454 | `warmupComercial()` — aquece cache de clientes no boot |
| 1455–1561 | **Boot restore**: restaura todos os caches do PostgreSQL no startup |
| 1562–1718 | Endpoints debug (raramente modificados) |
| 1719–1741 | `/api/resumo` — KPIs do dia |
| 1742–1896 | **Financeiro helper**: `normalizarStatus`, `normalizarTipo`, endpoint `/api/financeiro` |
| 1897–1963 | **Tarefas CRUD**: `loadTasks`, `saveTasks`, endpoints GET/POST/PUT/DELETE |
| 1964–2109 | **Notificações**: `getNotifConfig`, `sendEmail`, `sendWhatsApp` |
| 2158–2300 | **Conexões**: `getClienteAssinante`, `buildCidadeMap`, `fetchConexoesHubsoft`, endpoint `/api/conexoes` |
| 2301–2608 | **Financeiro `buildFinanceiro()`**: análise completa de clientes ativos + cancelados |
| 2609–2858 | **Adição Líquida**: `buildAdicaoLiquida`, endpoint `/api/financeiro/adicao-liquida` |
| 2859–2902 | **Fiscal**: cache `_fiscalCache` (30min), endpoint `/api/fiscal` |
| 2903–2946 | **Estoque**: cache `_estoqueCache` (30min), endpoint `/api/estoque` |
| 2947–3155 | **RH (RHiD)**: `rhidLogin`, `rhidGet`, `buildRh`, endpoint `/api/rh` |
| 3156–3254 | **PostgreSQL**: `getPool`, `dbInit`, `kvGet`, `kvSet`, `dbCacheGet`, `dbCacheSet`, `dbCacheRestore` |
| 3255–3315 | Fallback arquivo (sem Postgres), storage RH |
| 3316–3352 | **RAX (chat agent Claude)**: endpoint `/api/rax` |
| 3353–3365 | `app.listen` / inicialização |

### Cache TTLs (server.js)
| Cache | TTL RAM | Persiste DB? |
|---|---|---|
| Chamados hoje | 20s | sim |
| Chamados histórico | 5min | sim |
| Atendimentos | 5min | não |
| Retenção / Remoções | 5min | sim |
| Financeiro | 30min | sim |
| Fiscal / Estoque | 30min | não |
| Comercial (clientes) | 30min | sim |
| Conexões | ~5min | sim |

---

## MAPA index.html — páginas HTML por linha

| Linhas | Página |
|---|---|
| 1–500 | `<head>`: CSS completo |
| 502–713 | `id="page-dashboard"` — Dashboard |
| 714–943 | `id="page-chamados"` — Chamados ao vivo |
| 944–1086 | `id="page-atendimento"` — Atendimento |
| 1087–1157 | `id="page-conexoes"` — Conexões |
| 1158–1338 | `id="page-comercial"` — Comercial (**página inicial** — tem `class="page active"`) |
| 1339–1508 | `id="page-retencao"` — Retenção/Cancelamento |
| 1509–1701 | `id="page-financeiro"` — Financeiro |
| 1702–1741 | `id="page-fiscal"` — Fiscal |
| 1742–1782 | `id="page-estoque"` — Estoque |
| 1783–1964 | `id="page-rh"` — RH |
| 1965–2097 | `id="page-tarefas"` — Tarefas |
| 2098–2310 | `id="page-integracoes"` — Integrações |

---

## MAPA index.html — funções JS por linha

### Navegação (2311–2393)
| Linha | Função |
|---|---|
| 2327 | `goPage(id, el)` — troca de página |

### Chamados (2394–3535)
| Linha | Função |
|---|---|
| 2475 | `setPeriodo(p, el)` |
| 2519 | `getPeriodDates()` |
| 2553 | `buscarPeriodo()` |
| 2582 | `applyFilters()` |
| 2689 | `_makeCatCard()` |
| 2752 | `renderCatCards()` |
| 2815 | `renderStatusLanes()` |
| 2965 | `renderMainTable()` |
| 3050 | `renderFeed()` |
| 3092 | `renderTecChart()` |
| 3196 | `renderCidadeChart()` |
| 3293 | `renderDashboard()` |
| 3504 | `rebuildAll()` |
| 3589 | `buscarChamadosHubsoft(params)` |
| 3725 | `autoRefresh()` — intervalo 10s |

### Atendimento (3746–3902)
| Linha | Função |
|---|---|
| 3883 | `loadAtendimentos()` — badge: `atend-page-sync-badge` |
| 3902 | `renderAtendimentos(data)` |

### Retenção (~4231–4420)
| Linha | Função |
|---|---|
| 4334 | `loadRetencaoAtend()` — badge: `ret-atend-sync` |
| 4356 | `renderRetencao(data)` |

### Comercial (5468–5934)
| Linha | Função |
|---|---|
| 5479 | `getComDates()` |
| 5504 | `setComPeriodo(p, el)` |
| 5536 | `setComFiltro(type, val)` |
| 5564 | `renderComercialAtualiza(data)` |
| 5660 | `renderComBarras(...)` |
| 5822 | `renderComUltimas(ultimas)` |
| 5876 | `loadComercial()` — badge: `com-sync-badge` |

### Remoções (5940–6102)
| Linha | Função |
|---|---|
| 6020 | `loadRemocoes()` |

### Conexões (6103–6315)
| Linha | Função |
|---|---|
| 6146 | `initConexoesMap()` |
| 6258 | `loadConexoes()` |

### Financeiro (6316–6734)
| Linha | Função |
|---|---|
| 6332 | `loadFinanceiro(force)` — badge: `fin-sync-badge` |
| 6357 | `renderFinanceiro(d)` |
| 6567 | `loadAdicaoLiquida(force)` |

### Fiscal / Estoque / RH (6735–8000)
| Linha | Função |
|---|---|
| 6735 | `loadFiscal(force)` |
| 6798 | `loadEstoque(force)` |
| 6907 | `loadRh(force)` |
| 7126 | `_aplicarRhDados(employees, nome)` — chama `renderDashRh()` |
| 7331 | `renderRhDashboard(emps)` |

### Init / AUTO-INIT (~7898–8108)
| Linha | O que faz |
|---|---|
| ~7898 | Bloco `(function(){})()` — restaura localStorage, chama `loadComercial()`, prefetch pipeline |
| ~8007 | RAX chat widget: `raxToggle`, `raxEnviar` |

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

---

## Deploy
- Push `main` → Railway (backend) + Vercel (frontend) deploy automático
- Railway reinicia servidor: caches RAM perdidos, PostgreSQL restaura em ~2s
