# cerrar-agente.ps1 - quita el worktree de un agente cuando su PR ya mergeo.
# Uso:   .\scripts\cerrar-agente.ps1 almacen
# Seguro: se niega a cerrar si hay cambios sin commitear en ese worktree.
param(
  [Parameter(Mandatory=$true)][string]$Nombre,
  [switch]$BorrarRama   # ademas borra la rama local feat/<slug> (solo si ya mergeo)
)
$ErrorActionPreference = "Stop"

$main = Split-Path -Parent $PSScriptRoot
$slug = ($Nombre -replace '[^a-zA-Z0-9\-_]', '-').ToLower()
$rama = "feat/$slug"
$dir  = Join-Path (Split-Path -Parent $main) "tm-$slug"

if (-not (Test-Path $dir)) { throw "No existe $dir" }

# Chequeo de seguridad: hay trabajo sin commitear?
$dirty = git -C $dir status --porcelain
if ($dirty) {
  Write-Host "STOP: $dir tiene cambios SIN commitear:" -ForegroundColor Red
  Write-Host $dirty
  throw "Commitea o descarta esos cambios antes de cerrar el worktree."
}

# En Windows no usamos 'git worktree remove' (falla por junction/paths-largos/handles).
# Borrado crudo: primero el junction de node_modules, luego la carpeta, luego prune del registro.
$nm = Join-Path $dir "node_modules"
if (Test-Path $nm) {
  Write-Host "==> Quitando junction node_modules..." -ForegroundColor Cyan
  cmd /c rmdir "$nm" | Out-Null
}

Write-Host "==> Removiendo carpeta del worktree..." -ForegroundColor Cyan
cmd /c rmdir /s /q "$dir" | Out-Null
git -C $main worktree prune
if (Test-Path $dir) { throw "No se pudo borrar $dir (algun proceso lo tiene abierto). Cerra editores/terminales ahi y reintenta." }

if ($BorrarRama) {
  Write-Host "==> Borrando rama local $rama..." -ForegroundColor Cyan
  git -C $main branch -D $rama
}

Write-Host "LISTO. Worktree cerrado." -ForegroundColor Green
