---
name: Documentação Completa LC Fibra 360
description: Documentação técnica completa do sistema OPS360/LC Fibra 360 — arquitetura, páginas, APIs, banco de dados, deploy e variáveis de ambiente (v6.1 Maio 2026)
type: project
originSessionId: bfac4f3e-9d4f-4068-bfba-1c35eb1ec0c9
---
# LC FIBRA 360 / OPS360 — DOCUMENTAÇÃO TÉCNICA COMPLETA (v6.1 — 02/Mai/2026)

---

## 1. VISÃO GERAL

Sistema de gestão operacional interno do provedor de internet **LC Fibra (LC Virtual Net)**, Pará, Brasil.

- **Backend:** Node.js + Express (`server.js` — arquivo único, ~5.750 linhas)
- **Frontend:** Vanilla JS SPA (`public/index.html` — arquivo único, ~11.495 linhas)
- **Banco:** PostgreSQL (Railway) — tabelas `kv_store`, `ops360_users`, `ia_analises`
- **Deploy:** Railway — push no branch `main` dispara deploy automático (~2 min)
- **Repositório:** https://github.com/2010rangel-sketch/ops360-proxy
- **URL produção:** https://lcfibra360.up.railway.app

**Integrações externas:**
1. **Hubsoft** — ERP principal (clientes, OS, atendimentos, financeiro, fiscal)
2. **PostgreSQL** — persistência de usuários e cache
3. **ChatMix** — central de atendimento (WhatsApp/Bot)
4. **Apple iCloud CalDAV** — agenda de eventos
5. **Anthropic Claude API** — chat IA (RAX) + Analista IA automático
6. **RHID** — ponto eletrônico e RH

---

## 2. BANCO DE DADOS

