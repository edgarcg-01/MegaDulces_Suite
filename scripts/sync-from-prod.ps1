# ---------------------------------------------------------------------------
# sync-from-prod.ps1 - Orquesta el ciclo diario completo:
#   1) Respalda la BD de produccion a disco local (backup-db.ps1).
#   2) Restaura ese mismo dump en la BD local (restore-local.ps1).
#
# Es lo que el Task Scheduler invoca a las 17:00. Si el paso 1 falla, no
# intenta restaurar (mejor conservar la BD local vieja que tener una BD
# vacia/corrupta).
# ---------------------------------------------------------------------------

param()

$ErrorActionPreference = 'Stop'

function Write-Log([string]$msg) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] [sync] $msg"
}

$backupScript  = Join-Path $PSScriptRoot 'backup-db.ps1'
$restoreScript = Join-Path $PSScriptRoot 'restore-local.ps1'

Write-Log "Paso 1/2: backup de produccion."
& $backupScript
if ($LASTEXITCODE -ne 0) {
    Write-Log "Backup fallo (exit $LASTEXITCODE). Aborto sin restaurar."
    exit $LASTEXITCODE
}

Write-Log "Paso 2/2: restore al local."
& $restoreScript
if ($LASTEXITCODE -ne 0) {
    Write-Log "Restore local fallo (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

Write-Log "Sync completo."
