# OPS360 — Documentação Completa do Sistema
> Atualizado em: 03/04/2026
> Versão: 1.3 — Railway.app
> Repositório: `ops360-proxy` (GitHub: `2010rangel-sketch/ops360-proxy`)

---

## 1. VISÃO GERAL

**OPS360** é um painel de gestão operacional desenvolvido como SPA (Single Page Application) em HTML/JS puro no frontend e Node.js/Express no backend. Ele se conecta à API do **Hubsoft** (sistema de gestão de ISP) e centraliza em uma única tela todos os KPIs da operação.

| Item | Detalhe |
|---|---|
| Frontend | HTML5 + Vanilla JS (sem framework) |
| Backend | Node.js 18+ / Express 4 |
| Deploy | Railway.app (auto-deploy via GitHub push) |
| API integrada | Hubsoft (`api.lcvirtual.hubsoft.com.br`) |
| IA integrada | Anthropic Claude (`claude-opus-4-5`) via RAX |
| Clima integrado | Open-Meteo (gratuito, sem API key) |
| Integração futura | RHiD (RH), Fiscal, Estoque |
| Total de linhas | ~8.200 (backend: ~2.800 / frontend: ~8.200) |

---

## 2. ESTRUTURA DE ARQUIVOS

```
ops360-proxy/
├── server.js              # Backend — proxy + lógica de negócio + RAX
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
    "nodemailer":  "^8.0.4",
    "pg":          "^8.11.3"
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
| `ANTHROPIC_API_KEY` | Chave da API Anthropic para o agente RAX |
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
| 1 | Dashboard | `dashboard` | Visão geral com abas: Atend., Canc./Ret., Comercial, Conexões |
| 2 | Comercial | `comercial` | Vendas, reativações, metas por vendedor |
| 3 | Atendimento | `atendimento` | OS abertas, por setor/atendente |
| 4 | Chamados | `chamados` | Monitoramento ao vivo + analytics completos |
| 5 | Cancelamento / Retenção | `retencao` | Pedidos, revertidos, remoções |
| 6 | Financeiro | `financeiro` | MRR, suspensos, churn, LTV, adição líquida |
| 7 | Fiscal | `fiscal` | Em desenvolvimento (integração Hubsoft) |
| 8 | Estoque | `estoque` | Em desenvolvimento (integração Hubsoft) |
| 9 | RH | `rh` | Colaboradores, CNH, certificações NR, aniversários |
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

### 6.2 RAX — Agente de IA

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/api/chat` | Envia mensagem ao agente RAX (Anthropic Claude) |

**Body:** `{ messages: [{ role: 'user'|'assistant', content: string }] }`

**Resposta:** `{ text: string }` ou `{ erro: string }`

**Modelo:** `claude-opus-4-5` · `max_tokens: 1024`

**System prompt:** RAX (Rangel Analytics X) — agente especializado em dados do OPS360.

### 6.3 Agenda (CalDAV Apple iCloud)

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/agenda/eventos` | Lista eventos do calendário |
| POST | `/api/agenda/criar` | Cria novo evento |

### 6.4 Tarefas (persistência local JSON)

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/tasks` | Lista todas as tarefas |
| POST | `/api/tasks` | Cria/atualiza tarefa |
| GET | `/api/tasks/calendar.ics` | Exporta tarefas como iCal |
| GET | `/api/notif-config` | Configuração de notificações |
| POST | `/api/tasks/test-notif` | Testa notificação |

### 6.5 Debug (uso interno)

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

---

### 7.3 Financeiro

**Dados vindos de:** `buildFinanceiro()` usando `_comAllClientes` (cache compartilhado com Comercial).

**Suspensos (proxy de inadimplência):**
- Status: `suspenso_debito`, `suspenso_pedido_cliente`, `bloqueio_temporario`, `suspenso_judicial`
- `servico_bloqueado` **não** é contado (Hubsoft não exibe no dashboard como suspenso)

**Churn:** Filtro nativo da API por `tipo_data_cliente_servico=data_cancelamento` + range. Dedup por `nome|plano|data_cancelamento`.

**MRR:** Soma de `valor` de todos os serviços com `status = servico_habilitado`

---

### 7.4 Adição Líquida Mensal