### Tabela `kv_store` (Key-Value Store)
```sql
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Chaves usadas:**
| Chave | Conteúdo | TTL aplicado |
|---|---|---|
| `cache:financeiro` | Dashboard financeiro completo | 30 min |
| `cache:adicao-liquida` | Adição líquida mensal | — |
| `cache:remocoes:historico` | Histórico de remoções | — |
| `cache:chamados:historico` | Histórico de chamados | — |
| `cache:saude:{X}d` | Saúde da base por período | 60 min (stale) |
| `cache:risco:{X}` | Risco de cancelamento por dias | 5 min (server-side cron) |
| `cache:fiscal` | Dashboard fiscal completo | 2h |
| `rh_csv` | CSV de ponto eletrônico | — |
| `rh_csv_meta` | Metadados do CSV RH | — |
| `rh_nr_certs` | Certificados NR10 em JSON | — |
| `tasks` | Knowledge Base (tarefas) | — |
| `user_prefs:{user_id}` | Preferências por usuário | — |
| `ia:status` | Status do Analista IA (rodando/log) | — |

### Tabela `ops360_users`
```sql
CREATE TABLE IF NOT EXISTS ops360_users (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,  -- SHA256(senha + AUTH_SECRET)
  paginas    TEXT NOT NULL DEFAULT 'comercial',
  admin      BOOLEAN NOT NULL DEFAULT FALSE,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ DEFAULT NOW()
)
```
- Admin padrão: `admin@lcfibra360.com` / `admin360`
- `paginas` = CSV de páginas autorizadas (ex: `comercial,atendimento,chamados`)

### Tabela `ia_analises`
```sql
CREATE TABLE IF NOT EXISTS ia_analises (
  id         SERIAL PRIMARY KEY,
  painel     TEXT NOT NULL,
  data       TEXT NOT NULL,  -- YYYY-MM-DD
  resumo     TEXT,
  analise    TEXT,
  criado_em  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(painel, data)
)
```
- Gerada automaticamente todo dia às 07:00 pelo Analista IA
- Apenas painéis ativos em `_IA_PAINEIS` são retornados (RH removido)

---

## 3. AUTENTICAÇÃO

- **Token:** HMAC-SHA256 com timestamp + `AUTH_SECRET` — validade 24h
- **Hash de senha:** `SHA256(senha + AUTH_SECRET)` — via `_hashSenha(senha)`
- **Middleware global:** protege todas as rotas `/api/` exceto `AUTH_PUBLIC`
- **`AUTH_PUBLIC`:** `/ping`, `/api/auth/login`, `/api/auth/register`, `/api/tasks/calendar.ics`
- **`_INTERNAL_TOKEN`:** `_gerarToken(0)` — usado por chamadas servidor→servidor (Analista IA, warm-up); bypass automático no middleware

---

## 4. VARIÁVEIS DE AMBIENTE

| Variável | Descrição | Padrão |
|---|---|---|
| `AUTH_SECRET` | Chave hash senhas + tokens | `ops360-secret-2025` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `PORT` | Porta Express | `3000` |
| `HUBSOFT_HOST` | URL API Hubsoft | `https://api.lcvirtual.hubsoft.com.br` |
| `HUBSOFT_CLIENT_ID` | Client ID OAuth | `71` |
| `HUBSOFT_CLIENT_SECRET` | Client Secret OAuth | — |
| `HUBSOFT_USERNAME` | Email login Hubsoft | `2026rangel@gmail.com` |
| `HUBSOFT_PASSWORD` | Senha Hubsoft | — |
| `ANTHROPIC_API_KEY` | API key Claude (RAX + Analista IA) | — |
| `APPLE_ID` | Apple ID para CalDAV | — |
| `APPLE_APP_PASSWORD` | Senha app Apple | — |
| `ADMIN_EMAIL` | Email admin padrão | `admin@lcfibra360.com` |
| `ADMIN_PASS` | Senha admin padrão | `admin360` |
| `RHID_EMAIL` | Email RHID | `2026rangel@gmail.com` |
| `RHID_PASSWORD` | Senha RHID | — |
| `CHATMIX_USER/PASS/TOKEN` | Credenciais ChatMix | — |
| `CHATMIX_AGENT_SECRET` | Secret webhook ChatMix | `chatmix-agent-2026` |
| `NOTIF_EMAIL / SMTP_* / RESEND_API_KEY` | Email/notificações | — |
| `WA_PHONE / WA_FONNTE_TOKEN / WA_CALLMEBOT_KEY` | WhatsApp | — |

---

## 5. ENDPOINTS DA API

### Autenticação
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/login` | Login email/senha → token |
| GET | `/api/auth/me` | Retorna usuário autenticado |
| GET | `/api/auth/users` | Lista todos os usuários |
| POST | `/api/auth/users` | Criar usuário |
| PUT | `/api/auth/users/:id` | Atualizar usuário |
| DELETE | `/api/auth/users/:id` | Deletar usuário |

### Chamados / OS
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/chamados` | OS abertas ao vivo (com kanban) |
| GET | `/api/chamados/historico` | Histórico de chamados |
| GET | `/api/tecnicos` | Lista técnicos |
| GET | `/api/cidades` | Lista cidades |
| GET | `/api/tipos-os` | Tipos de OS |

### Atendimentos / Retenção
| GET | `/api/atendimentos` | Atendimentos de call center |
| GET | `/api/retencao` | Pedidos cancelamento, revertidos, confirmados |
| GET | `/api/cancelamentos-servico` | Cancelamentos de serviço com analytics |
| GET | `/api/remocoes` | Remoções de equipamentos |
| GET | `/api/remocoes/historico` | Histórico de remoções |
| GET | `/api/info-cancelamento?mes=X&ano=Y` | Pedidos de informação sobre cancelamento por mês/ano |

