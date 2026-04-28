# LC FIBRA 360 / OPS360 — DOCUMENTAÇÃO COMPLETA

**Versão:** 2.0 — Abril 2026  
**Stack:** Node.js + Express + Vanilla JS (SPA) + PostgreSQL  
**Deploy:** Railway.app (produção)  
**Repositório:** https://github.com/2010rangel-sketch/ops360-proxy  
**Integração principal:** Hubsoft (plataforma de gestão de ISP)

---

## RESUMO EXECUTIVO

LC Fibra 360 (OPS360) é o dashboard de operações e analytics da LC Fibra, um provedor de internet (ISP). O sistema integra dados do Hubsoft (OS, atendimentos, contratos, financeiro), PostgreSQL para persistência, e oferece uma SPA (Single Page Application) com auto-refresh de 1 minuto em todos os painéis.

**URL de produção:** Definida pelo Railway após deploy (variável `RAILWAY_STATIC_URL`)

---

## ESTRUTURA DO REPOSITÓRIO

```
ops360-proxy/
├── server.js              — Backend principal (~4.500 linhas)
├── public/
│   └── index.html         — SPA frontend (~9.400 linhas)
├── package.json           — Dependências Node.js
├── railway.toml           — Configuração de deploy Railway
├── chatmix-agent.js       — Agente de auditoria ChatMix (integração externa)
└── data/                  — Armazenamento local (fallback efêmero)
```

**Dependências principais:** express, axios, node-cron, nodemailer, pg, @anthropic-ai/sdk

---

## AUTENTICAÇÃO E USUÁRIOS

### Sistema de Auth

- **Método:** Token HMAC-SHA256 customizado (não JWT)
- **Validade do token:** 365 dias
- **Hash de senha:** SHA256 + AUTH_SECRET como salt

### Modelo de Usuário (`ops360_users`)

```sql
CREATE TABLE ops360_users (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  paginas    TEXT NOT NULL DEFAULT 'comercial',
  admin      BOOLEAN NOT NULL DEFAULT FALSE,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
)
```

**Admin padrão:**
- Email: `admin@lcfibra360.com` (env: `ADMIN_EMAIL`)
- Senha: `admin360` (env: `ADMIN_PASS`)

**Páginas disponíveis (campo `paginas`, separado por vírgula):**
```
comercial, atendimento, chamados, retencao, remocao,
financeiro, rh, saude, tarefas, integracoes
```

### Endpoints de Auth

| Rota | Método | Descrição |
|------|--------|-----------|
| `/api/auth/login` | POST | `{email, senha}` → `{ok, token, user}` |
| `/api/auth/me` | GET | Valida token → retorna usuário atual |
| `/api/auth/users` | GET | Lista usuários (admin only) |
| `/api/auth/users` | POST | Cria usuário |
| `/api/auth/users/:id` | PUT | Atualiza usuário |
| `/api/auth/users/:id` | DELETE | Remove usuário |
| `/api/user/prefs` | GET/POST | Preferências do usuário (salvo no kv_store) |

---

## BANCO DE DADOS

### Tabelas PostgreSQL

#### `kv_store` — Cache e preferências persistentes
```sql
CREATE TABLE kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Chaves usadas:**
| Chave | Conteúdo |
|-------|----------|
| `tasks` | Lista de tarefas (JSON) |
| `rh_csv` | CSV de RH enviado |
| `rh_csv_meta` | Metadados do CSV de RH |
| `rh_nr_certs` | Certificados NR (JSON) |
| `user_prefs:{id}` | Preferências por usuário |
| `cache:adicao-liquida` | Histórico mensal de net adds (persiste restarts) |
| `cache:remocoes:historico` | Histórico mensal de remoções (persiste restarts) |
| `cache:chamados:historico` | Histórico mensal de chamados (persiste restarts) |
| `cache:saude:{X}d` | Saúde da Base por período (persiste restarts) |
| `cache:comercial:*` | Cache comercial |
| `cache:financeiro` | Cache financeiro |

#### `ops360_users` — Usuários do sistema
(Ver schema acima)

### Funções de acesso ao banco

| Função | Descrição |
|--------|-----------|
| `kvGet(key)` | Lê do PostgreSQL (3 tentativas com retry) |
| `kvSet(key, value)` | Salva no PostgreSQL (3 tentativas com retry) |
| `dbCacheGet(key, ttlMs)` | Lê cache com verificação de TTL |
| `dbCacheSet(key, data)` | Salva cache com timestamp |
| `dbCacheRestore(key)` | Lê sem verificar TTL (usado no boot) |

---

## INTEGRAÇÃO HUBSOFT

### Conexão

- **Host:** `https://api.lcvirtual.hubsoft.com.br` (env: `HUBSOFT_HOST`)
- **Auth:** OAuth 2.0 (password grant)
- **Client ID:** `71` (env: `HUBSOFT_CLIENT_ID`)
- **Usuário:** `2026rangel@gmail.com` (env: `HUBSOFT_USERNAME`)
- **Token:** Cacheado em memória, renovado automaticamente quando faltam 60s para expirar

