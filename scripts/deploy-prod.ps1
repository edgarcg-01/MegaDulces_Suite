# deploy-prod.ps1 - promueve main -> production = UN solo deploy en Railway.
# Uso:   .\scripts\deploy-prod.ps1
# Efecto: fast-forward de production hasta origin/main y push. Railway auto-deploya
#         SOLO la rama production, asi que N merges a main = 1 deploy (no 4).
param(
  [switch]$Force   # permite un push no-fast-forward (raro; solo si production divergio)
)
$ErrorActionPreference = "Stop"
$main = Split-Path -Parent $PSScriptRoot

Write-Host "==> Trayendo origin/main y origin/production..." -ForegroundColor Cyan
git -C $main fetch --quiet origin main production

$mainSha = (git -C $main rev-parse --short origin/main).Trim()
$prodSha = (git -C $main rev-parse --short origin/production).Trim()

if ($mainSha -eq $prodSha) {
  Write-Host "production ya esta en $mainSha. Nada que desplegar." -ForegroundColor Yellow
  exit 0
}

Write-Host ""
Write-Host "Se va a DESPLEGAR a produccion:" -ForegroundColor Green
Write-Host "  production $prodSha  ->  $mainSha (origin/main)" -ForegroundColor Green
Write-Host "  Commits que entran:" -ForegroundColor Green
git -C $main log --oneline "origin/production..origin/main" | ForEach-Object { Write-Host "    $_" }
Write-Host ""

# Fast-forward: production solo debe AVANZAR hasta main (mismo historial).
if ($Force) {
  git -C $main push origin "origin/main:refs/heads/production" --force
} else {
  git -C $main push origin "origin/main:refs/heads/production"
}

Write-Host ""
Write-Host "LISTO. production -> $mainSha pusheada. Railway arranca UN deploy." -ForegroundColor Green
Write-Host "Segui el build:  railway service MegaDulces; railway logs" -ForegroundColor Green
