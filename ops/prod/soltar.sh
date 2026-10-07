#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════════════════
# `soltar.sh` — SUELTA a producción lo que el CI ya aprobó.
#
#   ssh superoot@192.168.0.222 'ops/prod/soltar.sh'          ← suelta
#   ssh superoot@192.168.0.222 'ops/prod/soltar.sh --ver'    ← sólo mira, no suelta
#   ssh superoot@192.168.0.222 'ops/prod/soltar.sh --volver <sha>'  ← regresa prod a un commit
#
# ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────
#
# Hasta el 2026-10-07 el vigía miraba `ci-green`, así que **cada merge salía solo**: medido, 14
# despliegues en un día. Con `VIGIA_REF=refs/heads/prod-release` el vigía mira otra ref y el
# momento de soltar lo decide una persona — con este guion, que es un empujón y nada más.
#
# ⭐ `ci-green` NO cambia de significado. Sigue siendo el SELLO del CI, y `compuerta-ci.sh` se
# niega igual a desplegar un commit que no esté en su historia (acepta ANCESTROS, por eso
# `prod-release` puede ir detrás sin frenar nada). Son dos preguntas y por eso son dos refs:
#
#     ci-green      ¿el CI lo aprobó?        ← lo mueve el job `sellar`, automático
#     prod-release  ¿lo queremos afuera?     ← lo mueve este guion, a mano
#
# ── LO QUE AVISA ANTES DE SOLTAR, Y POR QUÉ ─────────────────────────────────────────────────
#
# ⚠️ Las migraciones **no** las aplica el despliegue: van una por una con
# `apply-one-migration-prod.js`. Si el código que sale necesita esquema que prod no tiene, la
# compuerta de `auto-deploy.sh` FRENA y el vigía reintenta cada 120 s hasta que alguien las
# aplique. Eso protege, pero avisa tarde: medido el 2026-10-07, prod estuvo parado 25 minutos
# por tres migraciones que nadie sabía que faltaban.
#
# Peor con lotes: juntar varios merges junta también sus migraciones. Por eso este guion las
# lista ANTES, aunque igual suelte: la compuerta es la red, esto es el aviso.
#
# ⛔ `/home/superoot/ops` NO es un repo git — estos guiones se copian a mano. Cambiar la copia
# del repo NO cambia lo que corre. Hay que copiar los dos: el `.sh` y el `.service`.
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -u

REMOTO="git@github.com:edgarcg-01/MegaDulces_Suite.git"
REPO_DIR="${AUTO_DEPLOY_REPO:-$HOME/auto-deploy/repo}"
SELLO="${SOLTAR_SELLO:-ci-green}"
DESTINO="${SOLTAR_DESTINO:-prod-release}"
LLAVE="$HOME/.ssh/deploy_md"
export GIT_SSH_COMMAND="ssh -i $LLAVE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

MODO=soltar
VOLVER_A=''
case "${1:-}" in
  --ver)    MODO=ver ;;
  --volver) MODO=volver; VOLVER_A="${2:?falta el sha al que volver}" ;;
  '')       : ;;
  *)        echo "uso: soltar.sh [--ver | --volver <sha>]"; exit 64 ;;
esac

[ -d "$REPO_DIR/.git" ] || { echo "⛔ no existe el clon $REPO_DIR — ¿corrió auto-deploy alguna vez?"; exit 1; }
cd "$REPO_DIR" || exit 1

# ⚠️ El clon es `--depth 50`. Un `git log A..B` sobre historia truncada puede mentir por abajo,
# así que se profundiza antes de comparar. Sin esto, un lote grande saldría con la lista corta.
git fetch --quiet --deepen 200 origin "+refs/heads/$SELLO:refs/remotes/origin/$SELLO" \
                                      "+refs/heads/$DESTINO:refs/remotes/origin/$DESTINO" 2>/dev/null \
  || git fetch --quiet origin "+refs/heads/$SELLO:refs/remotes/origin/$SELLO" 2>/dev/null \
  || { echo "⛔ NO MEDIDO: no pude traer $SELLO (red o llave). No es 'no hay nada que soltar'."; exit 30; }

NUEVO=$(git rev-parse --verify --quiet "refs/remotes/origin/$SELLO^{commit}") \
  || { echo "⛔ NO MEDIDO: $SELLO no existe — el CI nunca selló."; exit 30; }