### Endpoints Hubsoft Consumidos

| Endpoint Hubsoft | Método | Uso |
|-----------------|--------|-----|
| `/oauth/token` | POST | Obter token OAuth |
| `/api/v1/ordem_servico/consultar/paginado/{size}` | POST | OS / Chamados |
| `/api/v1/atendimento/consultar/paginado/{size}` | POST | Atendimentos |
| `/api/v1/cliente_servico/consultar/paginado/{size}` | POST | Contratos / Comercial |
| `/api/v1/funcionario` | GET | Lista de técnicos |
| `/api/v1/nfe/consultar/paginado/{size}` | POST | Notas fiscais |

### Padrão de chamada Hubsoft (hubsoftPost)

Todas as chamadas usam a função `hubsoftPost(endpoint, body)` que:
1. Obtém ou renova token OAuth automaticamente
2. Faz até 2 retentativas em caso de falha
3. Extrai paginação com `extrairPaginacao()` e lista com `extrairLista()`

**NÃO usar** `_fetchChamadosHubsoftLimitado` — função legada sem timeout global, pode travar.

### CNPJs das Filiais LC Fibra

| CNPJ | Filial |
|------|--------|
| 08407644000100 | Matriz |
| 08407644000291 | Concordia do Pará |
| 08407644000372 | Ipixuna do Pará |
| 08407644000453 | Acará |
| 08407644000534 | Aurora do Pará |
| 08407644000615 | São Miguel do Guamá |
| 08407644000704 | Salinópolis |
| 08407644000887 | Nova Esperança do Piria |
| 08407644000968 | Garrafão do Norte |

---

## ESTRATÉGIA DE CACHE

### Camadas de Cache (3 níveis)

1. **Memória (variáveis JS)** — Ultra-rápido, perdido no restart do servidor
2. **PostgreSQL kv_store** — Persiste entre restarts e deploys Railway
3. **Sistema de arquivos `./data/`** — Fallback efêmero (perdido no redeploy)

### TTLs por tipo de dado

| Dado | TTL Memória | TTL PostgreSQL | Estratégia |
|------|-------------|----------------|-----------|
| Chamados (hoje) | 15s | — | Cron a cada 15s |
| Histórico Chamados Mensais | 5min | 5h | On-demand + warm-up 150s boot |
| Histórico Remoções Mensais | 5min | 5h | On-demand + warm-up 120s boot |
| Adição Líquida (net adds) | 5min | 5h | On-demand + warm-up 90s boot |
| Saúde da Base | 10min | 10min | On-demand + warm-up boot |
| Atendimentos | 5min | — | On-demand |
| Retenção | 5min | — | On-demand |
| Remoções (hoje/mês) | 5min | — | On-demand |
| Comercial | 30min | — | Stale-while-revalidate |
| Financeiro | 30min | — | Stale-while-revalidate |
| RH | 1h | — | Periódico |

### Warm-up no boot do servidor

Ao iniciar, o servidor:
1. Restaura caches do PostgreSQL (instantâneo para o usuário)
2. Agenda warm-ups proativos:
   - **90s** → busca adição líquida fresca
   - **120s** → busca remoções mensais frescas
   - **150s** → busca chamados mensais frescos
3. Renova periodicamente via `setInterval` (1h45min / 3h conforme dado)

**Padrão Stale-While-Revalidate:** Cliente recebe dado cacheado imediatamente, servidor atualiza em background. Próxima requisição já tem dado fresco.

---

## TODOS OS ENDPOINTS DA API

### Saúde / Status

