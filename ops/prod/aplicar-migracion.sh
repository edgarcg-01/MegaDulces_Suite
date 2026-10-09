#!/bin/sh
# Aplica UNA migración a producción, por el único camino que no deja el ledger roto.
#
# ─── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────
#
# ⛔ **El 2026-10-08 se aplicaron OCHO migraciones a producción desde commits que nunca se
# empujaron.** Cada una deja la tabla `knex_migrations` de prod nombrando un archivo que la imagen
# del contenedor no tiene, y entonces `knex.migrate.list()` aborta con *«the migration directory is
# corrupt»* — o sea que **frena la siguiente migración de CUALQUIERA**, no sólo la de quien la
# aplicó. Ese día costó tres destrabes a mano; una de las ocho tuvo que rastrearse hasta el
# worktree de otra sesión en `/c/tmp`, porque el archivo no existía en ningún otro lado.
#
# ⭐ **La causa es que el aplicador corre DENTRO del pod, donde no hay git.** No puede saber si lo
# que le dan vive en `origin/main` o sólo en la carpeta de alguien. Esa comprobación sólo se puede
# hacer acá afuera — por eso este envoltorio, y no un parche al aplicador.
#
# ─── QUÉ HACE, EN ORDEN ──────────────────────────────────────────────────────────────────────
#
#  1. **Se niega** si el archivo no está en `origin/main`. Es la compuerta: empujá primero.
#  2. Copia al pod la migración **y las que el ledger ya nombra y a la imagen le faltan** — el
#     baile que había que hacer a mano. Si alguna de ésas tampoco está en `origin/main`, lo dice
#     con nombre y sigue (es deuda vieja, no se puede exigir hoy), pero deja el aviso.
#  3. Corre el aplicador de siempre, que mantiene su propio candado de identidad del clúster.
#
# ⚠️ Lo que NO hace: aplicar varias de un saque, ni `migrate:latest`. En prod hay DOS tablas
# `knex_migrations` y una corrida en lote aplicaría también lo pendiente de otras sesiones.
#
# Uso:   sh ops/prod/aplicar-migracion.sh <archivo.js>
#        sh ops/prod/aplicar-migracion.sh --pendientes     (sólo lista, no aplica)
set -u

MD="${MIG_MD:-superoot@192.168.0.222}"
KC='export KUBECONFIG=/etc/rancher/k3s/k3s.yaml'
DIR=database/migrations-newdb
APLICADOR=/app/database/scripts/apply-one-migration-prod.js

rojo()  { printf '⛔ %s\n' "$*" >&2; }
aviso() { printf '⚠️  %s\n' "$*" >&2; }

en_main() { git cat-file -e "origin/main:$DIR/$1" 2>/dev/null; }

# Dónde vive un archivo que NO está en `origin/main` — para que el aviso sea accionable y no
# mande a nadie a buscarlo a ciegas, que fue justo lo que costó tiempo el 8-oct.
donde_vive() {
  _f=$1
  [ -f "$DIR/$_f" ] && { echo "en este árbol (sin commitear o sin empujar)"; return; }
  _c=$(git log --all --oneline -1 -- "$DIR/$_f" 2>/dev/null | cut -c1-50)
  [ -n "$_c" ] && { echo "en el commit $_c (sin empujar)"; return; }
  for _w in $(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}'); do
    [ -f "$_w/$DIR/$_f" ] && { echo "en el worktree $_w"; return; }
  done
  echo "NO SE ENCONTRÓ en ningún lado alcanzable"
}

copiar_al_pod() { # copiar_al_pod <archivo> <ruta-origen>
  base64 -w0 "$2" | ssh -o BatchMode=yes "$MD" \
    "$KC; kubectl -n prod exec -i deploy/api -c api -- sh -c 'base64 -d > /app/$DIR/$1'" >/dev/null 2>&1 || return 1
  _p=$(ssh -o BatchMode=yes "$MD" "$KC; kubectl -n prod exec deploy/api -c api -- sh -c 'wc -c < /app/$DIR/$1'" 2>/dev/null | tr -d ' \r')
  # ⚠️ Se comparan los BYTES, no se confía en que `exec` haya salido 0: una copia truncada
  # produce un archivo que existe, pasa cualquier `test -f`, y revienta recién al ejecutarse.
  [ "$_p" = "$(wc -c < "$2" | tr -d ' ')" ]
}

git fetch origin --quiet 2>/dev/null || aviso "no se pudo hacer fetch — se juzga contra el origin/main que haya en disco"

