"""
push_to_ops360.py
-----------------
Lê resultado_auditoria.json e envia para o dashboard ops360 no Railway.

Como usar (rodar na pasta C:\\chatmix_auditoria):
    py -3.12 push_to_ops360.py

Configurar as variaveis no topo ou em .env:
    OPS360_URL    = URL do Railway (ex: https://lcfibra360.up.railway.app)
    AGENT_SECRET  = segredo do agente (padrão: chatmix-agent-2026)
    ARQUIVO_JSON  = caminho do arquivo de resultados
"""

import json
import os
import sys
from pathlib import Path

# ── Configurações ──────────────────────────────────────────────────────────────
OPS360_URL   = os.getenv('OPS360_URL',   'https://lcfibra360.up.railway.app')
AGENT_SECRET = os.getenv('AGENT_SECRET', 'chatmix-agent-2026')
ARQUIVO_JSON = os.getenv('ARQUIVO_JSON', 'resultado_auditoria.json')
# ──────────────────────────────────────────────────────────────────────────────

try:
    import requests
except ImportError:
    print('[ERRO] Instale requests:  py -3.12 -m pip install requests')
    sys.exit(1)

arquivo = Path(ARQUIVO_JSON)
if not arquivo.exists():
    print(f'[ERRO] Arquivo não encontrado: {arquivo.resolve()}')
    sys.exit(1)

with open(arquivo, encoding='utf-8') as f:
    dados = json.load(f)

if not isinstance(dados, list):
    print('[ERRO] O arquivo JSON deve ser uma lista de atendimentos.')
    sys.exit(1)

print(f'[OK] {len(dados)} registros carregados de {arquivo.name}')
print(f'[>>] Enviando para {OPS360_URL}/api/chatmix/auditoria ...')

try:
    r = requests.post(
        f'{OPS360_URL}/api/chatmix/auditoria',
        json=dados,
        headers={
            'x-agent-secret': AGENT_SECRET,
            'Content-Type': 'application/json',
        },
        timeout=30,
    )
    r.raise_for_status()
    resp = r.json()
    print(f'[OK] Enviado com sucesso! Total no servidor: {resp.get("total")} registros.')
    print(f'     Atualizado em: {resp.get("atualizado_em")}')
except requests.exceptions.ConnectionError:
    print(f'[ERRO] Não conseguiu conectar em {OPS360_URL}. Verifique a URL.')
    sys.exit(1)
except requests.exceptions.HTTPError as e:
    print(f'[ERRO] HTTP {r.status_code}: {r.text[:200]}')
    sys.exit(1)
except Exception as e:
    print(f'[ERRO] {e}')
    sys.exit(1)