```
GET  /ping                         — Keep-alive (previne cold start Railway)
GET  /api/status                   — Health check geral
GET  /api/diagnostico              — Testa todos endpoints Hubsoft
GET  /api/debug-os                 — Debug estrutura OS
GET  /api/debug-tipos-cidades      — Debug tipos e cidades
GET  /api/debug-raw                — Dados brutos Hubsoft
GET  /api/debug-retencao           — Debug retenção
GET  /api/debug-usuarios           — Debug usuários Hubsoft
GET  /api/usuarios-setores         — Lista atendentes com setores
```

### Dados Operacionais

```
GET  /api/chamados                 — OS / Chamados (params: data_inicio, data_fim, all)
GET  /api/atendimentos             — Atendimentos (params: data_inicio, data_fim, all)
GET  /api/comercial                — Vendas / pipeline (params: data_inicio, data_fim)
GET  /api/retencao                 — Retenção / cancelamento (params: data_inicio, data_fim)
GET  /api/remocoes                 — Remoções / cobranças
GET  /api/cancelamentos-servico    — Cancelamentos de contrato Hubsoft
GET  /api/financeiro               — Análise financeira (param: force=1)
GET  /api/adicao-liquida           — Net adds mensal (param: force=1)
GET  /api/saude-base               — Saúde da Base por cliente (params: dias, force=1)
GET  /api/rh                       — Dados de RH
GET  /api/rh/ponto                 — Ponto dos funcionários
GET  /api/resumo                   — KPIs rápidos do dia
```

### Dados Auxiliares

```
GET  /api/tecnicos                 — Lista de técnicos
GET  /api/cidades                  — Lista de cidades
GET  /api/tipos-os                 — Tipos de OS
```

### Gestão RH

```
GET  /api/rh/csv-store             — Busca CSV de RH salvo
POST /api/rh/csv-store             — Envia CSV de RH
GET  /api/rh/nr-certs              — Lista certificados NR
POST /api/rh/nr-certs              — Salva certificados NR
POST /api/rh/nr-certs/migrate      — Migra certificados de fonte externa
```

### Tarefas

```
GET    /api/tasks                  — Lista tarefas
POST   /api/tasks                  — Cria tarefa
PUT    /api/tasks/:id              — Atualiza tarefa
DELETE /api/tasks/:id              — Remove tarefa
POST   /api/tasks/test-notif       — Testa notificação
GET    /api/tasks/calendar.ics     — Export calendário ICS
```

### Agenda (Apple iCloud CalDAV)

```
GET    /api/agenda/eventos         — Lista eventos
POST   /api/agenda/criar           — Cria evento
DELETE /api/agenda/deletar/:uid    — Remove evento
GET    /api/agenda/debug-caldav    — Debug descoberta CalDAV
```

### Chat IA (RAX)

```
POST /api/chat                     — Conversa com agente RAX (Claude Haiku)
```

### Autenticação

```
POST   /api/auth/login             — Login {email, senha}
GET    /api/auth/me                — Valida token
GET    /api/auth/users             — Lista usuários (admin)
POST   /api/auth/users             — Cria usuário (admin)
PUT    /api/auth/users/:id         — Atualiza usuário (admin)
DELETE /api/auth/users/:id         — Remove usuário (admin)
```

### Preferências

```
GET  /api/user/prefs               — Lê preferências do usuário logado
POST /api/user/prefs               — Salva preferências
GET  /api/notif-config             — Configuração de notificações
```

---

## PAINÉIS DO DASHBOARD (FRONTEND)

### Auto-refresh e navegação

- **Auto-refresh:** Todos os painéis atualizam a cada **1 minuto** via `setInterval(_autoRefreshPagina, 60000)`
- **Navegação:** `goPage(id)` é chamado no carregamento inicial (F5/URL direta) E na navegação por menu
- **Regra:** Todo dado que precisa aparecer imediatamente no F5 deve estar no bloco `goPage()`, não apenas no auto-refresh

---

### 1. Comercial (`page-comercial`)

**Dados:** `/api/comercial`

**KPIs:** Total vendas, Novas, Reativações, % Reativações, Ativos, Cancelado s/ Instalar

**Filtros:** Mês atual, Mês anterior, Hoje, Período customizado

