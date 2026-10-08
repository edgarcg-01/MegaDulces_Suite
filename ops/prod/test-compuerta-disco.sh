#!/bin/sh
# Candado de la COMPUERTA DE DISCO de `auto-deploy.sh` (2026-10-08).
#
# ⛔ **Por qué existe.** Ese día producción se cayó: el nodo venía bajando ~4 GB por despliegue,
# nadie frenó, se construyeron seis imágenes igual, el kubelet marcó `DiskPressure=True` y
# **desalojó `pg-prod`**. La compuerta que lo impide se agregó ese mismo día — y una compuerta sin
# prueba negativa es una intención, no un freno.
#
# ⭐ **No reimplementa la lógica: EXTRAE el bloque real de `auto-deploy.sh` y lo ejecuta.** Una
# copia en el test se puede arreglar sola mientras el script de verdad sigue roto; eso es lo que
# hace que un candado dé verde sobre un sistema que no funciona. Acá, si alguien borra el freno o
# lo mueve DESPUÉS de construir, este archivo se pone rojo.
#
# Uso:  sh ops/prod/test-compuerta-disco.sh
set -u

RAIZ=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
GUION="$RAIZ/ops/prod/auto-deploy.sh"
OK=0; MAL=0

bien() { OK=$((OK+1)); printf '  ok    %s\n' "$1"; }
mal()  { MAL=$((MAL+1)); printf '  FALLA %s\n     %s\n' "$1" "${2:-}"; }

[ -f "$GUION" ] || { echo "no encuentro $GUION"; exit 2; }

# ── 1. La compuerta existe Y está ANTES de construir ────────────────────────────────────────
# ⚠️ El orden no es un detalle: un freno después del `docker build` no frena nada — el disco ya
# se consumió. Por eso se comparan los números de línea, no sólo la presencia del texto.
L_GUARDA=$(grep -n 'COMPUERTA DE DISCO' "$GUION" | head -1 | cut -d: -f1)
L_BUILD=$(grep -n '^# ── Construir y recrear' "$GUION" | head -1 | cut -d: -f1)
if [ -z "$L_GUARDA" ]; then
  mal "la compuerta de disco existe" "no aparece 'COMPUERTA DE DISCO' en auto-deploy.sh"
elif [ -z "$L_BUILD" ]; then
  mal "se encuentra el bloque de construcción" "no aparece '# ── Construir y recrear'"
elif [ "$L_GUARDA" -ge "$L_BUILD" ]; then
  mal "la compuerta va ANTES de construir" "guarda en $L_GUARDA, build en $L_BUILD"
else
  bien "la compuerta existe y va antes de construir (línea $L_GUARDA < $L_BUILD)"
fi

# ── 2. Se extrae el bloque REAL y se ejercita con topes falsos ──────────────────────────────
BLOQUE=$(mktemp); trap 'rm -f "$BLOQUE" "$BLOQUE.out"' EXIT
sed -n "${L_GUARDA},$((L_BUILD - 1))p" "$GUION" > "$BLOQUE"

# `corrida <libre_antes> <libre_despues_de_podar> <piso>` → imprime "<exit>|<salida>"
corrida() {
  _a=$1; _b=$2; _p=$3
  _fake=$(mktemp -d)
  # Un `podar-disco.sh` de mentira: no poda nada, sólo deja rastro de que lo llamaron.
  mkdir -p "$_fake/ops/prod"
  printf '#!/bin/sh\necho "   (poda simulada)"\n' > "$_fake/ops/prod/podar-disco.sh"
  # `df` falso: la 1ª llamada devuelve <antes>, las siguientes <después>. Así se distingue
  # "había espacio" de "la poda lo consiguió", que son dos caminos distintos del bloque.
  CONT="$_fake/n"; echo 0 > "$CONT"
  cat > "$_fake/df" <<DF
#!/bin/sh
n=\$(cat "$CONT"); echo \$((n + 1)) > "$CONT"
if [ "\$n" -eq 0 ]; then echo "Avail"; echo "${_a}G"; else echo "Avail"; echo "${_b}G"; fi
DF
  chmod +x "$_fake/df" "$_fake/ops/prod/podar-disco.sh"
  _s=$(cd "$_fake" && HOME="$_fake" PATH="$_fake:$PATH" AUTO_DEPLOY_PISO_GB="$_p" DESEADO=prueba \
        sh -c 'di() { echo "$*"; }; latir() { echo "LATIDO:$1:$2"; }; . '"$BLOQUE" 2>&1)
  printf '%s|%s' "$?" "$(printf '%s' "$_s" | tr '\n' ' ')"
  rm -rf "$_fake"
}

