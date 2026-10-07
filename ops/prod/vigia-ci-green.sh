#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════════════════
# `[CD.20]` DESPLEGAR CUANDO EL CI APRUEBA — no cada 5 minutos, y no al pushear.
#
# ── Lo que reemplaza ────────────────────────────────────────────────────────────────────────
# El cron `*/5` de `auto-deploy.sh`, apagado el 2026-10-02 a pedido: *"debería ser cada que se
# haga push a main"*. Tenía dos defectos — tardaba hasta 5 minutos en enterarse, y hacía el
# trabajo completo (fetch de 50 commits + comparaciones) 288 veces por día para no hacer nada.
#
# ── ⭐ POR QUÉ ESCUCHA `ci-green` Y NO `main` ───────────────────────────────────────────────
# Porque **el evento que importa no es "alguien pusheó", es "el CI aprobó"**. `auto-deploy.sh`
# se niega por diseño a desplegar un commit que la rama marcadora `ci-green` no bendijo (la
# mueve el job `sellar` cuando pasan `build` y `secret-scan`). Un disparo en el push llegaría
# ANTES de que el CI termine, y el despliegue lo rechazaría — o sea un intento fallido en cada
# push, que es peor que esperar. Mirando `ci-green` dispara **una vez, y justo cuando ya es
# desplegable**.
#
# ── ⛔ POR QUÉ NO ES UN RUNNER DE GITHUB ACTIONS ────────────────────────────────────────────
# Era el plan, y se cae con una medición del 2026-10-02: **el repo es PÚBLICO**
# (`edgarcg-01/MegaDulces_Suite`, verificado con lectura anónima: HTTP 200). La propia
# documentación de GitHub desaconseja runners propios en repos públicos, porque cualquiera
# puede abrir un PR desde un fork y hacer que el workflow **ejecute su código en el runner** —
# que acá sería este servidor: el que sirve la venta, con la llave de despliegue, `kubectl` de
# administrador y la base de producción en `localhost`. Sería entregar producción a internet.
#
# ── Y por qué tampoco un webhook ────────────────────────────────────────────────────────────
# Un webhook obliga a exponer un receptor (por el túnel) y a cuidar una firma, para ganar unos
# segundos sobre esto. `git ls-remote` de UNA referencia es un pedido HTTPS diminuto, **sólo de
# salida**, sin abrir nada. Es, además, cómo funcionan por defecto las herramientas de GitOps.
#
# ⚠️ El `flock` NO es decorativo: hereda el del cron viejo. Un despliegue dura minutos; sin el
#    candado, un segundo cambio de `ci-green` lanzaría un despliegue encima del anterior.
#
# ⚠️ Escribe en el MISMO `auto-deploy.log`, así que se ve en Dozzle (`[K3S.21]`) junto al resto.
#
#   instalar:  sudo cp ops/prod/vigia-despliegue.service /etc/systemd/system/
#              sudo systemctl enable --now vigia-despliegue
#   ver:       journalctl -u vigia-despliegue -f    ·    o el pod `deploy-log` en Dozzle
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -u

REMOTO="git@github.com:edgarcg-01/MegaDulces_Suite.git"

# ── Config sin root ─────────────────────────────────────────────────────────────────────────
# El modo (automático o manual) se cambia editando ESTE archivo, no la unidad de systemd:
# `/etc/systemd/system/` exige `sudo`, y `sudo` sobre SSH no autenticado pide terminal — medido
# el 2026-10-07. El archivo es opcional: si no está, todo sigue como vino.
#
#   ~/ops/prod/vigia.env     VIGIA_REF=refs/heads/prod-release
#                            AUTO_DEPLOY_BRANCH=prod-release
#
# ⚠️ Se EXPORTAN: `AUTO_DEPLOY_BRANCH` no lo lee este guion sino `auto-deploy.sh`, que corre como
# hijo. Sin `export` el vigía miraría la ref nueva y el hijo seguiría desplegando `main`.
# Para volver al modo automático: borrar el archivo y reiniciar el vigía.
if [ -f "$HOME/ops/prod/vigia.env" ]; then
  . "$HOME/ops/prod/vigia.env"
  [ -n "${VIGIA_REF:-}" ] && export VIGIA_REF
  [ -n "${AUTO_DEPLOY_BRANCH:-}" ] && export AUTO_DEPLOY_BRANCH
fi

# Qué ref DISPARA el despliegue. Por omisión `ci-green`, que es como vino: cada commit verde de
# `main` sale solo. Con `VIGIA_REF=refs/heads/prod-release` el disparo pasa a ser manual y lo da
# `ops/prod/soltar.sh` — ver la cabecera de ese guion para el porqué.
#
# ⚠️ `ci-green` NO deja de usarse al cambiar esto: sigue siendo el SELLO del CI, y
# `compuerta-ci.sh` se niega igual a desplegar un commit que no esté en su historia. Son dos
# preguntas distintas y por eso son dos refs: «¿el CI lo aprobó?» y «¿lo queremos afuera?».
REF="${VIGIA_REF:-refs/heads/ci-green}"
INTERVALO="${VIGIA_INTERVALO:-30}"
# `[CD.21]` Cuando el despliegue queda FRENADO por migraciones se sigue reintentando, pero más
# espaciado: la condición la levanta una persona aplicando la migración, no pasa sola en 30 s.
ESPERA_BLOQUEADO="${VIGIA_ESPERA_BLOQUEADO:-120}"
# El commit sobre el que ya avisamos que estamos frenados, para no repetir el aviso cada ciclo.
# ⛔ Tiene que estar declarado acá: el guion corre con `set -u` y una variable sin definir aborta.
BLOQUEADO_EN=''
LLAVE="$HOME/.ssh/deploy_md"
LOG="$HOME/ops/prod/auto-deploy.log"
ESTADO="$HOME/ops/prod/.vigia-ci-green.sha"
LOCK=/tmp/auto-deploy.lock

