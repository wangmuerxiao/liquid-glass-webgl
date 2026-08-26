@echo off
cd /d "%~dp0"
echo Starting local server on http://localhost:8080
echo Keep this window open, then open the URL in your browser
echo Serving from: %CD%
echo.
python server.py 2>nul
if %errorlevel% neq 0 (
  py server.py 2>nul
  if %errorlevel% neq 0 (
    python -m http.server 8080 2>nul
    if %errorlevel% neq 0 (
      py -m http.server 8080 2>nul
      if %errorlevel% neq 0 (
        python3 -m http.server 8080 2>nul
        if %errorlevel% neq 0 (
          echo Python not found, trying Node...
          call npx --yes serve . -l 8080 2>nul
          if %errorlevel% neq 0 (
            echo Please install Python or Node.js
            echo Or use VS Code Live Server to open index.html
            pause
          )
        )
      )
    )
  )
)
