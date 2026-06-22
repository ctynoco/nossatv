@echo off
echo ==========================================
echo  NossaTV - MediaMTX Server
echo  WHIP endpoint: http://localhost:8889/nossatv/whip
echo  RTMP local:    rtmp://localhost:1935/nossatv
echo  HLS viewer:    http://localhost:8888/nossatv
echo ==========================================
echo.
echo  Configure os destinos RTMP no NossaTV
echo  (Settings > Stream) e gere o config
echo  com o botao "Gerar Config MediaMTX".
echo.
echo  Pressione CTRL+C para parar o servidor.
echo.
%~dp0mediamtx.exe %~dp0mediamtx.yml
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Erro ao iniciar MediaMTX.
  pause
)