# ⭐ CONTROL POSITIVO — con espacio de sobra NO debe frenar ni podar.
R=$(corrida 100 100 55); E=${R%%|*}; S=${R#*|}
case "$E:$S" in
  0:*poda\ simulada*) mal "con 100GB no poda" "podó sin necesidad: $S" ;;
  0:*) bien "con 100GB libres sigue sin podar" ;;
  *)   mal "con 100GB libres sigue" "salió con $E — $S" ;;
esac

# ⛔ PRUEBA NEGATIVA — el corazón del candado: sin espacio, y con la poda sin efecto, FRENA.
R=$(corrida 10 10 55); E=${R%%|*}; S=${R#*|}
case "$E:$S" in
  1:*FRENADO*) bien "sin espacio y con la poda sin efecto: FRENA (exit 1)" ;;
  0:*)         mal "DEBE frenar sin espacio" "siguió adelante — esto es la caída del 8-oct otra vez: $S" ;;
  *)           mal "DEBE frenar sin espacio" "salió con $E y sin decir FRENADO: $S" ;;
esac

# Y que el fallo quede DECLARADO, no sólo impreso: sin latido nadie se entera.
R=$(corrida 10 10 55); S=${R#*|}
case "$S" in
  *LATIDO:error:*) bien "al frenar escribe un latido de error" ;;
  *)               mal "al frenar escribe un latido" "no hubo LATIDO:error — el freno sería mudo" ;;
esac

# Auto-curación: si la poda SÍ consigue el espacio, el despliegue continúa.
R=$(corrida 10 90 55); E=${R%%|*}; S=${R#*|}
case "$E:$S" in
  0:*tras\ podar*) bien "si la poda consigue el espacio, sigue" ;;
  *)               mal "con la poda efectiva debe seguir" "salió con $E — $S" ;;
esac

# ── 3. Los bordes, que es donde los umbrales se equivocan ───────────────────────────────────
R=$(corrida 55 55 55); E=${R%%|*}
[ "$E" = "0" ] && bien "justo EN el piso (55 = 55) sigue" || mal "justo en el piso sigue" "salió con $E"
R=$(corrida 54 54 55); E=${R%%|*}
[ "$E" = "1" ] && bien "un giga por debajo del piso (54 < 55) frena" || mal "54 < 55 frena" "salió con $E"

# ── 4. La escalera de la poda llega hasta el final ──────────────────────────────────────────
# ⛔ El 8-oct la poda corrió TRES veces con el disco bajo el piso y liberó cero: su escalera
# terminaba en un filtro por edad que, con despliegues cada hora, nunca muerde. Lo que resolvió
# fue vaciar el caché entero. Si ese último peldaño desaparece, volvemos al mismo día.
PODA="$RAIZ/ops/prod/podar-disco.sh"
if [ ! -f "$PODA" ]; then
  mal "existe podar-disco.sh" "no está en ops/prod/"
else
  grep -q 'buildx prune -af' "$PODA" \
    && bien "la poda escala hasta vaciar el caché (buildx prune -af)" \
    || mal "la poda escala hasta el final" "falta 'buildx prune -af': sin ese peldaño, la escalera no muerde"
  grep -q 'image prune -af' "$PODA" \
    && bien "la poda alcanza las imágenes huérfanas (image prune -af)" \
    || mal "la poda alcanza las imágenes" "falta 'image prune -af': 54 GB quedaban fuera de su alcance"
  grep -q 'PISO_LIBRE_GB' "$PODA" \
    && bien "el disparador del escalón es el PISO de disco, no el techo del caché" \
    || mal "el escalón se dispara por el piso" "no usa PISO_LIBRE_GB"
fi

echo
echo "  $OK ✓  ·  $MAL ✗"
[ "$MAL" -eq 0 ] || exit 1
