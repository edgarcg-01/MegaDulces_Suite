#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# `[CI.SELLO]` ¿EL COMMIT QUE SE VA A DESPLEGAR ESTÁ SELLADO POR EL CI?
#
#   compuerta-ci.sh <dir-del-repo> [<sha>]      # sha por default: HEAD
#
# Sale con:
#   0  SELLADO    — el CI lo bendijo. Seguí.
#   10 ESPERANDO  — todavía no, pero el commit es reciente. No es un error: reintentá.
#   20 FRENADO    — lleva demasiado sin sello. O el CI falló, o el job `sellar` no corrió.
#   30 NO_MEDIDO  — no se pudo traer `ci-green`. Seguí: no haber medido no es motivo para
#                   frenar un despliegue (ADR-056).
#
# ── Por qué vive en su propio archivo y no dentro de `auto-deploy.sh` ────────
# Por lo mismo que `clasificar-migraciones.awk`: para poder PROBARLO. Una compuerta cuya lógica
# está embebida sólo se puede testear duplicándola, y un test que duplica la lógica se pone verde
# con la lógica equivocada. Acá `test-compuerta-ci.sh` corre ESTE archivo, el mismo que corre en
# producción, contra repos de mentira armados a propósito.
#
# ── Qué sella `ci-green` ────────────────────────────────────────────────────
# La mueve el job `sellar` de `.github/workflows/ci.yml` cuando pasan `build` y `secret-scan`.
# NO incluye `verify` (lint/tests/estilo): ver el porqué medido en la cabecera de ese job.
#
# ⚠️ La igualdad se comprueba ANTES del recorrido del grafo: el clon de despliegue es
#    `--depth 50` y `merge-base --is-ancestor` puede no tener historia suficiente. El caso
#    normal (sello == HEAD) no la necesita, y sin ese atajo un clon superficial frenaría un
#    commit perfectamente sellado.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:?falta el directorio del repo}"
SHA_PEDIDO="${2:-HEAD}"

# Cuánto se tolera sin sello antes de gritar. El CI tarda ~4 min y la agenda dispara cada 5, así
# que la pasada siguiente a un push normalmente llega antes que el sello: eso NO es una falla.
# A los 30 min ya no es que falte, es que falló.
TOLERANCIA="${CI_SELLO_TOLERANCIA:-1800}"

cd "$DIR" 2>/dev/null || { echo "NO_MEDIDO: no existe $DIR"; exit 30; }

# ⛔ `--verify --quiet` NO es decorativo: `git rev-parse <ref-que-no-existe>` **imprime la ref de
#    vuelta en stdout** y sale con error. Sin `--verify`, la variable queda con el texto de la ref
#    en vez de vacía, el chequeo de "vacío" nunca dispara, y la compuerta sigue de largo con un
#    sello inventado. Lo encontró `test-compuerta-ci.sh` (caso 5): daba ESPERANDO donde debía dar
#    NO_MEDIDO — o sea que un repo sin marcador se veía igual que uno con el CI corriendo.
CABEZA=$(git rev-parse --verify --quiet "$SHA_PEDIDO^{commit}") \
  || { echo "NO_MEDIDO: no resuelve $SHA_PEDIDO"; exit 30; }
CORTO=$(git rev-parse --short "$CABEZA")

# Traer el marcador. Si no se puede (red, llave, la rama todavía no existe porque el CI nunca
# selló), se DECLARA y se sigue — frenar por no haber podido medir es peor que no frenar.
if [ "${CI_SELLO_SIN_FETCH:-0}" != "1" ]; then
  git fetch --depth 50 origin "+refs/heads/ci-green:refs/remotes/origin/ci-green" >/dev/null 2>&1 \
    || { echo "NO_MEDIDO: no se pudo traer ci-green (red, llave, o el CI nunca selló)"; exit 30; }
fi

SELLO=$(git rev-parse --verify --quiet "refs/remotes/origin/ci-green^{commit}") \
  || { echo "NO_MEDIDO: ci-green no existe (el CI nunca selló, o el fetch no lo trajo)"; exit 30; }
SELLO_CORTO=$(git rev-parse --short "$SELLO")

if [ "$SELLO" = "$CABEZA" ] || git merge-base --is-ancestor "$CABEZA" "$SELLO" 2>/dev/null; then
  echo "SELLADO: $CORTO (ci-green=$SELLO_CORTO)"
  exit 0
fi

EDAD=$(( $(date +%s) - $(git log -1 --format=%ct "$CABEZA") ))
if [ "$EDAD" -lt "$TOLERANCIA" ]; then
  echo "ESPERANDO: $CORTO sin sello hace ${EDAD}s (ci-green=$SELLO_CORTO, tolerancia ${TOLERANCIA}s)"
  exit 10
fi

echo "FRENADO: $CORTO lleva ${EDAD}s sin sello del CI (ci-green=$SELLO_CORTO)"
exit 20
