#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# `[CI.SELLO]` EL CANDADO DE LA COMPUERTA DE CI — con su prueba negativa.
#
#   sh ops/prod/test-compuerta-ci.sh
#
# Corre `compuerta-ci.sh` —EL MISMO archivo que corre en producción, no una copia de su lógica—
# contra repos de git armados a propósito para cada caso.
#
# ⛔ Los dos casos que de verdad importan son los NEGATIVOS (4 y 5): una compuerta que nunca dice
#    que no es indistinguible de no tener compuerta, y así fue como este repo llegó a tener el CI
#    corriendo mientras 15 de 20 pushes a `main` quedaban en rojo sin que nada los frenara.
# ─────────────────────────────────────────────────────────────────────────────
set -u

AQUI=$(cd "$(dirname "$0")" && pwd)
COMPUERTA="$AQUI/compuerta-ci.sh"
[ -f "$COMPUERTA" ] || { echo "FALLO: no encuentro $COMPUERTA"; exit 1; }

BASE=$(mktemp -d 2>/dev/null || echo "/tmp/test-compuerta-ci.$$")
mkdir -p "$BASE"
OK=0; MAL=0

limpiar() { rm -rf "${BASE:?}" 2>/dev/null; }
trap limpiar EXIT

# Arma un repo con N commits. Devuelve su ruta por stdout.
armar() {
  _d="$BASE/$1"; _n="${2:-2}"
  mkdir -p "$_d" && cd "$_d" || return 1
  git init -q . 2>/dev/null
  git config user.email t@t.t; git config user.name t
  git config core.autocrlf false   # el aviso de CRLF ensucia la salida y no aporta nada acá
  _i=1
  while [ "$_i" -le "$_n" ]; do
    echo "$_i" > f.txt; git add f.txt; git commit -qm "c$_i"
    _i=$((_i+1))
  done
  echo "$_d"
}

# Fija el marcador `ci-green` sin red, como si el CI ya lo hubiera empujado.
sellar_en() { git -C "$1" update-ref refs/remotes/origin/ci-green "$2"; }

probar() {
  _nombre="$1"; _dir="$2"; _esperado="$3"; _sha="${4:-HEAD}"
  _salida=$(CI_SELLO_SIN_FETCH=1 sh "$COMPUERTA" "$_dir" "$_sha" 2>&1); _rc=$?
  if [ "$_rc" = "$_esperado" ]; then
    OK=$((OK+1)); printf "   ✓ %-52s exit=%s  %s\n" "$_nombre" "$_rc" "$_salida"
  else
    MAL=$((MAL+1)); printf "   ✗ %-52s esperaba exit=%s, dio %s  %s\n" "$_nombre" "$_esperado" "$_rc" "$_salida"
  fi
}

echo "=== compuerta de CI — casos ==="

# 1. El sello apunta EXACTAMENTE al commit a desplegar.
R=$(armar sellado 2); sellar_en "$R" "$(git -C "$R" rev-parse HEAD)"
probar "sellado: ci-green == HEAD" "$R" 0

# 2. El sello está ADELANTE: el commit ya fue bendecido en su momento.
#    (Cubre el desfase normal: main avanzó mientras esta pasada miraba un commit anterior.)
R=$(armar ancestro 3); sellar_en "$R" "$(git -C "$R" rev-parse HEAD)"
probar "sellado: HEAD es ancestro de ci-green" "$R" 0 "HEAD~2"

# 3. Sin sello pero recién commiteado → esperar, NO es error.
R=$(armar esperando 2); sellar_en "$R" "$(git -C "$R" rev-parse HEAD~1)"
probar "esperando: sin sello, commit reciente" "$R" 10

# 4. ⛔ PRUEBA NEGATIVA — sin sello y pasada la tolerancia → FRENA.
R=$(armar frenado 2); sellar_en "$R" "$(git -C "$R" rev-parse HEAD~1)"
_salida=$(CI_SELLO_SIN_FETCH=1 CI_SELLO_TOLERANCIA=0 sh "$COMPUERTA" "$R" HEAD 2>&1); _rc=$?
if [ "$_rc" = 20 ]; then
  OK=$((OK+1)); printf "   ✓ %-52s exit=%s  %s\n" "FRENADO: sin sello y vencido (prueba negativa)" "$_rc" "$_salida"
else
  MAL=$((MAL+1)); printf "   ✗ %-52s esperaba exit=20, dio %s  %s\n" "FRENADO: sin sello y vencido (prueba negativa)" "$_rc" "$_salida"
fi

# 5. ⛔ PRUEBA NEGATIVA — el marcador NO existe: se DECLARA, no se frena ni se finge verde.
R=$(armar sin_marcador 2)
probar "no medido: ci-green no existe" "$R" 30

# 6. Directorio que no es repo → tampoco inventa un verde.
probar "no medido: directorio inexistente" "$BASE/no-existe" 30

echo
echo "   $OK ✓   $MAL ✗"
[ "$MAL" = 0 ] || exit 1
echo "✅ la compuerta distingue sellado / esperando / frenado / no medido — y SÍ dice que no."
