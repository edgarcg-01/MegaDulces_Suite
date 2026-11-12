#!/bin/sh
# ops/prod/etiqueta-imagen.sh — `[OPS.ING.1]` la etiqueta de una imagen de ingesta = el hash de LO QUE COPIA.
#
#   sh ops/prod/etiqueta-imagen.sh <Dockerfile> [<commit>]      (desde la raíz del repo)
#   → e-<12 hex>
#
# ⛔ POR QUÉ NO EL COMMIT. Los manifiestos de ingesta pedían `:__COMMIT__`, así que cada despliegue cambiaba la
# plantilla de los once carriles y los reiniciaba todos, aunque no hubiera cambiado ni una línea suya. Con la ingesta
# siguiendo a la API (varias veces al día), eso reiniciaría el ODS y le cortaría la sesión a los relojes en cada
# soltar. Es el mismo defecto que `[DEPLOY.2]` cerró para `pg-prod` y `caddy` (`scripts/check-base-image-tags.js`).
#
# ⭐ Distinto de `[DEPLOY.2]`: el hash NO se escribe en el manifiesto (obligaría a tocarlo en cada cambio de un
# importer). Se calcula al desplegar, de los OBJETOS DE GIT del commit — no del árbol de trabajo —, así que da lo
# mismo en Windows y en Linux, y en un clon superficial (no necesita historia, sólo el árbol de ese commit).
#
# Entradas = el Dockerfile + la fuente de cada `COPY` (sin `--from`). Exclusiones = cada `RUN rm -rf ./<ruta>` de
# un renglón: así `trade-ingest` deja fuera `database/importers/checadores`, que vive en `trade-relojes`.
# Una entrada que no existe en el commit FALLA: hashear la ausencia daría una etiqueta estable y falsa.
#
# ⚠️ Lo que NO cubre, y se declara: la imagen base de upstream (`node:20-alpine`) y lo que baje `npm install`
# dentro de los rangos `^` de `ops/ingest/package.json`. Mismo alcance que `[DEPLOY.2]`.
set -eu

DF="${1:?uso: etiqueta-imagen.sh <Dockerfile> [<commit>]}"
REF="${2:-HEAD}"

git cat-file -e "$REF:$DF" 2>/dev/null || { echo "etiqueta-imagen: $DF no existe en $REF" >&2; exit 1; }
TEXTO=$(git show "$REF:$DF" | tr -d '\r')

# Fuentes de cada COPY: todos los argumentos menos el último (el destino) y menos las banderas.
FUENTES=$(printf '%s\n' "$TEXTO" | awk '
  $1 == "COPY" {
    n = 0; desde = 0
    for (i = 2; i <= NF; i++) {
      if ($i ~ /^--from/) desde = 1
      if ($i ~ /^--/) continue
      n++; a[n] = $i
    }
    if (!desde) for (i = 1; i < n; i++) print a[i]
  }')
EXCLUIDAS=$(printf '%s\n' "$TEXTO" | sed -n 's#^RUN[[:space:]][[:space:]]*rm[[:space:]][[:space:]]*-rf[[:space:]][[:space:]]*\./\([^[:space:];&|]*\)[[:space:]]*$#\1#p')

[ -n "$FUENTES" ] || { echo "etiqueta-imagen: $DF no copia nada del repo — ¿cambió la forma del Dockerfile?" >&2; exit 1; }

ENTRADAS=$(printf '%s\n%s\n' "$DF" "$FUENTES" | sed 's#/*$##' | sort -u)
for e in $ENTRADAS; do
  git cat-file -e "$REF:$e" 2>/dev/null \
    || { echo "etiqueta-imagen: falta la entrada $e de $DF en $REF" >&2; exit 1; }
done

# shellcheck disable=SC2086  # las entradas son rutas del repo, sin espacios (lo comprueba el cat-file de arriba)
HASH=$(git ls-tree -r "$REF" -- $ENTRADAS \
  | awk -F '\t' -v ex="$(printf '%s ' $EXCLUIDAS)" '
      BEGIN { n = split(ex, E, " ") }
      { for (i = 1; i <= n; i++) if ($2 == E[i] || index($2, E[i] "/") == 1) next; print }' \
  | sha256sum | cut -c1-12)

echo "e-$HASH"
