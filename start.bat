@echo off
cd /d "%~dp0"
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if %errorlevel% equ 0 (
  python app.py %*
  goto finished
)
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if %errorlevel% equ 0 (
  py -3 app.py %*
  goto finished
)
echo Python 3.10 or newer is required. Install Python and try again.
:finished
pause