**Tabelas/Gráficos:**
- Por Vendedor (barras + contagem)
- Por Cidade (barras)
- Por Plano (donut)
- Por Status (donut)
- Todas as vendas (tabela pesquisável)
- Seção de Cancelamentos (condicional por mês)

---

### 2. Atendimento (`page-atendimento`)

**Dados:** `/api/atendimentos`

**KPIs:** Total, TMA médio (min), Sem OS (%), Gerou OS (%), Atendentes

**Filtros:** Período, Setor (Cobrança, Comercial, Call Center, Financeiro, NOC)

**Mapeamento de Setores por ID Hubsoft:**
- **Cobrança:** 326, 120, 258, 292, 218, 325, 127, 129, 261, 194, 286
- **Comercial:** 123, 115
- **Call Center:** 282, 297, 283, 329, 278, 321, 328, 299, 316
- **Financeiro:** 198, 95, 254

---

### 3. Chamados (`page-chamados`)

**Dados:** `/api/chamados`

**Live:** Atualiza a cada 10s (cron + polling frontend)

**Filtros:** Hoje/Amanhã/Período customizado, Técnico, Cidade, Tipo

**Componentes:**
- Kanban visual (5 colunas de status)
- Live feed de eventos
- Tabela pesquisável com chips de status
- Gráfico por hora (abertos vs fechados)
- SLA e TMA por técnico e tipo
- Produção por técnico (barra + donut)
- Chamados por cidade (barra + donut)
- **Gráfico histórico mensal** (jan/2025 → hoje) — total de chamados por mês
- Painel de Retrabalho (condicional)

**Normalização de Status:**
- `pendente`, `aguardando`, `execucao`, `finalizado`, `cancelado`, `reagendado`, `retrabalho`, `atrasado`

**SLA:** Atrasado se tempo real > 2h além do agendado

---

### 4. Retenção / Cancelamento (`page-retencao`)

**Dados:** `/api/retencao` + `/api/cancelamentos-servico` + `/api/adicao-liquida`

**KPIs:** Pedidos, Revertidos (%), Cancelados (%), Taxa de Retenção

**Layout:**
- Por Atendente
- **Cancelamento Geral do Mês** (gráfico mensal — carrega via `/api/adicao-liquida`)
- Clientes
- Tipo de Atendimento
- Por Origem de Contato
- Por Cidade

> ⚠️ O card "1ª Mensalidade em Risco" foi **removido** deste painel — está disponível apenas no painel Saúde da Base.

**Tipos de atendimento monitorados:**
- "Solicitação de Cancelamento" — cruzado com OS finalizadas Hubsoft
- "Informação sobre Cancelamento" — usa `motivo_fechamento_atendimento`

---

### 5. Remoção / Cobrança (`page-remocao`)

**Dados:** `/api/remocoes` + histórico mensal

**KPIs:** Total, Removidas, Pendentes

**Componentes:**
- Tabela: Cliente, Status, Motivo, Data Solicitação, Data Conclusão
- **Gráfico Remoções Mensais** (jan/2025 → hoje) — carrega via `loadRemocoesMensais()`
- **1ª Mensalidade** (análise de inadimplência inicial)

**Critério de remoção** (idêntico ao `/api/remocoes`):
- Status: `finalizado`
- Motivo contém: `remov`, `suspen`, `retir`, `desinstala`, `cancela`
- Data fim: último dia do mês (não o dia de hoje — para consistência de parciais)

---

### 6. Financeiro (`page-financeiro`)

**Dados:** `/api/financeiro` + `/api/adicao-liquida`

**KPIs:** Receita Bruta, Receita Líquida, Despesas, Lucro (%)

**Seções:**
- Por Plano (receita, clientes)
- Por Cidade (receita, margem %)
- Inadimplentes (count, valor)
- Clientes por Ano de Cadastro (LTV)
- Adição Líquida mensal (jan/2025 → hoje)

---

### 7. Saúde da Base (`page-saude`)

**Dados:** `/api/saude-base?dias=90` (padrão) + `/api/financeiro`

**Regra de inclusão:** Apenas clientes com **mais de 2 OS** no período (pendentes + fechadas somadas)

**Score de Saúde (0–100):**
```
score = 100
score -= min(osPendentes × 20, 50)     ← OS ainda abertas penalizam mais
score -= min(max(osFechados - 3, 0) × 5, 15)  ← acima de 3 fechadas penaliza levemente
score = clamp(0, 100)
```

