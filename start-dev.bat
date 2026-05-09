@echo off
echo Zoo Battle - 개발 서버 시작
echo ================================
echo 소켓 서버: http://localhost:3001
echo 게임 서버: http://localhost:5173
echo ================================
start "Zoo Battle Socket Server" cmd /k "node server/server.js"
timeout /t 1 /nobreak >nul
start "Zoo Battle Dev Server" cmd /k "npm run dev"
echo.
echo 두 서버가 새 창에서 실행 중입니다.
echo 브라우저에서 http://localhost:5173 접속하세요.
pause