# ── Lo que el ledger de prod nombra y en `main` no está ──────────────────────────────────────
huerfanos() {
  ssh -o BatchMode=yes "$MD" "$KC; kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -At -c 'select name from public.knex_migrations;'" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort > /tmp/_mig_prod.$$
  git ls-tree -r --name-only origin/main "$DIR/" 2>/dev/null | sed 's|.*/||' | LC_ALL=C sort > /tmp/_mig_main.$$
  LC_ALL=C comm -13 /tmp/_mig_main.$$ /tmp/_mig_prod.$$
  rm -f /tmp/_mig_prod.$$ /tmp/_mig_main.$$
}

if [ "${1:-}" = "--pendientes" ]; then
  ssh -o BatchMode=yes "$MD" "$KC; kubectl -n prod exec -i deploy/pg-prod -- psql -U postgres -d railway -At -c 'select name from public.knex_migrations;'" 2>/dev/null \
    | tr -d '\r' | LC_ALL=C sort > /tmp/_p.$$
  git ls-tree -r --name-only origin/main "$DIR/" | sed 's|.*/||' | LC_ALL=C sort > /tmp/_m.$$
  echo "── pendientes (en main, no en prod) ──"; LC_ALL=C comm -23 /tmp/_m.$$ /tmp/_p.$$ | sed 's/^/  /'
  echo "── huérfanas (en prod, no en main) ──"
  LC_ALL=C comm -13 /tmp/_m.$$ /tmp/_p.$$ | while read -r h; do printf '  %s  ← %s\n' "$h" "$(donde_vive "$h")"; done
  rm -f /tmp/_p.$$ /tmp/_m.$$; exit 0
fi

ARCHIVO="${1:-}"
[ -n "$ARCHIVO" ] || { rojo "falta el archivo.  Uso: sh $0 <archivo.js>  |  --pendientes"; exit 2; }
ARCHIVO=$(basename "$ARCHIVO")

# ── ⛔ LA COMPUERTA ──────────────────────────────────────────────────────────────────────────
if ! en_main "$ARCHIVO"; then
  rojo "'$ARCHIVO' NO está en origin/main — $(donde_vive "$ARCHIVO")"
  echo "" >&2
  echo "   Aplicarla igual deja el ledger de prod nombrando un archivo que la imagen no tiene," >&2
  echo "   y eso FRENA la siguiente migración de cualquiera con «migration directory is corrupt»." >&2
  echo "   Pasó OCHO veces el 2026-10-08 y costó tres destrabes a mano." >&2
  echo "" >&2
  echo "   Empujá primero:   git push origin main" >&2
  exit 1
fi
echo "✓ '$ARCHIVO' está en origin/main"

# ── Destrabar el ledger: copiar lo que ya nombra y a la imagen le falta ──────────────────────
FALTAN=$(huerfanos)
if [ -n "$FALTAN" ]; then
  echo "── el ledger nombra $(printf '%s\n' "$FALTAN" | wc -l | tr -d ' ') archivo(s) que no están en main; se copian para destrabar ──"
  printf '%s\n' "$FALTAN" | while read -r h; do
    [ -n "$h" ] || continue
    _src=''
    [ -f "$DIR/$h" ] && _src="$DIR/$h"
    if [ -z "$_src" ]; then
      for _w in $(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}'); do
        [ -f "$_w/$DIR/$h" ] && { _src="$_w/$DIR/$h"; break; }
      done
    fi
    if [ -z "$_src" ]; then
      aviso "$h — $(donde_vive "$h"); si el aplicador aborta por 'directory is corrupt', es por ésta"
    elif copiar_al_pod "$h" "$_src"; then
      printf '   copiada (deuda vieja): %s\n' "$h"
    else
      aviso "$h — no se pudo copiar"
    fi
  done
fi

# ── Copiar la que se quiere aplicar, y aplicarla ─────────────────────────────────────────────
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
git show "origin/main:$DIR/$ARCHIVO" > "$TMP" || { rojo "no se pudo leer $ARCHIVO de origin/main"; exit 1; }
copiar_al_pod "$ARCHIVO" "$TMP" || { rojo "la copia al pod no coincide en bytes — no se aplica"; exit 1; }
echo "✓ copiada al pod ($(wc -c < "$TMP" | tr -d ' ') bytes, verificados)"
echo
ssh -o BatchMode=yes "$MD" "$KC; kubectl -n prod exec deploy/api -c api -- node $APLICADOR $ARCHIVO" 2>&1 \
  | grep -v 'Defaulted container' | grep -vE 'dotenvx|injected env'