**Status:**
| Score | Status |
|-------|--------|
| ≥ 80 | Atenção (amarelo) |
| < 80 | Crítico (vermelho) |

> Nota: clientes com score ≥ 80 ainda aparecem na lista pois têm > 2 OS. O status "Atenção" indica necessidade de monitoramento; "Crítico" indica problema ativo.

**Colunas da tabela:** Cliente | Cidade | Contrato | OS Pend. | OS Fech. | Saúde | Status

**Filtros disponíveis:** Busca por nome de cliente (campo de texto)

**Timeout frontend:** 60 segundos — se a API demorar mais, exibe "Timeout (60s)" em vermelho

**Painéis adicionais (dados do Financeiro):**
- 1ª Mensalidade Cheia em Risco (por vendedor + lista clientes)
- Saúde da Carteira por Vendedor (ativos, suspensos, cancelamentos, MRR)

---

### 8. RH (`page-rh`)

**Dados:** `/api/rh`, `/api/rh/ponto`, `/api/rh/csv-store`, `/api/rh/nr-certs`

**Componentes:**
- Tabela de funcionários (nome, setor, horas, extras, atrasos)
- Upload de CSV RHiD (salvo no PostgreSQL `kv_store`)
- Gestão de Certificados NR35/NR10
- Ponto individual por funcionário

---

### 9. Tarefas (`page-tarefas`)

**Dados:** `/api/tasks` (CRUD)

**Armazenamento:** PostgreSQL `kv_store` chave `tasks` (persiste entre deploys)

**Funcionalidades:**
- Criar tarefa com título, prioridade e prazo
- Marcar como concluída
- Recorrência (diária, semanal, mensal, anual) — cria próxima automaticamente ao concluir
- Export ICS para calendário

---

### 10. Integrações (`page-integracoes`)

**Componentes:**
- **RAX AI Agent** — Chat com Claude Haiku (`/api/chat`)
- **Gestão de Usuários** (admin only) — CRUD de usuários do sistema
- **Configuração de Setores** — Mapeamento atendente → setor
- **Calendário** — Apple iCloud CalDAV (se configurado)
- **Notificações** — Email / WhatsApp CallMeBot

---

## VARIÁVEIS DE AMBIENTE

### Obrigatórias

```bash
# Hubsoft
HUBSOFT_HOST=https://api.lcvirtual.hubsoft.com.br
HUBSOFT_CLIENT_ID=71
HUBSOFT_CLIENT_SECRET=<secret>
HUBSOFT_USERNAME=2026rangel@gmail.com
HUBSOFT_PASSWORD=<password>

# Banco de Dados PostgreSQL
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Autenticação
AUTH_SECRET=ops360-secret-2025
ADMIN_EMAIL=admin@lcfibra360.com
ADMIN_PASS=admin360

# Servidor
PORT=3000
NODE_ENV=production
```

### Opcionais

```bash
# IA (RAX Agent)
ANTHROPIC_API_KEY=sk-ant-...

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=user@gmail.com
SMTP_PASS=app-password
NOTIF_EMAIL=destino@email.com

# WhatsApp (CallMeBot)
WA_PHONE=5511999999999
WA_CALLMEBOT_KEY=xxxxx

# Calendário Apple iCloud
APPLE_ID=user@icloud.com
APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# ChatMix (auditoria de atendimentos)
CHATMIX_API_URL=http://localhost:5000
```

---

## DEPLOY (RAILWAY)

### `railway.toml`

```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

### Fluxo de deploy

```bash
# 1. Fazer mudanças no código
# 2. Commitar na branch beta
git add -A
git commit -m "descrição das mudanças"
git push origin beta

# 3. Promover para main (dispara deploy no Railway)
git checkout main
git merge beta
git push origin main
git checkout beta

