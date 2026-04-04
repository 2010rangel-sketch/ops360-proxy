# OPS360 — Mapa do projeto para Claude (NÃO LER OS ARQUIVOS INTEIROS)

> **INSTRUÇÃO**: Antes de ler qualquer arquivo, consulte as linhas exatas aqui.
> `server.js` = 3.410 linhas / ~160 KB (~40k tokens se lido inteiro)
> `public/index.html` = 8.123 linhas / ~480 KB (~121k tokens se lido inteiro)
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
| `server.js` | 3.410 | Proxy/API backend completo |
| `public/index.html` | 8.123 | SPA completo (CSS + HTML + JS) |
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
| 684–898 | **Atendimentos**: cache `_atendCacheMap` (5min + DB), endpoint `/api/atendimentos` — datas BRT-anchored (`T03:00:00.000Z`) |
| 899–1058 | **Retenção**: cache `_retCacheMap` (5min + DB), endpoint `/api/retencao` |
| 1059–1165 | **Cancelamentos de Serviço**: cache `_cancelServCache` (5min por período), endpoint `/api/cancelamentos-servico` |
| 1166–1307 | **Remoções**: cache `_remCacheMap` (5min + DB), endpoint `/api/remocoes` |
| 1308–1448 | **Comercial**: `fetchIntegracaoClientes`, `buildVendasFromClientes`, `buildComResult` |
| 1449–1468 | `warmupComercial()` — aquece cache de clientes no boot |
| 1469–1560 | **Boot restore + warm-ups**: restaura todos os caches do PostgreSQL no startup; financeiro warm-up 120s; cron financeiro 25min |
| 1561–1720 | Endpoints debug (raramente modificados) |
| 1721–1743 | `/api/resumo` — KPIs do dia |
| 1744–1900 | **Financeiro helper**: `normalizarStatus`, `normalizarTipo`, endpoint `/api/financeiro` |
| 1901–1965 | **Tarefas CRUD**: `loadTasks`, `saveTasks`, endpoints GET/POST/PUT/DELETE |
| 1966–2110 | **Notificações**: `getNotifConfig`, `sendEmail`, `sendWhatsApp` |
| 2158–2305 | **Conexões**: `getClienteAssinante`, `buildCidadeMap`, `fetchConexoesHubsoft`, endpoint `/api/conexoes` |
| 2306–2610 | **Financeiro `buildFinanceiro()`**: análise completa de clientes ativos + cancelados |
| 2611–2860 | **Adição Líquida**: `buildAdicaoLiquida`, endpoint `/api/financeiro/adicao-liquida` |
| 2861–2910 | **Fiscal**: cache `_fiscalCache` (30min), endpoint `/api/fiscal` |
| 2911–2955 | **Estoque**: cache `_estoqueCache` (30min), endpoint `/api/estoque` |
| 2956–3160 | **RH (RHiD)**: `rhidLogin`, `rhidGet`, `buildRh`, endpoint `/api/rh` |
| 3161–3210 | Fallback arquivo (sem Postgres), storage RH endpoints |
| 3211–3324 | **PostgreSQL**: `getPool`, `dbInit`, `kvGet`, `kvSet`, `dbCacheGet`, `dbCacheSet`, `dbCacheRestore` |
| 3325–3400 | **RAX (chat agent Claude)**: endpoint `/api/rax` |
| 3403–3410 | `app.listen` / inicialização |

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
| Comercial (clientes) | 30min | sim |
| Conexões | ~5min | sim |

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

### Navegação (2311–2400)
| Linha | Função |
|---|---|
| 2327 | `goPage(id, el)` — troca de página; guarda stale de atendimentos só se do dia atual |

### Chamados (2401–3540)
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
| 4986 | `renderDashFinanceiro()` |
| 5003 | `renderDashRh()` |
| 5026 | `renderDashConexoes()` |

### Retenção (~4340–4420)
| Linha | Função |
|---|---|
| 4340 | `loadRetencaoAtend()` — badge: `ret-atend-sync` |
| 4362 | `renderRetencao(data)` |

### Comercial (5485–5930)
| Linha | Função |
|---|---|
| 5485 | `getComDates()` |
| 5510 | `setComPeriodo(p, el)` |
| 5542 | `setComFiltro(type, val)` |
| 5570 | `renderComercialAtualiza(data)` |
| 5666 | `renderComBarras(...)` |
| 5828 | `renderComUltimas(ultimas)` |
| 5882 | `loadComercial()` — badge: `com-sync-badge`; retry automático em 30s em caso de erro não-403 |

### Remoções (6030–6155)
| Linha | Função |
|---|---|
| 6030 | `loadRemocoes()` |

### Conexões (6156–6370)
| Linha | Função |
|---|---|
| 6156 | `initConexoesMap()` |
| 6268 | `loadConexoes()` |

### Financeiro (6342–6750)
| Linha | Função |
|---|---|
| 6342 | `loadFinanceiro(force)` — badge: `fin-sync-badge`; retry em 20s se `motivo==='carregando'` |
| 6372 | `renderFinanceiro(d)` |
| 6582 | `loadAdicaoLiquida(force)` |

### Fiscal / Estoque / RH (6750–8020)
| Linha | Função |
|---|---|
| 6750 | `loadFiscal(force)` |
| 6813 | `loadEstoque(force)` |
| 6922 | `loadRh(force)` |
| 7141 | `_aplicarRhDados(employees, nome)` — chama `renderRhDashboard()` + `renderDashRh()` |
| 7346 | `renderRhDashboard(emps)` |

### RAX + Init (~7910–8123)
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
6. **Fuso horário BRT (UTC-3)**: NUNCA usar `.setHours()` no servidor — o servidor Railway roda em UTC. Sempre ancorar datas BRT como `new Date(dataStr + 'T03:00:00.000Z')` (= meia-noite BRT). Frontend envia datas como `YYYY-MM-DD` (sem hora).
7. **Financeiro stale-while-revalidate**: se cache expirado, retorna dado antigo imediatamente e recalcula em background. Frontend detecta `motivo==='carregando'` e tenta de novo em 20s.
8. **Comercial cancelados em try-catch**: `fetchIntegracaoClientes` para cancelados pode falhar — está em try-catch com fallback de array vazio. Frontend faz retry em 30s para erros não-403.
9. **Cancelamentos-serviço cache por período**: `_cancelServCache[iniStr-fimStr]` com TTL 5min. Em erro, retorna stale se disponível.

---

## Deploy
- Push `main` → Railway (backend) + Vercel (frontend static) deploy automático
- Railway reinicia servidor: caches RAM perdidos, PostgreSQL restaura em ~2s
