@echo off
title LC Fibra 360 — Preview Local
color 0A

echo.
echo  ============================================
echo   LC FIBRA 360 — AMBIENTE DE PREVIEW LOCAL
echo  ============================================
echo.
echo  Iniciando servidor...
echo  Aguarde abrir no navegador em http://localhost:3000
echo.
echo  Para PARAR o servidor: feche esta janela
echo  ============================================
echo.

cd /d "%~dp0"

:: Instala dependencias se necessario
if not exist node_modules (
    echo  Instalando dependencias pela primeira vez...
    npm install
    echo.
)

:: Abre o navegador apos 3 segundos
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

:: Inicia o servidor com variaveis do .env
node -r dotenv/config server.js

pause