### Comercial / Financeiro / Saúde
| GET | `/api/comercial?nocache=1` | Força rebuild ignorando cache memória e PostgreSQL |
| GET | `/api/comercial` | Vendas, reativações, cancelamentos (stale-while-revalidate) |
| GET | `/api/financeiro` | MRR, LTV, inadimplência, saúde da carteira |
| GET | `/api/adicao-liquida` | Adição líquida mensal |
| GET | `/api/risco-cancelamento` | Clientes em risco (OS + atendimentos) |
| GET | `/api/saude-base` | Saúde da base por score de OS |

### Fiscal / Estoque / RH
| GET | `/api/fiscal` | NFs por mês e filial |
| GET | `/api/estoque` | Dashboard de estoque |
| GET | `/api/rh` | Dashboard RH (ponto, empresas, setores) |

### Analista IA
| GET | `/api/ia/analises` | Lista análises salvas (só painéis ativos) |
| GET | `/api/ia/paineis` | Lista painéis com análise (filtra inativos) |
| GET | `/api/ia/datas` | Datas disponíveis |
| POST | `/api/ia/rodar` | Dispara análise manual |
| GET | `/api/ia/status` | Status atual (rodando/log) |

### Misc
| GET/POST/PUT/DELETE | `/api/tasks` | CRUD tarefas |
| GET/POST/DELETE | `/api/agenda/*` | Eventos CalDAV |
| GET | `/api/chatmix` | Dados ChatMix |
| POST | `/api/chat` | Chat RAX (Claude) |
| GET | `/ping` | Health check |

---

## 6. PAINÉIS DO SISTEMA

### Saúde da Base — Pedidos de Informação sobre Cancelamento
- Endpoint: `GET /api/info-cancelamento?mes=X&ano=Y`
- Filtro por mês e ano com seletores no frontend
- Busca campo de data BRT: `mesIni = ${ano}-${mes}-01T03:00:00.000Z`, `mesFim = ${nextYear}-${nextMes}-01T02:59:59.999Z`
- Filtro de tipo: `u.includes('INFORMA') && u.includes('CANCELAMENTO')`
- Exclui registros LC Virtual Net
- Retorna: `{ ok, mes, ano, total, lista: [{nome, cidade, telefone, atendente, data, desfecho, motivo}] }`
- Frontend: busca por cliente ou atendente via `_icFiltrar()`

### Saúde da Base — Risco de Cancelamento
- Busca paralela: OS + atendimentos dos últimos X dias (chips 30/60/90/120d)
- Agrupa por `id_cliente_servico` — cliente aparece se ≥2 chamados OU ≥2 atendimentos
- Risco Crítico: total ≥ 4 ou chamados ≥ 3 ou atendimentos ≥ 3
- Tipos de atendimento ignorados: `REMOCAO, COBRANCA, DISPARO, ATUALIZACAO FINANCEIRA, CAMPANHA, CONSTRUCAO DE REDE, CORRECAO DE REDE, EXPANSAO DE REDE, TESTE, FINANCEIRO, POS VENDA, POS-VENDA, FALTA DE COMUNICACAO, INFORMACAO DE AGENDAMENTO, MUDANCA DE ENDERECO`
- Cache: 5 min memória + PostgreSQL; cron a cada 5 min

### Analista IA
- Painéis ativos em `_IA_PAINEIS` (server.js ~linha 5515):
  1. Comercial (`/api/adicao-liquida`, `/api/comercial`)
  2. Retenção (`/api/cancelamentos-servico?meses=6`, `/api/retencao`)
  3. Suporte (`/api/chamados`)
  4. Atendimento (`/api/atendimentos`)
  5. Saúde da Base (`/api/saude-base`, `/api/risco-cancelamento`)
- **RH removido** — dado pode existir no banco mas é filtrado nos endpoints
- Roda todo dia às 07:00 via cron
- `/api/ia/paineis` e `/api/ia/analises` filtram para retornar só painéis em `_IA_PAINEIS`

---

## 7. PADRÕES TÉCNICOS OBRIGATÓRIOS

### Fuso Horário (BRT = UTC-3) — CRÍTICO

