# OPS360 — Documentação Completa do Sistema
> Gerado em: 02/04/2026
> Versão: 1.0 — 247 commits
> Repositório: `ops360-proxy` (Railway.app)

---

## 1. VISÃO GERAL

**OPS360** é um painel de gestão operacional desenvolvido como SPA (Single Page Application) em HTML/JS puro no frontend e Node.js/Express no backend. Ele se conecta à API do **Hubsoft** (sistema de gestão de ISP) e centraliza em uma única tela todos os KPIs da operação.

| Item | Detalhe |
|---|---|
| Frontend | HTML5 + Vanilla JS (sem framework) |
| Backend | Node.js 18+ / Express 4 |
| Deploy | Railway.app (auto-deploy via GitHub push) |
| API integrada | Hubsoft (`api.lcvirtual.hubsoft.com.br`) |
| Integração futura | RHiD (RH), Fiscal, Estoque |
| Total de linhas | ~9.400 (2.710 backend + 6.690 frontend) |

---

## 2. ESTRUTURA DE ARQUIVOS

```
ops360-proxy/
├── server.js              # Backend — proxy + lógica de negócio
├── package.json           # Dependências Node.js
├── railway.toml           # Configuração de deploy
└── public/
    └── index.html         # Frontend completo (SPA)
```

### Dependências (package.json)
```json
{
  "dependencies": {
    "axios":       "^1.6.0",
    "cors":        "^2.8.5",
    "express":     "^4.18.2",
    "node-cron":   "^4.2.1",
    "nodemailer":  "^8.0.4"
  },
  "engines": { "node": ">=18.0.0" }
}
```

---

## 3. VARIÁVEIS DE AMBIENTE (Railway)

| Variável | Descrição |
|---|---|
| `HUBSOFT_HOST` | URL base da API Hubsoft |
| `HUBSOFT_CLIENT_ID` | ID do cliente OAuth |
| `HUBSOFT_CLIENT_SECRET` | Secret do cliente OAuth |
| `HUBSOFT_USERNAME` | E-mail de login |
| `HUBSOFT_PASSWORD` | Senha de login |
| `grant_type` | Tipo de grant OAuth (`password`) |
| `APPLE_ID` | Apple ID para integração CalDAV |
| `APPLE_APP_PASSWORD` | App password Apple CalDAV |
| `PORT` | Porta do servidor (padrão: 3000) |
| `OFFLINE_THRESHOLD` | Qtd de clientes offline para disparar alerta (padrão: 5) |

---

## 4. AUTENTICAÇÃO HUBSOFT

O backend usa OAuth2 com `grant_type=password`. O token é cacheado e renovado automaticamente quando expira.

```
POST {HUBSOFT_HOST}/oauth/token
  → access_token (Bearer)
  → expires_in

Todas as chamadas: Authorization: Bearer {token}
```

Funções principais:
- `getToken()` — retorna token válido (renova se expirado)
- `hubsoftGet(endpoint, params)` — GET autenticado
- `hubsoftPost(endpoint, body)` — POST autenticado
- `fetchIntegracaoClientes(token, params, maxPag)` — busca paginada de clientes

---

## 5. PÁGINAS DO PAINEL (Sidebar)

| # | Página | ID | Descrição |
|---|---|---|---|
| 1 | Dashboard | `dashboard` | Visão geral com abas rápidas |
| 2 | Comercial | `comercial` | Vendas, reativações, metas por vendedor |
| 3 | Atendimento | `atendimento` | OS abertas, por setor/atendente |
| 4 | Chamados | `chamados` | Monitoramento ao vivo de OS |
| 5 | Cancelamento / Retenção | `retencao` | Pedidos, revertidos, remoções |
| 6 | Financeiro | `financeiro` | MRR, suspensos, churn, LTV, adição líquida |
| 7 | Fiscal | `fiscal` | Em desenvolvimento (integração Hubsoft) |
| 8 | Estoque | `estoque` | Em desenvolvimento (integração Hubsoft) |
| 9 | RH | `rh` | Em desenvolvimento (integração RHiD) |
| 10 | Conexões | `conexoes` | Mapa de clientes online/offline por cidade |
| — | Tarefas | `tarefas` | Gestão de tarefas com notificações |
| — | Integrações | `integracoes` | Configurações de integrações |

---

## 6. ENDPOINTS DA API (Backend)

