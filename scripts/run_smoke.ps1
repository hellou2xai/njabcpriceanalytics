# Smoke-suite orchestrator: build the frontend, boot the backend, run
# frontend/smoke.mjs against it, clean up. Exit code 0 = safe to push.
#   powershell -File scripts\run_smoke.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[smoke] building frontend..."
Set-Location frontend
npx vite build | Out-Null
Set-Location $root

Write-Host "[smoke] minting test token..."
python -c "import sys; sys.path.insert(0,'.')
from datetime import datetime, timedelta, timezone
from backend.pg import get_pg
now = datetime.now(timezone.utc)
with get_pg() as pg:
    pg.execute('DELETE FROM auth_tokens WHERE token=%s', ('smoke-suite-token',))
    pg.execute('INSERT INTO auth_tokens (token, user_id, expires_at, last_activity) VALUES (%s,%s,%s,%s)',
               ('smoke-suite-token', 10, (now+timedelta(minutes=30)).isoformat(), now.isoformat()))"

Write-Host "[smoke] starting backend..."
$env:PYTHONPATH = "."
$server = Start-Process python -ArgumentList "-m","uvicorn","backend.main:app","--port","8000" `
            -PassThru -WindowStyle Hidden
try {
  $ready = $false
  foreach ($i in 1..60) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:8000/api/ready" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw "backend never became ready" }

  Write-Host "[smoke] running suite..."
  Set-Location frontend
  node smoke.mjs
  $code = $LASTEXITCODE
  Set-Location $root
}
finally {
  Write-Host "[smoke] cleaning up..."
  try { Stop-Process -Id $server.Id -Force -Confirm:$false } catch {}
  python -c "import sys; sys.path.insert(0,'.')
from backend.pg import get_pg
with get_pg() as pg: pg.execute('DELETE FROM auth_tokens WHERE token=%s', ('smoke-suite-token',))"
}
exit $code
