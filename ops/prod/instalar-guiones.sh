#!/bin/sh
# ops/prod/instalar-guiones.sh — `[OPS.ING.2]` los guiones del host de `md` salen del commit que la API YA sirve.
#
#   sh ~/auto-deploy/repo/ops/prod/instalar-guiones.sh [<commit>]        (en md; por omisión, el HEAD del checkout)
#   sh ~/auto-deploy/repo/ops/prod/instalar-guiones.sh --ver [<commit>]  sólo dice qué difiere; no instala ni late
#
# ⛔ POR QUÉ. Hasta el 2026-11-12, `~/ops/prod/*.sh` eran COPIAS que subía una laptop (`deploy.sh subir_compose`) o
# alguien a mano. Medido ese día: el `soltar.sh` de md llevaba 36 días sin el arreglo `[CD.22.2]` (y se usa ahí),
# y el primer soltar de `[OPS.ING.1]` habría frenado la API si una persona no instalaba antes `auto-deploy.sh`.
# Ahora `auto-deploy.sh` llama a este guion al final de cada despliegue sano, desde su checkout.
#
# Qué hace, en este orden, y TODO O NADA:
#   1. Lee `ops/prod/guiones-del-host.txt` DEL COMMIT (`git show`, no el árbol). Un archivo que la lista nombra y el
#      commit no trae FALLA sin tocar nada: instalar la mitad es peor que no instalar.
#   2. `auto`: compara con lo instalado. `mano`: compara y AVISA (registro y latido); no instala.
#   3. Valida lo que cambió (`sh -n` a cada `.sh`). Uno que no pasa → no se instala NINGUNO.
#   4. Instala: la copia previa a `<archivo>.anterior` y la nueva por `mv`, nunca encima del inodo (`sh` lee el
#      guion POR POSICIÓN mientras corre; `auto-deploy.sh` está corriendo justo ahora).
#   5. Si cambió `auto-deploy.sh`, lo PRUEBA en seco (`--seco`, sin latido). Si falla, devuelve TODOS los de esta
#      pasada a su copia anterior: un desplegador que no arranca nunca queda puesto, y el que repondría las cosas
#      sigue siendo el viejo.
#   6. Late `instalar_guiones` (aparte del latido del despliegue).
#
# ⚠️ El candado. Dentro de `auto-deploy.sh` ya lo tiene el vigía (`/tmp/auto-deploy.lock`) y éste se entera por
# `AUTO_DEPLOY_EN_CURSO`. Corrido a mano lo toma él: la prueba en seco hace `git reset` del checkout del vigía, y
# eso no puede pasar a mitad de un despliegue.
#
# ⚠️ Lo que NO cubre, y se declara: un `auto-deploy.sh` que pasa `--seco` pero falla en un paso que sólo corre al
# desplegar de verdad (traer imágenes, aplicar, revertir). Para eso queda `<archivo>.anterior` y el runbook
# (`ops/prod/RUNBOOK-despliegue.md` §5ter).
set -u

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="${INSTALAR_GUIONES_LOCK:-/tmp/auto-deploy.lock}"
VER=0; [ "${1:-}" = "--ver" ] && { VER=1; shift; }

if [ "$VER" = 0 ] && [ -z "${AUTO_DEPLOY_EN_CURSO:-}" ] && command -v flock >/dev/null 2>&1; then
  export AUTO_DEPLOY_EN_CURSO=1
  flock -n -E 9 "$LOCK" sh "$0" "$@"; _rc=$?
  [ "$_rc" = 9 ] && echo "⛔ hay un despliegue en curso (candado $LOCK): reintentá cuando termine" >&2
  exit "$_rc"
fi

cd "$REPO_DIR" || exit 1
DEST="${INSTALAR_GUIONES_DEST:-$HOME/ops/prod}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
LISTA=ops/prod/guiones-del-host.txt

di() { echo "[$(date '+%F %T %Z')] guiones: $*"; }

# El latido nunca hace fallar la instalación (mismo criterio que `auto-deploy.sh`).
latir() {
  [ -f "$DEST/pgprod.sh" ] || { di "(sin $DEST/pgprod.sh: el latido no se escribe)"; return 0; }
  sh "$DEST/pgprod.sh" -q >/dev/null 2>&1 <<SQL || di "aviso: el latido no se pudo escribir"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'instalar_guiones', 'Guiones del host de md, desde el commit desplegado', now(), now(),
        '$(echo "$1" | sed "s/'/''/g")', '$(echo "$2" | sed "s/'/''/g")', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note, host = EXCLUDED.host, updated_at = now();
SQL
}
fallo() { di "⛔ $*"; [ "$VER" = 1 ] || latir error "$*"; exit 1; }

# ── 1. La lista y los archivos, del COMMIT ─────────────────────────────────────────────────────────────────────────
SHA=$(git rev-parse --verify -q "${1:-HEAD}^{commit}") || fallo "no existe el commit ${1:-HEAD} en $REPO_DIR"
S9=$(echo "$SHA" | cut -c1-9)
git cat-file -e "$SHA:$LISTA" 2>/dev/null || fallo "$S9 no trae $LISTA — no se toca nada"
TMP=$(mktemp -d) || fallo "sin directorio temporal"
trap 'rm -rf "$TMP"' EXIT
git show "$SHA:$LISTA" | tr -d '\r' | sed 's/#.*//' | awk 'NF' > "$TMP/.lista"
[ -s "$TMP/.lista" ] || fallo "$LISTA de $S9 está vacía — no se toca nada"
[ "$VER" = 1 ] || mkdir -p "$DEST" || fallo "no se pudo crear $DEST"