### 6.1 Principais

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/status` | Status do servidor |
| GET | `/api/resumo` | Resumo geral (dashboard) |
| GET | `/api/chamados` | OS abertas + paginação |
| GET | `/api/atendimentos` | Atendimentos por período |
| GET | `/api/retencao` | Pedidos de cancelamento + revertidos + remoções |
| GET | `/api/cancelamentos-servico` | Cancelamentos por período (aba Retenção) |
| GET | `/api/remocoes` | Remoções de equipamentos por período |
| GET | `/api/comercial` | Vendas, reativações, metas |
| GET | `/api/conexoes` | Clientes online/offline por cidade |
| GET | `/api/financeiro` | MRR, suspensos, churn, LTV, saúde por vendedor |
| GET | `/api/adicao-liquida` | Adição líquida mensal histórica + projeção 2026 |
| GET | `/api/fiscal` | Diagnóstico + dados de endpoints fiscais |
| GET | `/api/estoque` | Diagnóstico + dados de endpoints de estoque |
| GET | `/api/tecnicos` | Lista de técnicos |
| GET | `/api/cidades` | Lista de cidades |
| GET | `/api/usuarios-setores` | Usuários com mapeamento de setor |

### 6.2 Agenda (CalDAV Apple iCloud)

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/agenda/eventos` | Lista eventos do calendário |
| POST | `/api/agenda/criar` | Cria novo evento |