**Período:** Janeiro/2025 → mês anterior fechado

**Cálculo por mês:**
```
Adição Líquida = Novas + Reativações − Cancelamentos
```

**Cache:** 2 horas. `?force=1` ignora cache. Lotes de 3 meses em paralelo.

**Projeção 2026:** Média mensal × 12 + estimativa Dez/26.

---

### 7.5 Conexões

**Cache:** `_cxCache` — renovado via cron a cada 3 minutos.

**Alertas automáticos:** Se ≥ 5 clientes de uma cidade ficarem offline entre dois ciclos, dispara alerta via WhatsApp.

**Mapa:** Leaflet.js com geocoding por cidade (coordenadas hardcoded por cidade conhecida).

---

### 7.6 Chamados — Analytics

A aba Chamados concentra todo o monitoramento e análise de OS. Estrutura da página:

**Seção 1 — Monitoramento ao vivo**
- Filtros: período, técnico, cidade, tipo de serviço
- Status lanes: 5 colunas (Aguardando / Em Execução / Atrasado / Reagendado / Finalizado) — sempre mostra OS de hoje
- Por cidade: lista de cidades com contagem ao vivo
- Feed de eventos ao vivo

**Seção 2 — Tabela completa filtrável**
- Chips de filtro rápido por status
- Busca por cliente, técnico ou cidade
- Colunas: # | Cliente | Tipo | Técnico | Cidade | Agendado | Início Real | Fim Real | Status
- Coluna "Agendado" exibe badge de previsão de chuva quando disponível (ver §7.7)

**Seção 3 — Analytics (movidos do Dashboard em 03/04/2026)**
- **Chamados por hora** | **SLA de Chamados** — lado a lado
- **TMA por técnico** | **TMA por tipo de chamado** — lado a lado
- **Produção por técnico** | **Chamados por cidade** — lado a lado

---

### 7.7 Previsão de Chuva nos Chamados