# ── 2. Qué cambió ──────────────────────────────────────────────────────────────────────────────────────────────────
CAMBIAN=''; IGUALES=0; AVISOS=''
while read -r f modo destino resto; do
  case "$f" in */*|.*) fallo "nombre inválido en la lista: '$f' (sólo nombres de ~/ops/prod)" ;; esac
  [ -z "${resto:-}" ] || fallo "renglón con campos de más en la lista: $f"
  git cat-file -e "$SHA:ops/prod/$f" 2>/dev/null || fallo "la lista nombra $f y $S9 no lo trae — no se toca nada"
  git show "$SHA:ops/prod/$f" > "$TMP/$f" || fallo "no se pudo leer $f de $S9"
  case "$modo" in
    auto)
      [ -z "${destino:-}" ] || fallo "$f es auto y declara destino: un auto vive siempre en $DEST"
      if [ -f "$DEST/$f" ] && cmp -s "$TMP/$f" "$DEST/$f"; then IGUALES=$((IGUALES + 1)); else CAMBIAN="$CAMBIAN $f"; fi ;;
    mano)
      _d="${destino:-$DEST/$f}"
      if [ ! -f "$_d" ]; then AVISOS="$AVISOS $f(no está en $_d)"
      elif ! cmp -s "$TMP/$f" "$_d"; then AVISOS="$AVISOS $f"; fi ;;
    *) fallo "modo '$modo' desconocido para $f (auto | mano)" ;;
  esac
done < "$TMP/.lista"

[ -z "$AVISOS" ] || di "⚠ a mano y DISTINTO de $S9:$AVISOS — los instala una persona (RUNBOOK-despliegue §5ter)"
if [ "$VER" = 1 ]; then
  di "${CAMBIAN:+se instalarían desde $S9:$CAMBIAN · }$IGUALES iguales (--ver: no se instala nada)"
  exit 0
fi
if [ -z "$CAMBIAN" ]; then
  di "al día con $S9 ($IGUALES iguales)"
  latir ok "al día con $S9: $IGUALES iguales${AVISOS:+ · ⚠ a mano y distinto:$AVISOS}"
  exit 0
fi

# ── 3. Validar ANTES de tocar nada ─────────────────────────────────────────────────────────────────────────────────
for f in $CAMBIAN; do
  case "$f" in
    *.sh) sh -n "$TMP/$f" 2>"$TMP/.err" \
            || fallo "$f de $S9 no pasa sh -n ($(head -1 "$TMP/.err")) — no se instala ninguno" ;;
  esac
done

# ── 4. Instalar, con la copia previa al lado ───────────────────────────────────────────────────────────────────────
TENIA=''; PUESTOS=''
poner() { # poner <origen> <archivo>
  cp "$1" "$DEST/.$2.nuevo" || return 1
  case "$2" in *.sh) chmod 755 "$DEST/.$2.nuevo" ;; *) chmod 644 "$DEST/.$2.nuevo" ;; esac
  mv -f "$DEST/.$2.nuevo" "$DEST/$2"
}
volver() {
  for _f in $PUESTOS; do
    case " $TENIA " in
      *" $_f "*) poner "$DEST/$_f.anterior" "$_f" || di "⛔⛔ no se pudo devolver $_f: está en $DEST/$_f.anterior" ;;
      *) rm -f "$DEST/$_f" ;;
    esac
  done
}
for f in $CAMBIAN; do
  if [ -f "$DEST/$f" ]; then
    cp -p "$DEST/$f" "$DEST/$f.anterior" || { volver; fallo "no se pudo guardar la copia previa de $f — se devolvió lo de esta pasada"; }
    TENIA="$TENIA $f"
  fi
  poner "$TMP/$f" "$f" || { volver; fallo "no se pudo poner $f — se devolvió lo de esta pasada"; }
  PUESTOS="$PUESTOS $f"
done

# ── 5. El desplegador nuevo, probado en seco antes de darlo por puesto ─────────────────────────────────────────────
case "$PUESTOS " in
  *" auto-deploy.sh "*)
    RAMA="${AUTO_DEPLOY_BRANCH:-}"
    [ -n "$RAMA" ] || RAMA=$(sed -n 's/^[[:space:]]*AUTO_DEPLOY_BRANCH=//p' "$DEST/vigia.env" 2>/dev/null | tail -1 | tr -d "\"' ")
    if AUTO_DEPLOY_PRUEBA=1 AUTO_DEPLOY_BRANCH="${RAMA:-main}" AUTO_DEPLOY_REPO="$REPO_DIR" AUTO_DEPLOY_LOG=/dev/null \
         sh "$DEST/auto-deploy.sh" --seco > "$TMP/.seco" 2>&1; then
      di "auto-deploy.sh de $S9 pasó su prueba en seco: $(tail -1 "$TMP/.seco")"
    else
      tail -15 "$TMP/.seco" | sed 's/^/      /'
      volver
      fallo "el auto-deploy.sh de $S9 NO pasó su prueba en seco — volvieron a su copia anterior:$PUESTOS"
    fi ;;
esac

di "instalados desde $S9:$PUESTOS · $IGUALES iguales (la previa de cada uno, en <archivo>.anterior)"
latir ok "instalados desde $S9:$PUESTOS · $IGUALES iguales${AVISOS:+ · ⚠ a mano y distinto:$AVISOS}"
