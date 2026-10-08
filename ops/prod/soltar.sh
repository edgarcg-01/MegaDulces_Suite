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

# ⛔ ESTE GUION CORRE EN TU MÁQUINA, NO EN `md`. La llave de despliegue de `md`
# (`~/.ssh/deploy_md`) es de **sólo lectura** —medido el 2026-10-07: «The key you are
# authenticating with has been marked as read only»— y eso NO se cambia: una llave con escritura
# en el servidor de producción convierte un compromiso de `md` en poder reescribir el repo.
# El vigía sólo lee y `auto-deploy` sólo hace fetch, justamente por eso.
#
# Así que el reparto es: **mide en `md`, empuja desde acá.** La única parte que necesita `md` es
# leer `knex_migrations` de prod, y para eso alcanza con SSH.
MD="${SOLTAR_MD:-superoot@192.168.0.222}"
# ⚠️ El remoto NO se escribe a mano. En `md` el clon habla por SSH con la llave de despliegue;
# en tu máquina `origin` suele ser HTTPS con tus credenciales — clavar la URL SSH acá hacía que
# el push fallara justo donde SÍ hay permiso de escritura (medido el 2026-10-07). Se usa el
# `origin` que tenga el repo, y sólo si no hay se cae a la URL conocida.
REMOTO_FIJO="git@github.com:edgarcg-01/MegaDulces_Suite.git"
# Si estás parado en un clon del repo se usa ése; si no, el clon de `auto-deploy` (modo `md`).
REPO_DIR="${AUTO_DEPLOY_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$HOME/auto-deploy/repo")}"
SELLO="${SOLTAR_SELLO:-ci-green}"
DESTINO="${SOLTAR_DESTINO:-prod-release}"
# La llave de `md` sólo se fuerza SI estamos en `md`. En tu máquina se usan tus credenciales de
# siempre — que son las que tienen escritura, y las que hacen que esto funcione.
LLAVE="$HOME/.ssh/deploy_md"
[ -f "$LLAVE" ] && export GIT_SSH_COMMAND="ssh -i $LLAVE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

MODO=soltar
VOLVER_A=''
case "${1:-}" in
  --ver)    MODO=ver ;;
  --volver) MODO=volver; VOLVER_A="${2:?falta el sha al que volver}" ;;
  '')       : ;;
  *)        echo "uso: sh ops/prod/soltar.sh [--ver | --volver SHA]"; exit 64 ;;
esac

# ⛔ Correrlo EN `md` y soltar no puede funcionar: su llave es de sólo lectura (ver cabecera).
# Se avisa ACÁ y no al llegar al push, porque para entonces ya imprimió el informe completo y
# parece que algo se rompió a mitad de camino. `--ver` sí tiene sentido desde `md`.
if [ "$MODO" != ver ] && [ -x "$HOME/ops/prod/pgprod.sh" ]; then
  echo "⛔ Estás en 'md', y su llave de despliegue es de SÓLO LECTURA: el push no va a entrar."
  echo "   Soltá desde tu máquina, parado en el repo:"
  echo "       sh ops/prod/soltar.sh"
  echo "   Desde acá sólo se puede mirar:"
  echo "       sh ops/prod/soltar.sh --ver"
  exit 77
fi

# ⚠️ Se le pregunta a git, no al sistema de archivos: en un `git worktree` el `.git` es un
# ARCHIVO, no un directorio, y un `[ -d .git ]` rechaza un clon perfectamente válido.
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 \
  || { echo "⛔ $REPO_DIR no es un repo git — ¿corrió auto-deploy alguna vez?"; exit 1; }
cd "$REPO_DIR" || exit 1
REMOTO=$(git remote get-url origin 2>/dev/null) || REMOTO=''
[ -n "$REMOTO" ] || REMOTO="$REMOTO_FIJO"

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
# El ledger de prod sólo se alcanza desde `md`. Si estamos ahí, directo; si no, por SSH.
if [ -x "$HOME/ops/prod/pgprod.sh" ]; then
  APLICADAS=$(sh "$HOME/ops/prod/pgprod.sh" -At -c 'SELECT name FROM public.knex_migrations' 2>/dev/null)
else
  APLICADAS=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$MD" \
    "sh ops/prod/pgprod.sh -At -c 'SELECT name FROM public.knex_migrations'" 2>/dev/null)
fi
if [ -z "$APLICADAS" ]; then
  echo "   ⚠️ NO MEDIDO: no pude leer knex_migrations de prod. Puede haber pendientes."
else
  # ⛔ `LC_ALL=C` en los DOS lados. Con la configuración regional del sistema, `sort` ordena con
  # reglas de idioma y `comm` exige el orden byte a byte: medido el 2026-10-07, se quejaba
  # («archivo 1 no está en orden ordenado») y **devolvía vacío**, con lo que esto imprimía
  # «ninguna pendiente» sin haber comparado nada. Un falso verde, que es peor que no medir.
  TMP_APL=$(mktemp) && TMP_ERR=$(mktemp) || { echo "   ⚠️ NO MEDIDO: no se pudo crear el temporal"; TMP_APL=''; }
  if [ -n "$TMP_APL" ]; then
    printf '%s\n' "$APLICADAS" | LC_ALL=C sort > "$TMP_APL"
    PEND=$(git ls-tree -r --name-only "$NUEVO" database/migrations-newdb/ 2>/dev/null \
             | sed 's|.*/||' | LC_ALL=C sort | LC_ALL=C comm -23 - "$TMP_APL" 2>"$TMP_ERR")
    # Si `comm` dijo algo por error, su salida no vale: se DECLARA, no se publica como cero.
    if [ -s "$TMP_ERR" ]; then
      echo "   ⚠️ NO MEDIDO: la comparación falló — $(head -1 "$TMP_ERR")"
      PEND='__NO_MEDIDO__'
    fi
    rm -f "$TMP_APL" "$TMP_ERR"
  else
    PEND='__NO_MEDIDO__'
  fi
  if [ "$PEND" = '__NO_MEDIDO__' ]; then
    : # ya se declaró arriba; «no medido» NO se imprime como «ninguna»
  elif [ -z "$PEND" ]; then
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