### 6.3 Tarefas (persistência local JSON)

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/tasks` | Lista todas as tarefas |
| POST | `/api/tasks` | Cria/atualiza tarefa |
| GET | `/api/tasks/calendar.ics` | Exporta tarefas como iCal |
| GET | `/api/notif-config` | Configuração de notificações |
| POST | `/api/tasks/test-notif` | Testa notificação |

### 6.4 Debug (uso interno)

| Endpoint | Descrição |
|---|---|
| `/api/diagnostico` | Testa endpoints disponíveis no Hubsoft |
| `/api/debug-os` | Estrutura de OS da API |
| `/api/debug-retencao` | Campos de atendimentos de retenção |
| `/api/debug-servico-campos` | Campos de serviço do cliente |
| `/api/comercial/debug` | Debug de clientes/vendas |
| `/api/conexoes/debug` | Debug de assinantes online |
| `/api/noc/debug` | Debug de endpoints de rede |

---

## 7. LÓGICA DE NEGÓCIO — DETALHES

### 7.1 Comercial

**Endpoint Hubsoft:** `GET /api/v1/integracao/cliente/todos`

**Cache:** `_comAllClientes` — todos os clientes ativos (~16k), renovado a cada 30min. Warm-up automático 5s após o servidor subir.

**Filtro de data:** Usa `data_venda` do serviço. **Importante:** timezone bleed corrigido — usa strings `YYYY-MM-DD` puras (sem `toISOString()`) para evitar que vendas do dia seguinte apareçam no mês anterior.

**Classificações:**
- **Nova:** `data_venda` no período + não é reativação + não cancelada
- **Reativação:** `data_habilitacao` existente e > 30 dias antes da `data_venda`
- **Cancelada:** `data_cancelamento` preenchido OU `status` contém `cancelado/rescindi`

**Metas por vendedor:** Configuradas em `getMetaVendedor()` no frontend.

**Função principal:** `buildVendasFromClientes(clientes, iniStr, fimStr)` → `buildComResult(vendas)`

---

### 7.2 Cancelamento / Retenção

**Dados carregados em paralelo:**
1. `loadRetencaoAtend()` → `/api/retencao` — pedidos de cancelamento (atendimentos)
2. `loadCancelServico()` → `/api/cancelamentos-servico` — cancelamentos de serviço
3. `loadRemocoes()` → `/api/remocoes` — remoções de equipamentos

**Atendimentos de cancelamento:**
- Tipo: apenas `"Solicitação de Cancelamento"` (independente de status)
- Revertidos: atendimentos fechados com motivo ID 75 (`cliente aceitou proposta`) ou 90
- Classificação via `desfechoOf(a)`: verifica `sf.includes('revert')` **antes** de `sf.includes('cancel')` (evita bug de "Reverteu cancelamento" ser classificado como cancelado)

**KPIs da aba:**
- Pedidos de cancelamento = total de atendimentos tipo SC
- Revertidos = fechados com MOTIVO_REVERTIDO
- Taxa de Retenção = `revertidos / total_pedidos × 100`
- Canc. Passivo = cancelamentos por motivo não-inadimplência (vermelho)
- Cancelamento Geral = total de serviços cancelados no período

**Por Origem de Contato:** Detectado por texto no campo `descricao_abertura/fechamento`:
- ChatMix → contém "chat" ou "whatsapp" ou "mix"
- Ligação → contém "liga" ou "fone" ou "telef"
- Presencial → contém "presencial" ou "recepc"

**Remoções:** OS do tipo "removido" (motivo contém "remov"), excluindo 3 motivos especiais:
- Desistência da Instalação
- Habilitado o user errado
- Troca de Titularidade

**Categorias de remoção:**
- `cancelamento` — motivo contém "cancel"
- `cobranca` — motivo contém "cobran" ou "inadimp"
- `spc` — motivo contém "spc" ou "protest"
- `outro` — demais

---

### 7.3 Financeiro

**Dados vindos de:** `buildFinanceiro()` usando `_comAllClientes` (cache compartilhado com Comercial).

**Suspensos (proxy de inadimplência):**
- Status: `suspenso_debito`, `suspenso_pedido_cliente`, `bloqueio_temporario`, `suspenso_judicial`
- `servico_bloqueado` **não** é contado (Hubsoft não exibe no dashboard como suspenso)

**Churn (cancelamentos por mês):**
- Usa filtro nativo da API: `tipo_data_cliente_servico=data_cancelamento` + range de datas
- Mesmo método da aba Cancelamento/Retenção — garante consistência
- Exclui os 3 motivos ignorados + dedup por `nome|plano|data_cancelamento`

**MRR:** Soma de `valor` de todos os serviços com `status = servico_habilitado`

**1ª Mensalidade em Risco:** Clientes habilitados nos últimos 60 dias que não estão `servico_habilitado`

**LTV Estimado:** `meses_ativo × valor_mensalidade`

**Clientes por Ano de Cadastro:**
- Todos os clientes ativos agrupados por `data_cadastro.substring(0,4)`
- Tabs clicáveis por ano, ordenados por LTV decrescente
- Filtro de nome busca em **todos os anos** simultaneamente

---

### 7.4 Adição Líquida Mensal

**Período:** Janeiro/2025 → mês anterior fechado (sempre)

**Cálculo por mês:**
```
Adição Líquida = Novas + Reativações − Cancelamentos
```

**Novas + Reativações:** `buildVendasFromClientes` filtrado por `data_venda` do mês

**Cancelamentos:** Filtro por `data_cancelamento` no Hubsoft, excluindo 3 motivos especiais

**Processamento:** Lotes de 3 meses em paralelo para não sobrecarregar a API

**Cache:** 2 horas. `?force=1` ignora cache.

**Projeção 2026:**
- Média mensal = soma dos meses fechados de 2026 / quantidade de meses
- Projeção anual = média × 12
- Estimativa Dez/26 = acumulado + (média × meses restantes)

**Gráfico:** SVG puro com barras coloridas:
- Verde claro = positivo, Vermelho claro = negativo
- Verde escuro = maior adição do período (destaque)
- Vermelho escuro = menor adição do período (destaque)

---

### 7.5 Conexões

**Endpoint Hubsoft:** `GET /api/v1/integracao/cliente/todos` (com dados de assinante/radius)

**Cache:** `_cxCache` — renovado via cron a cada 3 minutos

**Alertas automáticos:** Se ≥ 5 clientes de uma cidade ficarem offline entre dois ciclos, dispara alerta via WhatsApp

**Mapa:** Leaflet.js com geocoding por cidade (coordenadas hardcoded por cidade conhecida)

---

## 8. MAPEAMENTO DE SETORES

O mapeamento `ID_usuário → Setor` é definido em `SETOR_POR_ID` no início do `server.js`:

| Setor | IDs dos usuários |
|---|---|
| Cobrança | 326, 120, 258, 292, 218, 325, 127, 129, 261, 194, 286 |
| Comercial | 123, 115 |
| Call Center | 282, 297, 283, 329, 278, 321, 328, 299, 316 |
| Financeiro | 198, 95, 254 |

> **Para adicionar novo usuário:** editar `SETOR_POR_ID` no início do `server.js`.

---

## 9. SISTEMA DE CACHE

| Cache | Variável | TTL | Descrição |
|---|---|---|---|
| Clientes ativos | `_comAllClientes` | 30 min | ~16k clientes, warm-up automático |
| Conexões | `_cxCache` | 3 min (cron) | Clientes online/offline |
| Financeiro | `_finCache` | 30 min | MRR, suspensos, LTV |
| Adição Líquida | `_alCache` | 2h | Histórico mensal |
| Token OAuth | `tokenCache` | Até expiração | Renovado automaticamente |

---

## 10. BUGS HISTÓRICOS RESOLVIDOS

### Timezone bleed (crítico)
**Problema:** `.toISOString()` converte de UTC-3 para UTC, fazendo `2026-03-31T23:59` virar `2026-04-01T02:59`. Resultado: vendas/cancelamentos de abril apareciam no filtro de março.

**Solução:** Todas as datas são montadas como strings `YYYY-MM-DD` puras usando helpers `_d(y,m,d)` / `pd(y,m,d)` sem qualquer conversão de timezone.

**Afetou:** Comercial (`getComDates()`), Cancelamento/Retenção (`getRetDates()`), Financeiro.

---

### Duplicata de element ID
**Problema:** Dois elementos com `id="ret-cancel-geral-badge"` — o JS atualizava o primeiro (badge da tabela) e nunca o card KPI.

**Solução:** Card KPI renomeado para `ret-cancel-geral-val`.

---

### Revertidos classificados como cancelados
**Problema:** `desfechoOf()` checava `sf.includes('cancel')` antes de `sf.includes('revert')`. "Reverteu cancelamento" passava pelo check de cancel.

**Solução:** Invertida a ordem — checa `revert` primeiro.

---

### MOTIVO_REVERTIDO incorreto
**Problema:** Código usava apenas ID 90, mas o Hubsoft usa ID 75 ("cliente aceitou proposta").

**Solução:** `MOTIVO_REVERTIDO = new Set([75, 90])`

---

### Remoções mostrando mês errado
**Problema:** `renderRemocoes()` usava `chamadosDB` (sem filtro de período) e era chamada depois de `loadRemocoes()`, sobrescrevendo os dados corretos.

**Solução:** Removida a chamada de `renderRemocoes()` do fluxo de atualização de chamados.

---

### Suspensos divergindo do Hubsoft
**Problema:** `servico_bloqueado` estava no `STATUS_SUSPENSO` mas o Hubsoft não o exibe como suspenso.

**Solução:** Removido `servico_bloqueado` do Set.

---

### Churn divergindo do Hubsoft
**Problema:** Backend buscava `cancelado=sim` sem filtro de data e paginava por data de cadastro — cancelamentos recentes ficavam nas últimas páginas e nunca eram lidos.

**Solução:** Filtro nativo da API por `tipo_data_cliente_servico=data_cancelamento` com range de datas específico.

---

## 11. FUNCIONALIDADES POR PÁGINA

### Dashboard
- Abas rápidas: Chamados, Atendimento, Comercial, Cancelamento, Conexões
- Mini KPIs de cada área
- Auto-refresh a cada 30s

### Comercial
- Filtros: Mês atual, Mês anterior, 7 dias, Hoje, Período customizado
- KPIs: Total vendas, Novas, Reativações, % Reativações, Ativos, Cancelados
- Gráficos: Por cidade, Por vendedor (com barra de meta), Donut de planos, Donut de status
- Tabela de vendas com busca por cliente
- Detalhamento de cancelados: por motivo + lista
- Barra de meta por vendedor (exclui cancelamentos)
- Filtros cruzados: clicar em cidade/vendedor filtra a tabela

### Atendimento
- Por Setor (esquerda) e Por Atendente (direita)
- Colunas: Total, Resolvido (%), O.S Aberta (%)
- Por Motivo (Tipo) — rankeado
- Seção NOC separada
- Filtros cruzados: clicar em tipo filtra por atendente

### Chamados
- Monitoramento ao vivo de OS abertas
- Filtro por período, cidade, técnico, tipo
- Prioridade por cores
- Auto-refresh

### Cancelamento / Retenção
**KPIs:** Pedidos de Cancel., Revertidos, Taxa de Retenção, Canc. Passivo (vermelho), Cancelamento Geral

**Por Atendente:** Clicável → filtra lista de pedidos

**Por Origem de Contato:** ChatMix / Ligação / Presencial — detectado por texto. Clicável → filtra lista de pedidos

**Tabela de pedidos:** Todos os pedidos (sem limite), com coluna Origem

**Remoções do período:**
- 4 cards: Removido — Cancelamento, Removido — Cobrança, Removido — SPC, Removido — Outro motivo
- Cada card mostra quantidade + % do total
- Lista completa com scroll (sem limite de 100)

### Financeiro
**KPIs:** MRR Ativo, Suspensos (R$ em risco), Susp. Parcial, Churn mês atual/anterior, 1ª Mensalidade Risco

**Cancelamentos:** Mês atual e mês anterior — LTV Total, LTV Médio, Tempo Médio de Vida, Por Motivo, Lista

**Suspensos / Inadimplentes:** Lista com scroll (~5 linhas visíveis)

**1ª Mensalidade em Risco:** Por vendedor com % de risco

**Adição Líquida Mensal (Jan/2025 → presente):**
- Gráfico de barras com destaque do maior e menor mês
- Tabela por ano (Novas + Reat − Cancel = Líquido)
- Projeção 2026: acumulado, média, projeção ×12, estimativa Dez/26

**Clientes por Ano de Cadastro:**
- Tabs clicáveis por ano com contador
- Busca por nome (todos os anos)
- Ordenado por LTV decrescente

**Saúde por Vendedor:** Ativos, Suspensos, Cancelados 60d, MRR, barra de saúde %

### Fiscal
- Em desenvolvimento
- Diagnóstico automático de endpoints Hubsoft: `v1/titulo`, `v1/boleto`, `v1/nfe`, `v1/fatura`, `v1/nota_fiscal`, `v1/cobranca`, `v1/financeiro_titulo`
- Renderiza dados dinamicamente se endpoint responder

### Estoque
- Em desenvolvimento
- Diagnóstico de endpoints: `v1/item`, `v1/itens`, `v1/estoque`, `v1/produto`, `v1/material`, `v1/equipamento`
- Filtro de texto em tempo real
- KPIs: Total, Disponível, Em Uso, Estoque Crítico

### RH
- Em desenvolvimento (integração RHiD pendente)
- KPIs prontos: Headcount, Ativos, Afastados, Turnover, Absenteísmo
- Seções: Headcount por Setor, Admissões vs Desligamentos, Férias/Aniversários, Absenteísmo, Performance, Custo de Folha, Banco de Horas
- IDs de elementos definidos para preenchimento via API RHiD

### Conexões
- Mapa Leaflet interativo
- Clientes online/offline por cidade
- Alerta automático WhatsApp se ≥ 5 clientes offline
- Auto-refresh a cada 2min

### Tarefas
- Criação/edição de tarefas
- Notificações por e-mail
- Exportação para iPhone Calendar (iCal .ics)
- Persistência local em JSON

---

## 12. IDs IMPORTANTES DO FRONTEND (para integrações futuras)

### RH (aguardando RHiD)
```
rh-headcount, rh-ativos, rh-afastados, rh-turnover, rh-absenteismo
rh-setor-list, rh-movimentacao-rows, rh-ferias-aniv
rh-absenteismo-tbl, rh-performance-tbl, rh-folha-tbl, rh-horas-tbl
```

### Fiscal
```
fisc-kpi-aberto, fisc-kpi-vencido, fisc-kpi-pago, fisc-kpi-nfe
fisc-ep-list, fisc-dados-wrap, fisc-tbl-head, fisc-tbl-body
```

### Estoque
```
esq-kpi-total, esq-kpi-disp, esq-kpi-uso, esq-kpi-crit
esq-tbl-head, esq-tbl-body, esq-ep-list
```

---

## 13. DEPLOY (Railway.app)

**Fluxo:**
1. Editar `server.js` ou `public/index.html`
2. `git add . && git commit -m "mensagem"`
3. `git push origin main`
4. Railway detecta o push e faz deploy automático (~1-2min)

**URL produção:** `ops360-proxy-production.up.railway.app`

**railway.toml:**
```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