# Railway faz deploy automaticamente (~2 minutos)
```

### Persistência no Railway

| Tipo | Persiste entre deploys? | Observação |
|------|------------------------|------------|
| PostgreSQL (DATABASE_URL) | ✅ SIM | Dados seguros |
| Memória JS (variáveis) | ❌ NÃO | Reinicializa no restart |
| Arquivos `./data/` | ❌ NÃO | Efêmero, apenas fallback |

**Por isso os caches importantes** (adição líquida, remoções, chamados, saúde) **são salvos no PostgreSQL** e restaurados automaticamente no boot.

### Checklist de Deploy (primeiro setup)

- [ ] PostgreSQL add-on provisionado no Railway
- [ ] `DATABASE_URL` configurada nas variáveis do Railway
- [ ] Credenciais Hubsoft configuradas
- [ ] `AUTH_SECRET` definido
- [ ] Testar `/api/status` após deploy
- [ ] Testar login com admin padrão (`admin@lcfibra360.com` / `admin360`)
- [ ] Trocar senha do admin padrão

---

## LÓGICA DE NEGÓCIO PRINCIPAL

### Adição Líquida (Net Adds)

- **Nova:** Contrato ativado sem histórico anterior no período
- **Reativação:** Contrato ativado com histórico de cancelamento
- **Cancelamento:** Status mudou para cancelado no período
- **Net Add:** Novas + Reativações − Cancelamentos
- **Fonte de dados:** `/api/adicao-liquida` → `buildAdicaoLiquida()`

### Remoções Mensais

- **Critério:** OS com status `finalizado` e motivo contendo `remov`, `suspen`, `retir`, `desinstala` ou `cancela`
- **Data de referência:** `data_termino_executado` → fallback `data_inicio_programado` → fallback `data_cadastro`
- **Mês parcial:** Usa sempre o último dia do mês como fim (não "hoje") para consistência entre meses
- **Fonte de dados:** `buildRemocoesMensais()` — usa até 50 páginas da Hubsoft por mês

### Chamados Mensais

- **Critério:** Todos os status de OS (campo `status_ordem_servico: []`)
- **Contagem:** `lista.length` por mês
- **Período:** Janeiro/2025 até mês atual
- **Fonte de dados:** `buildChamadosMensais()` — usa até 10 páginas por mês

### Saúde da Base

- **Filtro SQL implícito:** Apenas clientes com `(osPendentes + osFechados) > 2`
- **Algoritmo de score:** Ver seção do painel acima
- **Período padrão:** 90 dias (configurável com `?dias=N`)
- **Fonte de dados:** `hubsoftPost` com paginação até 10 páginas (5.000 OS máximo)

### Retenção

- `_retData.ultimos` → apenas "Solicitação de Cancelamento"
- `_retData.todos_atend_cancel` → ambos os tipos (Solicitação + Informação)
- `window._cancelServData` → cancelamentos de serviço Hubsoft (por motivo)
- Cross-reference por nome do cliente entre as duas fontes

### RH — Cálculo de Horas

- Horas trabalhadas calculadas a partir do CSV RHiD (upload manual)
- Horas extras = horas trabalhadas − carga horária contratual
- Absenteísmo = dias ausentes / dias úteis × 100

---

## JOBS AUTOMÁTICOS (BACKEND)

| Job | Intervalo | Função |
|-----|-----------|--------|
| Refresh Chamados (hoje) | 15s | Cron busca OS do dia |
| Keep-alive ping | 4min | Previne cold start Railway |
| Auto-refresh frontend | 1min | Atualiza painel ativo |
| Chamados polling (hoje) | 10s | `autoRefresh()` no frontend |
| Prefetch Adição Líquida | 1h45min | Mantém cache fresco |
| Prefetch Remoções Mensais | 3h | Mantém cache fresco |
| Prefetch Chamados Mensais | 3h | Mantém cache fresco |
| Warm-up boot Adição Líquida | 90s após boot | Primeiro fetch pós-restart |
| Warm-up boot Remoções | 120s após boot | Primeiro fetch pós-restart |
| Warm-up boot Chamados | 150s após boot | Primeiro fetch pós-restart |

---

## INTEGRAÇÃO CHATMIX (AUDITORIA)

O ChatMix é um sistema Python/Flask local que audita atendimentos vs POPs (Procedimentos Operacionais Padrão).

- **URL:** Configurável via `CHATMIX_API_URL` (ex: `http://localhost:5000`)
- **Endpoint consumido:** `GET /api/resultados`
- **Arquivo:** `chatmix-agent.js` (agente Node.js que intermedia a comunicação)
- **Integração:** Painel Integrações do OPS360 exibe resultados da auditoria

---

## INTEGRAÇÕES EXTERNAS

### Apple iCloud (CalDAV)