export GIT_SSH_COMMAND="ssh -i $LLAVE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

di() { printf '[%s] vigía: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$1" >> "$LOG"; }

di "arrancó — mirando $REF cada ${INTERVALO}s"

# ⚠️ El SHA de arranque se SIEMBRA con lo que haya ahora, no se deja vacío. Si no, el primer
#    ciclo vería "cambió" (de nada a algo) y lanzaría un despliegue en cada reinicio del
#    servicio — incluso cuando no cambió nada. Un servicio que despliega al arrancar convierte
#    cada reinicio de la máquina en un despliegue, y hoy esta máquina se reinicia sola.
if [ ! -f "$ESTADO" ]; then
  ARRANQUE=$(git ls-remote "$REMOTO" "$REF" 2>/dev/null | cut -f1)
  [ -n "$ARRANQUE" ] && { printf '%s\n' "$ARRANQUE" > "$ESTADO"; di "sembrado en ${ARRANQUE%"${ARRANQUE#???????}"} — no despliega al arrancar"; }
fi

FALLAS=0
while :; do
  NUEVO=$(git ls-remote "$REMOTO" "$REF" 2>/dev/null | cut -f1)

  if [ -z "$NUEVO" ]; then
    # ⛔ No se pudo medir ≠ no cambió. No se toca el estado y NO se despliega; se espera más.
    #    Con red intermitente, insistir cada 30 s llena el log y no arregla nada.
    FALLAS=$((FALLAS + 1))
    [ "$FALLAS" = 1 ] && di "no pude leer $REF (red o llave) — NO MEDIDO, no es 'sin cambios'"
    [ "$FALLAS" -ge 10 ] && { di "10 lecturas seguidas fallidas — sigo intentando, más lento"; FALLAS=1; sleep 300; }
    sleep "$INTERVALO"
    continue
  fi
  FALLAS=0

  ANTERIOR=$(cat "$ESTADO" 2>/dev/null)
  if [ "$NUEVO" != "$ANTERIOR" ]; then
    [ "$NUEVO" = "$BLOQUEADO_EN" ] || di "ci-green se movió → desplegando"

    # ⛔ `[CD.21]` TRES DESENLACES DISTINTOS, Y ANTES ERAN UNO SOLO.
    #
    # `-E 9` hace que "no pude tomar el candado" salga **9** en vez de 1. Sin eso, un despliegue
    # ajeno en curso y un despliegue que FALLÓ devuelven lo mismo, y el vigía los trata igual:
    # guardaba el SHA y se perdía el disparo. (El `flock` de `md` es util-linux 2.41.3 — soporta
    # `-E`; el de busybox NO, y ahí esta forma no sirve.)
    flock -n -E 9 "$LOCK" /bin/sh "$HOME/ops/prod/auto-deploy.sh" >> "$LOG" 2>&1
    CODIGO=$?

    case "$CODIGO" in
      3)
        # FRENADO por migraciones: el código está bien, la base está sana, y la condición que
        # bloquea **se levanta sola** en cuanto alguien aplica la migración. Por eso NO se guarda
        # el SHA: hay que seguir reintentando. Medido el 2026-10-05: sin esto, aplicar la
        # migración no relanzaba nada y había que empujar el despliegue a mano.
        #
        # ⚠️ Se avisa UNA sola vez por commit. El detalle del freno son ~20 renglones; repetirlos
        #    cada 30 s vuelve el log ilegible, que es otra forma de que nadie lo mire.
        [ "$NUEVO" = "$BLOQUEADO_EN" ] || di "frenado por migraciones — reintento cada ${ESPERA_BLOQUEADO}s hasta que se apliquen"
        BLOQUEADO_EN="$NUEVO"
        sleep "$ESPERA_BLOQUEADO"
        continue
        ;;
      9)
        # Ya hay un despliegue corriendo. Tampoco se guarda el SHA: cuando termine, este disparo
        # sigue siendo válido. Callado a propósito — es una condición normal, no un problema.
        sleep "$INTERVALO"
        continue
        ;;
      0)
        di "desplegado"
        ;;
      *)
        # Falló de verdad (build roto, compuerta de humo, reversión). Acá SÍ se guarda el SHA:
        # reintentar no lo arregla, y un bucle cada 30 s sobre un build roto llena el disco.
        di "el despliegue salió con $CODIGO — no reintento; mirá el detalle arriba"
        ;;
    esac
    printf '%s\n' "$NUEVO" > "$ESTADO"
    BLOQUEADO_EN=''
  fi

  sleep "$INTERVALO"
done