---

## 14. PRÓXIMAS INTEGRAÇÕES PREVISTAS

| Sistema | Página | Status | Observações |
|---|---|---|---|
| RHiD | RH | Pendente | Headcount, folha, banco de horas, férias |
| Hubsoft Fiscal | Fiscal | Pendente | Verificar se módulo está habilitado no contrato |
| Hubsoft Estoque | Estoque | Pendente | Endpoints `v1/item` testados — depende de licença |

---

## 15. CONVENÇÕES DE CÓDIGO

### Backend
- Todas as funções de busca paginada usam `fetchIntegracaoClientes(token, params, maxPag)`
- Cache nomeado: `_[area]Cache`, `_[area]FetchedAt`, `_[area]Fetching`
- Datas sempre em string `YYYY-MM-DD` — nunca usar `.toISOString()` para comparação de período
- `parseDate(s)` — suporta formato BR `DD/MM/YYYY` e ISO `YYYY-MM-DD`

### Frontend
- Navegação: `goPage('nomePagina', elementoNav)`
- Render: `loadX()` busca da API, `renderX(data)` atualiza o DOM
- IDs: prefixo da área (`com-`, `ret-`, `fin-`, `rh-`, etc.)
- Evitar `toISOString()` para datas de filtro — usar helpers `_d(y,m,d)` / `pd(y,m,d)`

---

*Documentação gerada automaticamente com base no código-fonte e histórico de commits do repositório ops360-proxy.*