- Protocolo: WebDAV/CalDAV (RFC 4791)
- Host: `caldav.icloud.com`
- Auth: HTTP Basic com App Password
- Descoberta: PROPFIND automático para encontrar calendário

### Anthropic Claude (RAX Agent)

- Modelo: `claude-haiku-4-5-20251001`
- Persona: "RAX (Rangel Analytics X)"
- Contexto: Tem acesso a dados OPS360 via system prompt
- Endpoint: `https://api.anthropic.com/v1/messages`

### Email (Nodemailer)

- SMTP configurável (Gmail padrão)
- Usado para notificações de tarefas
- Configurável via variáveis de ambiente

### WhatsApp (CallMeBot)

- Envia notificações de tarefas via WhatsApp
- Requer conta CallMeBot vinculada ao número

---

## TROUBLESHOOTING

### Gráficos históricos (Adição Líquida, Remoções Mensais, Chamados Mensais) não aparecem no F5

**Causa:** Cache perdido no Railway restart (normal).  
**Solução:** O servidor faz warm-up automático 90–150s após boot. Aguardar ~2 minutos e pressionar F5 novamente, ou clicar "Atualizar".  
**Prevenção:** PostgreSQL configurado → dados restaurados instantaneamente no próximo restart.

### Saúde da Base demorando mais de 60s

**Causa:** API Hubsoft lenta ou muitos dados (períodos longos).  
**Comportamento:** Frontend exibe "Timeout (60s)" em vermelho após 60s.  
**Solução:** Clicar "Atualizar" quando a rede estiver mais rápida, ou aguardar cache ser populado.

### Dados não aparecem / somem após deploy

**Verificar:**
1. `DATABASE_URL` está configurada no Railway → Painel Railway → Variables
2. Acessar `/api/status` — deve mostrar DB conectado
3. Verificar logs Railway: `railway logs -f`

**Causa mais comum:** PostgreSQL não configurado → dados caem no arquivo local (efêmero)

### "Falha na autenticação com o Hubsoft"

**Verificar:**
1. `HUBSOFT_PASSWORD` e `HUBSOFT_CLIENT_SECRET` no Railway
2. Credenciais Hubsoft ainda válidas (senha não foi trocada)
3. Host `HUBSOFT_HOST` correto

### Dados desatualizados no painel

**Solução:**
- Botão "Atualizar" em qualquer painel força `?force=1`
- Todos os painéis auto-atualizam a cada 1 minuto
- Chamados atualizam a cada 10s (hoje) e a cada 1min (outros períodos)

### Usuários criados no sistema desaparecem

**Causa:** PostgreSQL desconectado — usuários eram salvos em arquivo efêmero  
**Solução:** Garantir `DATABASE_URL` configurada. Usuários são salvos em `ops360_users` (PostgreSQL) e persistem entre deploys quando o banco está configurado.

### Quantidade divergente em Remoções Mensais (mês parcial vs hoje)

**Comportamento esperado:** O gráfico mostra o total até o final do mês corrente (projeção baseada nos dados até hoje). A contagem do mês atual pode diferir da aba Remoção/Cobrança (que mostra apenas o realizado até hoje).

---

## CHANGELOG (Abril 2026)

| Data | Versão | Mudança |
|------|--------|---------|
| Abr/2026 | 2.0 | Saúde da Base: nova regra (>2 OS, score só por OS, status Atenção/Crítico) |
| Abr/2026 | 2.0 | Saúde da Base: usa hubsoftPost (robusto) + DB cache + timeout 60s frontend |
| Abr/2026 | 2.0 | Remoção do painel "1ª Mensalidade em Risco" da página Retenção |
| Abr/2026 | 2.0 | Gráfico histórico mensal de Chamados (jan/25 → hoje) |
| Abr/2026 | 2.0 | DB cache para Adição Líquida, Remoções Mensais e Chamados Mensais |
| Abr/2026 | 2.0 | Warm-up automático 90s/120s/150s após boot do servidor |
| Abr/2026 | 2.0 | Fix: gráficos históricos carregam no F5 (goPage) — não precisam aguardar 1min |
| Abr/2026 | 2.0 | Fix: buildRemocoesMensais usa fim-do-mês consistente com /api/remocoes |
| Abr/2026 | 1.5 | Integração ChatMix (auditoria de atendimentos) |

---

*Documentação gerada em 19/04/2026 — LC Fibra 360 / OPS360*
