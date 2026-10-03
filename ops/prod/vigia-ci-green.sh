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
REF="refs/heads/ci-green"
INTERVALO="${VIGIA_INTERVALO:-30}"
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
    di "ci-green se movió → desplegando"
    # El candado hace que, si ya hay un despliegue corriendo, éste no entre. El estado se
    # actualiza IGUAL para no reintentar en bucle los 30 s siguientes: si el que corre falla,
    # su propia reversión se encarga, y el próximo movimiento de `ci-green` vuelve a disparar.
    printf '%s\n' "$NUEVO" > "$ESTADO"
    flock -n "$LOCK" /bin/sh "$HOME/ops/prod/auto-deploy.sh" >> "$LOG" 2>&1 \
      || di "no corrió (candado tomado por otro despliegue, o salió con error — mirá arriba)"
  fi

  sleep "$INTERVALO"
done
