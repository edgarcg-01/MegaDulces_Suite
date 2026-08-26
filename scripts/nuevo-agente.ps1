# nuevo-agente.ps1 - crea un worktree aislado para una sesion de Claude.
# Uso:   .\scripts\nuevo-agente.ps1 almacen
# Efecto: crea ../tm-almacen con la rama feat/almacen (desde origin/main fresco)
#         y enlaza node_modules + .env del repo principal (sin reinstalar 5 veces).
param(
  [Parameter(Mandatory=$true)][string]$Nombre
)
$ErrorActionPreference = "Stop"

# Raiz del repo principal (donde vive este script).
$main = Split-Path -Parent $PSScriptRoot
$slug = ($Nombre -replace '[^a-zA-Z0-9\-_]', '-').ToLower()
$rama = "feat/$slug"
$dir  = Join-Path (Split-Path -Parent $main) "tm-$slug"

if (Test-Path $dir) { throw "Ya existe $dir. Usa otro nombre o cerralo con cerrar-agente.ps1" }

Write-Host "==> Actualizando origin/main..." -ForegroundColor Cyan
git -C $main fetch --quiet origin main

Write-Host "==> Creando worktree $dir en la rama $rama (desde origin/main)..." -ForegroundColor Cyan
git -C $main worktree add $dir -b $rama origin/main

# node_modules: junction al del repo principal (evita 5x disco + npm install).
$nmMain = Join-Path $main "node_modules"
$nmNew  = Join-Path $dir  "node_modules"
if ((Test-Path $nmMain) -and -not (Test-Path $nmNew)) {
  Write-Host "==> Enlazando node_modules (junction)..." -ForegroundColor Cyan
  New-Item -ItemType Junction -Path $nmNew -Target $nmMain | Out-Null
}

# .env: copia (cada worktree arranca del mismo, puede tener el suyo despues).
$envMain = Join-Path $main ".env"
$envNew  = Join-Path $dir  ".env"
if ((Test-Path $envMain) -and -not (Test-Path $envNew)) {
  Copy-Item $envMain $envNew
  Write-Host "==> .env copiado." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "LISTO. Abri Claude Code en:  $dir" -ForegroundColor Green
Write-Host "Rama: $rama . Al terminar: PR contra main, luego  .\scripts\cerrar-agente.ps1 $slug" -ForegroundColor Green