**Servidor (Node.js):**
- **"Hoje" no servidor:** `new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10)`
- **Início do mês BRT:** `${ano}-${mes}-01T03:00:00.000Z`
- **Fim do mês BRT:** `${anoProxMes}-${mesProxMes}-01T02:59:59.999Z` (1º do mês seguinte — não o último dia)
- **Nunca usar** `new Date().toISOString()` diretamente para datas de exibição ou filtros de mês
- `data_venda` do Hubsoft vem como `DD/MM/YYYY` (já em BRT) — reformatar direto sem parseDate: `rawVenda.split('/').reverse().join('-')`
- `data_cancelamento` do Hubsoft vem como timestamp UTC — usar `new Date(parsed.getTime() - 3*60*60*1000)`

**Frontend (browser):**
- **NUNCA** usar `new Date("YYYY-MM-DD").toLocaleDateString('pt-BR')` — browser interpreta como UTC → exibe dia anterior em BRT
- **Padrão correto para datas `YYYY-MM-DD`:** extrair com regex e reformatar diretamente:
  ```js
  const fmtData = d => { if (!d) return '—'; const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : new Date(d).toLocaleDateString('pt-BR'); };
  ```
- Para timestamps completos (com hora), `new Date(ts)` é seguro pois inclui offset

### Hubsoft
- SEMPRE `hubsoftPost(endpoint, body)` — retry automático + token refresh
- Paginação paralela com `pLimit(fns, concurrency=5)`
- Cache com `lruSet(cache, key, value, maxSize=50)`
- Datas chegam `DD/MM/YYYY` → converter via `parseDate()`
- Campo atendimento ID serviço: `a.id_cliente_servico`

### Auth Frontend
- Token em `localStorage.getItem('ops360_auth_token')`
- Global fetch patch auto-injeta `Authorization: Bearer <token>` em todas as chamadas `/api/`
- `_INTERNAL_TOKEN` bypass: usado em chamadas servidor→servidor

### Deploy
- Commit + push = deploy automático Railway (~2 min)
- Containers efêmeros — dados críticos SOMENTE no PostgreSQL
- Alterações cirúrgicas — nunca reescrever blocos grandes

---

## 8. WARM-UP NO BOOT

| Delay | O que faz |
|---|---|
| 20s | Retenção |
| 30s | Risco: restaura DB + reconstrói 30d + 60d |
| 45s | Saúde da Base: restaura DB + reconstrói em background |
| 65s | Financeiro: sempre reconstrói |
| 90s | Adição Líquida |
| 120s | Remoções |
| 150s | Chamados |

**Crons ativos:**
| Intervalo | O que faz |
|---|---|
| 5 min | `_warmRisco(30)` — renova risco 30d |
| 25 min | Financeiro — renova antes do TTL 30min |
| 4 min | `/ping` — keep-alive Railway |
| 1 min | `_autoRefreshPagina()` — atualiza painel ativo |
| 10s | `autoRefresh()` — chamados ao vivo |
| 07:00 BRT | Analista IA — gera análises de todos os painéis |

---

## 9. RAX — ASSISTENTE DE IA

- **Endpoint:** `POST /api/chat`
- **Model:** `claude-haiku-4-5-20251001`
- **max_tokens:** 2048
- Contexto injetado: data/hora BRT, chamados ao vivo, comercial, financeiro, retenção, risco

---

## 10. VARIÁVEIS DE ESTADO GLOBAL (FRONTEND)

| Variável | Descrição |
|---|---|
| `_authUser` | Usuário autenticado |
| `_curPage` | Página ativa |
| `_riscoData` | Cache risco |
| `_saudeData` | Cache saúde da base |
| `_finData` | Cache financeiro |
| `_comData` / `_comResultCache` | Cache comercial |
| `_retData` | Cache retenção |
| `_atendData` | Cache atendimentos |
| `_icListaCompleta` | Lista info-cancelamento carregada |