**API:** [Open-Meteo](https://open-meteo.com/) — gratuita, sem API key necessária.

**Funcionamento:**
1. `_wxGetCoords(cidade)` — geocodifica a cidade via `geocoding-api.open-meteo.com`
2. `_wxGetProb(lat, lon, isoDate)` — busca `precipitation_probability` horária para a data agendada
3. Cache duplo: `_wxGeoCache` (coords por cidade) + `_wxForeCache` (previsão por `lat,lon,data`)
4. Exibe badge `💧 XX%` inline na coluna Agendado e nos cards das lanes
5. Abaixo de 15% de probabilidade não exibe nada (evita poluição visual)

**Trigger:** `loadAllWeather()` chamado após cada `rebuildAll()`.

**Escopo:** Apenas chamados com `dataProgramada` ≥ hoje.

---

## 8. RAX — AGENTE DE IA

**RAX (Rangel Analytics X)** é um assistente de IA integrado ao OPS360, acessível via widget flutuante no canto inferior direito de qualquer página.

### Interface

| Elemento | Descrição |
|---|---|
| Botão flutuante | Roxo com animação de pulso — `position:fixed;bottom:24px;right:24px` |
| Painel de chat | `380px` de largura, exibe histórico de mensagens |
| Input de texto | Textarea com envio por Enter |
| Botão de voz | Microfone — abre barra de gravação estilo WhatsApp |
| Barra de voz | Inline no painel, mostra ondas animadas + timer em segundos + botão cancelar |

### Voz (WhatsApp-style)

Usa Web Speech API (`SpeechRecognition`):
1. Clique no microfone → `raxVoz()` → exibe `#rax-voice-bar` com timer
2. Reconhecimento em `pt-BR`, `interimResults: false`
3. Ao finalizar: texto transcrito vai para o input e é enviado automaticamente
4. Cancelar: botão ✕ chama `raxPararVoz()` → oculta barra

### Fluxo de mensagem

```
Frontend: raxEnviar()
  → POST /api/chat { messages: [...histórico...] }
  → Backend: axios.post Anthropic API
  → Resposta: { text: string }
  → Frontend: renderiza markdown no chat
```

### Histórico

`_raxHistory` — array em memória, mantém toda a conversa da sessão para contexto.

---

## 9. RH — GESTÃO DE PESSOAL

A aba RH é alimentada por upload de CSV e PDFs de certificação.

### Estrutura da página (3 colunas)

```
[Por Setor 220px] [Colaboradores 1fr] [Por Empresa + Tempo Médio 230px]
```

**Por Setor** (esquerda, clicável): filtra a tabela de colaboradores pelo setor selecionado.

**Colaboradores** (centro): tabela com colunas Colaborador | Cargo | Admissão | Tempo | Pendências. Filtra dinamicamente por setor ou empresa selecionados. Badge de pendências indica CNH ou NR vencida/faltando.

**Por Empresa + Tempo Médio** (direita): Por Empresa é clicável (filtra colaboradores). Tempo Médio por Setor ignora `Integração Relógio` (é apenas um usuário de sistema).

### Linha 2 — Aniversários | CNH

- **Aniversários do mês:** Colaboradores que fazem aniversário no mês corrente
- **Controle de CNH:** Data de emissão, vencimento, status (OK / Vencida / A vencer)

### Linha 3 — Certificações NR (largura total)

Controle de certificados NR de colaboradores do Suporte Técnico / Fibra.

**Setores obrigados:**
```js
NR_SETORES_OBRIGATORIOS = [
  'suporte tecnico', 'suporte técnico',
  'suporte tecnico fibra', 'suporte técnico fibra'
]
```

**Colunas da tabela NR:** Colaborador | Certificação | Emissão | Vencimento | Status | (excluir)

**Painel "Faltando NR":** Exibe badges dos colaboradores do Suporte Técnico que ainda não têm nenhum certificado cadastrado.

**Upload de PDF:**
- Upload único: extrai nome do colaborador do PDF (via PDF.js), pré-seleciona no select de todos os colaboradores ativos
- Upload múltiplo: cada PDF é processado em sequência
- Auto-preenchimento: nome extraído do texto do PDF; vencimento = emissão + 24 meses quando não encontrado

**Tipos de certificação disponíveis:**
- NR35
- NR10
- NR35 + NR10
- NR33
- NR12
- Outro

---

## 10. MAPEAMENTO DE SETORES

O mapeamento `ID_usuário → Setor` é definido em `SETOR_POR_ID` no início do `server.js`:

| Setor | IDs dos usuários |
|---|---|
| Cobrança | 326, 120, 258, 292, 218, 325, 127, 129, 261, 194, 286 |
| Comercial | 123, 115 |
| Call Center | 282, 297, 283, 329, 278, 321, 328, 299, 316 |
| Financeiro | 198, 95, 254 |

> **Para adicionar novo usuário:** editar `SETOR_POR_ID` no início do `server.js`.

---

## 11. SISTEMA DE CACHE

| Cache | Variável | TTL | Descrição |
|---|---|---|---|
| Clientes ativos | `_comAllClientes` | 30 min | ~16k clientes, warm-up automático |
| Conexões | `_cxCache` | 3 min (cron) | Clientes online/offline |
| Financeiro | `_finCache` | 30 min | MRR, suspensos, LTV |
| Adição Líquida | `_alCache` | 2h | Histórico mensal |
| Token OAuth | `tokenCache` | Até expiração | Renovado automaticamente |
| Coords de clima | `_wxGeoCache` | Sessão | Cidade → {lat, lon} via Open-Meteo geocoding |
| Previsão de chuva | `_wxForeCache` | Sessão | `lat,lon,data` → array 24h precipitation_probability |

---

## 12. BUGS HISTÓRICOS RESOLVIDOS

### Timezone bleed (crítico)
**Problema:** `.toISOString()` converte de UTC-3 para UTC, fazendo `2026-03-31T23:59` virar `2026-04-01T02:59`. Resultado: vendas/cancelamentos de abril apareciam no filtro de março.

**Solução:** Todas as datas são montadas como strings `YYYY-MM-DD` puras usando helpers `_d(y,m,d)` / `pd(y,m,d)` sem qualquer conversão de timezone.

---

### Duplicata de element ID
**Problema:** Dois elementos com `id="ret-cancel-geral-badge"` — o JS atualizava o primeiro (badge da tabela) e nunca o card KPI.

**Solução:** Card KPI renomeado para `ret-cancel-geral-val`.

---

### Revertidos classificados como cancelados
**Problema:** `desfechoOf()` checava `sf.includes('cancel')` antes de `sf.includes('revert')`.

**Solução:** Invertida a ordem — checa `revert` primeiro.

---

### MOTIVO_REVERTIDO incorreto
**Problema:** Código usava apenas ID 90, mas o Hubsoft usa ID 75 ("cliente aceitou proposta").

**Solução:** `MOTIVO_REVERTIDO = new Set([75, 90])`

---

### Remoções mostrando mês errado
**Problema:** `renderRemocoes()` usava `chamadosDB` (sem filtro de período).

**Solução:** Removida a chamada de `renderRemocoes()` do fluxo de atualização de chamados.

---

### Suspensos divergindo do Hubsoft
**Problema:** `servico_bloqueado` estava no `STATUS_SUSPENSO` mas o Hubsoft não o exibe como suspenso.

**Solução:** Removido `servico_bloqueado` do Set.

---

### Churn divergindo do Hubsoft
**Problema:** Backend buscava `cancelado=sim` sem filtro de data e paginava por data de cadastro.

**Solução:** Filtro nativo da API por `tipo_data_cliente_servico=data_cancelamento` com range de datas específico.

---

### Conteúdo sangrando no card CNH (RH)
**Problema:** Tag `</table>` ausente fazia o conteúdo da tabela de clientes vazar para dentro do card de CNH.

**Solução:** Tag de fechamento adicionada; CNH e NR separados em cards independentes.

---

### Vercel "Deployment Blocked" — Co-Authored-By
**Problema:** Commits com `Co-Authored-By: Claude Sonnet 4.6` bloqueados porque o GitHub não conseguia associar o committer.

**Solução:** Removido `Co-Authored-By` dos commits. Git configurado com `user.email = 2010rangel@gmail.com` / `user.name = 2010rangel-sketch`.

---

## 13. FUNCIONALIDADES POR PÁGINA

### Dashboard
- Abas rápidas: Atendimento, Canc./Ret., Comercial, Conexões
- Mini KPIs de cada área
- Auto-refresh a cada 30s
- **Nota:** aba "Chamados" foi removida do dashboard — analytics migrados para a página Chamados

### Comercial
- Filtros: Mês atual, Mês anterior, 7 dias, Hoje, Período customizado
- KPIs: Total vendas, Novas, Reativações, % Reativações, Ativos, Cancelados
- Gráficos: Por cidade, Por vendedor (com barra de meta), Donut de planos, Donut de status
- Tabela de vendas com busca por cliente
- Filtros cruzados: clicar em cidade/vendedor filtra a tabela

### Atendimento
- Por Setor (esquerda) e Por Atendente (direita)
- Colunas: Total, Resolvido (%), O.S Aberta (%)
- Por Motivo (Tipo) — rankeado
- Seção NOC separada
- Filtros cruzados: clicar em tipo filtra por atendente

### Chamados
- Monitoramento ao vivo com status lanes (5 colunas) — sempre mostra OS de hoje
- Previsão de chuva inline (💧 XX%) por chamado agendado — Open-Meteo
- Filtros: período, técnico, cidade, tipo, busca livre
- Feed de eventos ao vivo
- Analytics completos: Chamados por hora | SLA | TMA por técnico | TMA por tipo | Produção por técnico | Chamados por cidade

### Cancelamento / Retenção
**KPIs:** Pedidos de Cancel., Revertidos, Taxa de Retenção, Canc. Passivo, Cancelamento Geral

**Por Origem:** ChatMix / Ligação / Presencial — detectado por texto. Clicável → filtra lista.

**Remoções:** 4 categorias (Cancelamento, Cobrança, SPC, Outro)

### Financeiro
**KPIs:** MRR Ativo, Suspensos (R$ em risco), Susp. Parcial, Churn mês atual/anterior, 1ª Mensalidade Risco

**Adição Líquida Mensal:** Gráfico de barras Jan/2025 → presente + projeção 2026

**Clientes por Ano de Cadastro:** Tabs clicáveis, busca, ordenado por LTV

**Saúde por Vendedor:** Ativos, Suspensos, Cancelados 60d, MRR, barra de saúde %

### RH
- Layout 3 colunas: Por Setor | Colaboradores | Por Empresa + Tempo Médio
- Setor e Empresa clicáveis → filtram tabela de colaboradores
- Tabela de colaboradores: Cargo, Admissão, Tempo de casa, Pendências (badge)
- Tempo Médio por Setor (ignora "Integração Relógio")
- Aniversários do mês
- Controle de CNH
- Controle de certificações NR: upload único ou múltiplo de PDF, auto-extração de nome, auto-cálculo de vencimento (+24 meses), painel "Faltando NR" para Suporte Técnico

### Fiscal / Estoque
- Em desenvolvimento — diagnóstico automático de endpoints Hubsoft

### Conexões
- Mapa Leaflet interativo
- Clientes online/offline por cidade
- Alerta automático WhatsApp se ≥ 5 clientes offline
- Auto-refresh a cada 2min

### Tarefas
- Criação/edição de tarefas
- Notificações por e-mail
- Exportação para iPhone Calendar (iCal .ics)

---

## 14. IDs IMPORTANTES DO FRONTEND

### RH
```
rh-headcount, rh-ativos, rh-afastados, rh-turnover, rh-absenteismo
rh-setor-list, rh-movimentacao-rows, rh-ferias-aniv
rh-nr-faltando-wrap, rh-nr-faltando
```

### Chamados — Analytics
```
barChart, barLabels                    — Chamados por hora
dch-sla-ok, dch-sla-fora, dch-sla-bar, dch-sla-tm, dch-sla-limite — SLA
dch-filtTipo, dch-tm-tec-tbl, dch-tm-rapido, dch-tm-lento         — TMA técnico
dch-tipo-badge, dch-tm-tipo-tbl                                    — TMA tipo
tecChartPeriodo, tecBarChart, tecDonut, tecDonutLegend             — Produção técnico
cidadeChartPeriodo, cidadeBarChart, cidadeDonut, cidadeDonutLegend — Por cidade
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

### RAX
```
rax-btn       — botão flutuante
rax-panel     — painel de chat
rax-msgs      — área de mensagens
rax-input     — textarea de entrada
rax-mic       — botão de microfone
rax-voice-bar — barra de gravação estilo WhatsApp
rax-voice-timer — contador de segundos de gravação
```

---

## 15. DEPLOY (Railway.app)

**Fluxo:**
1. Editar `server.js` ou `public/index.html`
2. `git add . && git commit -m "mensagem"`
3. `git push origin main`
4. Railway detecta o push e faz deploy automático (~1-2min)

**URL produção:** `ops360-proxy-production.up.railway.app`

**Git config (local):**
```
user.email = 2010rangel@gmail.com
user.name  = 2010rangel-sketch
```

**railway.toml:**
```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3

[[volumes]]
mountPath = "/app/data"
```

---

## 16. PRÓXIMAS INTEGRAÇÕES PREVISTAS

| Sistema | Página | Status | Observações |
|---|---|---|---|
| RHiD | RH | Pendente | Headcount, folha, banco de horas, férias |
| Hubsoft Fiscal | Fiscal | Pendente | Verificar se módulo está habilitado no contrato |
| Hubsoft Estoque | Estoque | Pendente | Endpoints `v1/item` testados — depende de licença |

---

## 17. CONVENÇÕES DE CÓDIGO

### Backend
- Funções de busca paginada: `fetchIntegracaoClientes(token, params, maxPag)`
- Cache nomeado: `_[area]Cache`, `_[area]FetchedAt`, `_[area]Fetching`
- Datas: sempre string `YYYY-MM-DD` — **nunca usar `.toISOString()`** para comparação de período
- `parseDate(s)` — suporta formato BR `DD/MM/YYYY` e ISO `YYYY-MM-DD`

### Frontend
- Navegação: `goPage('nomePagina', elementoNav)`
- Render: `loadX()` busca da API, `renderX(data)` atualiza o DOM
- IDs: prefixo da área (`com-`, `ret-`, `fin-`, `rh-`, `dch-`, etc.)
- Evitar `toISOString()` para datas de filtro — usar helpers `_d(y,m,d)` / `pd(y,m,d)`
- Clima: `loadAllWeather()` após qualquer `rebuildAll()`

---

*Documentação mantida manualmente — atualizar a cada sessão de desenvolvimento.*