ACTUAL=$(git rev-parse --verify --quiet "refs/remotes/origin/$DESTINO^{commit}" || true)

if [ "$MODO" = volver ]; then
  NUEVO=$(git rev-parse --verify --quiet "$VOLVER_A^{commit}") \
    || { echo "⛔ no resuelve $VOLVER_A"; exit 64; }
  # Volver a un commit que el CI nunca selló dejaría a la compuerta frenando para siempre.
  git merge-base --is-ancestor "$NUEVO" "$(git rev-parse refs/remotes/origin/$SELLO)" 2>/dev/null \
    || { echo "⛔ $(git rev-parse --short "$NUEVO") no está en la historia de $SELLO: la compuerta lo va a frenar."; exit 20; }
fi

if [ -n "$ACTUAL" ] && [ "$ACTUAL" = "$NUEVO" ]; then
  echo "nada que soltar — $DESTINO ya está en $(git rev-parse --short "$NUEVO")"
  exit 0
fi

echo "═══ lo que va a salir ═══════════════════════════════════════════════"
if [ -n "$ACTUAL" ]; then
  echo "   de $(git rev-parse --short "$ACTUAL")  a  $(git rev-parse --short "$NUEVO")"
  git log --oneline --no-decorate "$ACTUAL..$NUEVO" 2>/dev/null | sed 's/^/   · /' | head -40
  N=$(git rev-list --count "$ACTUAL..$NUEVO" 2>/dev/null || echo '?')
  echo "   ($N commit/s)"
else
  echo "   primera vez: $DESTINO nace en $(git rev-parse --short "$NUEVO")"
fi

# ── Migraciones que el despliegue va a encontrar pendientes ────────────────────────────────
# Se compara el DIRECTORIO del commit que sale contra el ledger de prod. Si no se puede leer
# alguno de los dos, se DECLARA: «no medido» no es «no hay».
echo "═══ migraciones ═════════════════════════════════════════════════════"
APLICADAS=$(sh "$HOME/ops/prod/pgprod.sh" -At -c 'SELECT name FROM public.knex_migrations' 2>/dev/null)
if [ -z "$APLICADAS" ]; then
  echo "   ⚠️ NO MEDIDO: no pude leer knex_migrations de prod. Puede haber pendientes."
else
  TMP_APL=$(mktemp) || { echo "   ⚠️ NO MEDIDO: sin temporal"; TMP_APL=''; }
  printf '%s\n' "$APLICADAS" | sort > "$TMP_APL"
  PEND=$(git ls-tree -r --name-only "$NUEVO" database/migrations-newdb/ 2>/dev/null \
           | sed 's|.*/||' | sort | comm -23 - "$TMP_APL")
  rm -f "$TMP_APL"
  if [ -z "$PEND" ]; then
    echo "   prod al día — ninguna pendiente"
  else
    echo "   ⚠️ $(printf '%s\n' "$PEND" | grep -c .) pendiente(s). Si el código las necesita, el"
    echo "      despliegue FRENA hasta que se apliquen una por una:"
    printf '%s\n' "$PEND" | sed 's/^/        · /'
    echo "      node /app/database/scripts/apply-one-migration-prod.js <archivo>  (dentro de prod-api)"
  fi
fi
echo "═════════════════════════════════════════════════════════════════════"

[ "$MODO" = ver ] && { echo "(--ver: no se soltó nada)"; exit 0; }

# `--force` sólo hace falta para `--volver`; el camino normal es avance rápido y así se queda,
# para que un retroceso accidental no pase inadvertido.
if [ "$MODO" = volver ]; then
  git push --force "$REMOTO" "$NUEVO:refs/heads/$DESTINO" >/dev/null 2>&1 || { echo "⛔ falló el push"; exit 1; }
  echo "VOLVIÓ: $DESTINO → $(git rev-parse --short "$NUEVO")"
else
  git push "$REMOTO" "$NUEVO:refs/heads/$DESTINO" >/dev/null 2>&1 || {
    echo "⛔ falló el push — ¿$DESTINO adelantó por otro lado? Mirá con --ver, y si querés pisarlo usá --volver."
    exit 1; }
  echo "SOLTADO: $DESTINO → $(git rev-parse --short "$NUEVO")"
fi
echo "el vigía lo levanta en ≤30 s · seguimiento: tail -f ~/ops/prod/auto-deploy.log"
