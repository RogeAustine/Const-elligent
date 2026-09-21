$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
    if ($LASTEXITCODE -eq 0) {
        & python app.py @args
        return
    }
}
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
    if ($LASTEXITCODE -eq 0) {
        & py -3 app.py @args
        return
    }
}
throw 'Python 3.10 or newer is required. Install Python and try again.'
