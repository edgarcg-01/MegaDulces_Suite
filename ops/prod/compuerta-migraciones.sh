#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════════════════
# `[CD.1]` ¿EL CODIGO QUE VOY A DESPLEGAR NECESITA EL ESQUEMA QUE FALTA?
#
#   printf '%s\n' "$PEND" | sh compuerta-migraciones.sh \
#       --repo <dir> --dir database/migrations-newdb --desplegado <sha> --objetivo <sha>
#   sh compuerta-migraciones.sh --self-test
#
# ⛔ POR QUE ESTO ES `sh` Y NO `node`: **en el host de `md` NO HAY node** (medido el
#    2026-10-02: ni en el PATH, ni en /usr/local/bin, ni nvm, ni snap; sólo `awk`). La app corre
#    en pods de k3s, pero depender de un pod para una compuerta de despliegue es circular: es
#    pedirle permiso para desplegar a la cosa que se está desplegando. Esta compuerta nació en
#    JS y no podía correr en su destino; el modo de falla era feo, además — `node` ausente
#    devuelve 127, y el llamador leía ese no-cero como "hay acoplamiento", o sea que la feature
#    quedaba muerta pero con cara de estar funcionando.
#    ⭐ `clasificar-migraciones.awk` ya era awk por este mismo motivo. La señal estaba puesta.
#
# ── Que decide ─────────────────────────────────────────────────────────────────────────────
# `clasificar-migraciones.awk` contesta CUALES migraciones faltan en prod. Esto contesta si
# faltar IMPORTA para ESTE despliegue:
#   1. De cada migracion pendiente se extraen los OBJETOS que crea (tablas, columnas, vistas).
#   2. Del diff <desplegado>..<objetivo> se leen los archivos de apps/ y libs/ que cambian.
#   3. Si NINGUNO nombra NINGUN objeto -> DESACOPLADO (0): el codigo no puede necesitar lo que
#      no nombra. Se despliega; las migraciones siguen pendientes.
#   4. Si alguno lo nombra -> ACOPLADO (1): frena, diciendo QUE archivo y QUE objeto.
#   5. Si no se pudo medir -> NO_MEDIDO (1): frena. Nunca se adivina (ADR-056).
#
# ⭐ El sesgo va del lado seguro: un falso positivo FRENA (cuesta una espera), un falso negativo
#    DESPLIEGA CODIGO ROTO (cuesta produccion).
#
# ── Lo que NO ve, dicho en voz alta ────────────────────────────────────────────────────────
#   · Un identificador armado por concatenacion (from('tab'+suf)) no se detecta.
#   · Una migracion que solo hace GRANT no crea objeto: cae en NO_MEDIDO y FRENA.
#   · Mira los archivos CAMBIADOS, no el repo entero: el codigo viejo que ya usaba el objeto ya
#     estaba desplegado y funcionando, asi que no es el riesgo de ESTE despliegue.
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -u

REPO=.
DIR=database/migrations-newdb
DESPLEGADO=
OBJETIVO=HEAD
SELFTEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)       REPO="$2"; shift 2 ;;
    --dir)        DIR="$2"; shift 2 ;;
    --desplegado) DESPLEGADO="$2"; shift 2 ;;
    --objetivo)   OBJETIVO="$2"; shift 2 ;;
    --self-test)  SELFTEST=1; shift ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

# ⛔⛔ `grep -i` NO SE USA EN NINGUN LADO DE ESTE ARCHIVO, Y EL MOTIVO IMPORTA.
# GNU grep 3.0 bajo MSYS (el Git Bash de las maquinas de desarrollo) falla de DOS formas al
# combinar `-i` con la lectura de patrones:
#   · `-i -F`  -> ABORTA, exit 134. Ruidoso, se ve.
#   · `-i -f`  -> devuelve **CERO coincidencias EN SILENCIO**, exit limpio. Medido el
#                 2026-10-02 sobre un archivo real de 14 KB: `-o -f` daba 6, `-i -o` daba 2,
#                 y `-i -o -f` daba 0 sin una sola linea de error.
#
# El segundo es el peligroso: esta compuerta cruza los objetos pendientes contra el codigo, asi
# que cero coincidencias se lee como DESACOPLADO — o sea que el modo de falla era **desplegar
# codigo que necesita esquema inexistente**, justo lo que la compuerta existe para impedir, y
# sin ruido que lo delatara.
#
# ⭐ Y la prueba negativa NO lo atrapo, porque corria sobre un archivo de 40 bytes y el defecto
#    aparece con volumen. Por eso ahora ejerce `cruzar()` sobre un archivo grande (ver abajo):
#    una prueba negativa que no se parece al caso real puede ponerse verde sobre un gate roto.
#
# La salida es no depender de `-i`: se baja todo a minusculas ANTES de comparar. Los objetos ya
# salen en minuscula de `extraer_objetos`, asi que alcanza con normalizar el lado del codigo.
TMP=$(mktemp -d 2>/dev/null || echo /tmp/cmig.$$)
mkdir -p "$TMP"
limpiar() { rm -rf "$TMP"; }
trap limpiar EXIT INT TERM

# ── Identificadores demasiado comunes para ser evidencia ───────────────────────────────────
# `id`, `name`, `status` aparecen en cualquier archivo: usarlos como senal volveria ACOPLADO a
# todo, y una compuerta que siempre frena es la que teniamos antes.
RUIDO='^(id|ids|name|nombre|status|estado|tipo|type|fecha|date|value|valor|total|data|key|code|codigo|activo|notes|notas|tenant_id|created_at|updated_at|deleted_at|created_by|updated_by|uuid|monto|qty|orden|order|user_id|price|precio)$'

# ═══ Extrae los objetos que una migracion crea o altera ════════════════════════════════════
# Se escanea el archivo ENTERO (no solo up()): incluir los del down() es conservador, porque
# suelen ser los MISMOS nombres y de mas objetos solo puede salir un freno de mas, nunca de
# menos.
extraer_objetos() {
  # $1 = archivo de migracion
  {
    grep -oiE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(UNIQUE[[:space:]]+)?(TABLE|SCHEMA|MATERIALIZED[[:space:]]+VIEW|VIEW)[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?[A-Za-z0-9_."]+' "$1" 2>/dev/null
    grep -oiE 'ALTER[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?[A-Za-z0-9_."]+' "$1" 2>/dev/null
    grep -oiE 'ADD[[:space:]]+COLUMN[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?[A-Za-z0-9_"]+' "$1" 2>/dev/null
    grep -oE '\.(createTable|alterTable)\([[:space:]]*["'"'"'][A-Za-z0-9_.]+' "$1" 2>/dev/null
    grep -oE '\.addColumn\([[:space:]]*["'"'"'][A-Za-z0-9_.]+["'"'"'][[:space:]]*,[[:space:]]*["'"'"'][A-Za-z0-9_]+' "$1" 2>/dev/null
    # Columnas del builder de knex: t.uuid('cliente_id'), table.text('razon_social')
    grep -oE '\b(t|table)\.[A-Za-z]+\([[:space:]]*["'"'"'][a-z0-9_]+' "$1" 2>/dev/null
  } | awk -v ruido="$RUIDO" '
      {
        # ⭐ SE CONSERVA EL NOMBRE CALIFICADO (`servicedesk.requests`), no sólo el ultimo
        # segmento. Medido el 2026-10-02 contra prod: quedarse con el segmento suelto producia
        # falsos positivos que volvian a hacer de esto un freno indiscriminado —
        # `analytics.expense_requests` marcaba por "requests", y la palabra "settings" dentro de
        # un COMENTARIO marcaba por la tabla `servicedesk.settings`. El nombre calificado es el
        # que el codigo escribe cuando de verdad consulta la tabla.
        n = split($0, p, /[ \t"\x27(,]+/)
        id = tolower(p[n])
        if (id == "") next
        sub(/^.*\)/, "", id)
        if (id !~ /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/) next

        # El filtro de ruido mira el ULTIMO segmento: lo generico es el nombre de la cosa.
        m = split(id, q, /\./)
        hoja = q[m]
        if (length(hoja) < 6) next
        if (hoja ~ ruido) next
        print id
      }' | sort -u
}

# ═══ El cruce: ¿este archivo nombra alguno de estos objetos? ════════════════════════════════
# Imprime los objetos encontrados (hasta 3). Vacio = no los nombra.
# ⛔ SIN `-i`: se normaliza a minusculas con `tr` y se compara contra objetos que ya vienen en
#    minuscula. Ver la nota de arriba — `grep -i -f` miente en silencio bajo MSYS.
cruzar() {
  # $1 = archivo con los objetos (uno por linea, minuscula)  ·  $2 = archivo de codigo
  #
  # ⭐ LIMITE DE PALABRA, no subcadena. Sin `\b`, el objeto `requests` matcheaba dentro de
  # `analytics.expense_requests` y la compuerta frenaba un despliegue que no tenia nada que ver
  # — medido contra prod el 2026-10-02. Como `_` cuenta como caracter de palabra, `\brequests\b`
  # NO matchea dentro de `expense_requests`, que es exactamente lo que se quiere.
  # El punto se escapa: en `servicedesk.requests` es un punto literal, no "cualquier caracter".
  PATS="$TMP/pats.$$"
  sed 's/\./\\./g; s/^/\\b/; s/$/\\b/' "$1" > "$PATS" 2>/dev/null
  tr '[:upper:]' '[:lower:]' < "$2" 2>/dev/null \
    | grep -o -f "$PATS" 2>/dev/null | sort -u | head -3
  rm -f "$PATS"
}

# ═══ Prueba negativa ═══════════════════════════════════════════════════════════════════════
# ADR-056: una compuerta sin prueba negativa es una intencion. Se rompe a proposito y se exige
# el rojo. El caso 3 es el que distingue a esto de un grep: un objeto que el codigo NO nombra.
if [ "$SELFTEST" = 1 ]; then
  fallas=0
  ok() { echo "   OK    $1"; }
  mal() { echo "   FALLA $1"; fallas=$((fallas+1)); }

  cat > "$TMP/m1.js" <<'EOF'
exports.up = (k) => k.raw("CREATE TABLE commercial.supplier_fill_rate (id uuid)");
EOF
  # Se espera el nombre CALIFICADO: es la forma que el codigo escribe cuando consulta la tabla,
  # y es lo que distingue una referencia real de la palabra suelta en un comentario.
  extraer_objetos "$TMP/m1.js" | grep -qx 'commercial.supplier_fill_rate' \
    && ok "extrae la tabla creada, CALIFICADA" || mal "extrae la tabla creada, CALIFICADA"

  cat > "$TMP/m2.js" <<'EOF'
exports.up = (k) => k.schema.alterTable("orders", (t) => t.text("razon_social"));
EOF
  extraer_objetos "$TMP/m2.js" | grep -qx 'razon_social' \
    && ok "extrae la columna del builder" || mal "extrae la columna del builder"

  cat > "$TMP/m3.js" <<'EOF'
exports.up = (k) => k.schema.createTable("x", (t) => t.uuid("id"));
EOF
  extraer_objetos "$TMP/m3.js" | grep -qx 'id' \
    && mal "descarta el ruido (id NO es evidencia)" || ok "descarta el ruido (id NO es evidencia)"

  cat > "$TMP/m4.js" <<'EOF'
exports.up = (k) => k.raw("CREATE INDEX ix_a ON t (c)");
EOF
  if [ -z "$(extraer_objetos "$TMP/m4.js")" ]; then
    ok "un indice no aporta objeto referenciable"
  else
    mal "un indice no aporta objeto referenciable"
  fi

  # El cruce, en las dos direcciones.
  printf 'supplier_fill_rate\n' > "$TMP/objs.txt"
  printf 'export class V { precio = 1; }\n' > "$TMP/code-limpio.ts"
  printf 'this.db.from("supplier_fill_rate").select()\n' > "$TMP/code-sucio.ts"

  if [ -z "$(cruzar "$TMP/objs.txt" "$TMP/code-limpio.ts")" ]; then
    ok "codigo que NO nombra el objeto -> DESACOPLADO"
  else
    mal "codigo que NO nombra el objeto -> DESACOPLADO"
  fi
  if [ -n "$(cruzar "$TMP/objs.txt" "$TMP/code-sucio.ts")" ]; then
    ok "codigo que SI lo nombra -> ACOPLADO (frena)"
  else
    mal "codigo que SI lo nombra -> ACOPLADO (frena)"
  fi

  # ⭐ EL CASO QUE LA VERSION ANTERIOR DE ESTA PRUEBA NO CUBRIA, Y QUE DEJO PASAR UN GATE ROTO:
  # el defecto de `grep -i -f` sólo aparece con VOLUMEN. Con 40 bytes daba verde; con 14 KB
  # devolvia cero en silencio. Acá se arma un archivo grande con el objeto enterrado al final,
  # que es como se ve un componente real.
  i=0
  while [ "$i" -lt 600 ]; do
    echo "// relleno $i: una linea cualquiera de un componente de verdad, con texto suficiente" >> "$TMP/code-grande.ts"
    i=$((i+1))
  done
  echo 'await this.db.from("Supplier_Fill_Rate").select();' >> "$TMP/code-grande.ts"
  if [ -n "$(cruzar "$TMP/objs.txt" "$TMP/code-grande.ts")" ]; then
    ok "lo encuentra en un archivo GRANDE y con may/min mezcladas ($(wc -c < "$TMP/code-grande.ts" | tr -d ' ') bytes)"
  else
    mal "lo encuentra en un archivo GRANDE y con may/min mezcladas"
  fi

  # ── Los DOS falsos positivos medidos contra prod el 2026-10-02 ──────────────────────────
  # Sin estos casos la compuerta frenaba despliegues que no tenian nada que ver, que es como
  # vuelve a ser el freno indiscriminado que esta fase vino a sacar.
  printf 'requests\nservicedesk.settings\n' > "$TMP/objs2.txt"
  printf 'const rq = await trx("analytics.expense_requests").select();\n' > "$TMP/fp1.ts"
  if [ -z "$(cruzar "$TMP/objs2.txt" "$TMP/fp1.ts")" ]; then
    ok "NO confunde 'requests' dentro de 'expense_requests' (limite de palabra)"
  else
    mal "NO confunde 'requests' dentro de 'expense_requests' (limite de palabra)"
  fi

  printf '// Pedido = existencia critica + workbook + asistente Thot + settings.\n' > "$TMP/fp2.ts"
  if [ -z "$(cruzar "$TMP/objs2.txt" "$TMP/fp2.ts")" ]; then
    ok "NO confunde la palabra 'settings' de un comentario con servicedesk.settings"
  else
    mal "NO confunde la palabra 'settings' de un comentario con servicedesk.settings"
  fi

  printf "const f = 'servicedesk.settings';\n" > "$TMP/tp2.ts"
  if [ -n "$(cruzar "$TMP/objs2.txt" "$TMP/tp2.ts")" ]; then
    ok "SI marca el nombre calificado real (servicedesk.settings)"
  else
    mal "SI marca el nombre calificado real (servicedesk.settings)"
  fi

  echo ""
  if [ "$fallas" = 0 ]; then
    echo "prueba negativa: 10/10 OK"; exit 0
  else
    echo "prueba negativa: $fallas FALLA(S)"; exit 1
  fi
fi

# ═══ Operacion ═════════════════════════════════════════════════════════════════════════════
PEND=$(cat)   # los pendientes entran por stdin, con o sin el prefijo PEND
PEND=$(printf '%s\n' "$PEND" | sed 's/^PEND[[:space:]]*//' | sed '/^[[:space:]]*$/d')

if [ -z "$PEND" ]; then
  echo "OK  sin migraciones pendientes"
  exit 0
fi
if [ -z "$DESPLEGADO" ]; then
  echo "NO_MEDIDO  falta --desplegado <sha>: no se puede saber que codigo cambia. FRENA."
  exit 1
fi

# 1. Objetos de las migraciones pendientes.
: > "$TMP/objetos.txt"
SIN_OBJETO=
for m in $PEND; do
  ARCH="$REPO/$DIR/$m"
  if [ ! -f "$ARCH" ]; then
    echo "NO_MEDIDO  no se pudo leer $m. FRENA."
    exit 1
  fi
  O=$(extraer_objetos "$ARCH")
  if [ -z "$O" ]; then
    SIN_OBJETO="$SIN_OBJETO $m"
  else
    printf '%s\n' "$O" >> "$TMP/objetos.txt"
  fi
done
sort -u "$TMP/objetos.txt" -o "$TMP/objetos.txt"

# 2. Codigo que cambia en este despliegue.
if ! (cd "$REPO" && git diff --name-only "$DESPLEGADO..$OBJETIVO") > "$TMP/cambiados-todos.txt" 2>"$TMP/git.err"; then
  echo "NO_MEDIDO  no se pudo leer el diff $DESPLEGADO..$OBJETIVO: $(head -1 "$TMP/git.err"). FRENA."
  exit 1
fi
grep -E '^(apps|libs)/.*\.(ts|js|html|sql)$' "$TMP/cambiados-todos.txt" > "$TMP/cambiados.txt" 2>/dev/null || true

N_OBJ=$(wc -l < "$TMP/objetos.txt" | tr -d ' ')
N_CAM=$(wc -l < "$TMP/cambiados.txt" 2>/dev/null | tr -d ' ')
N_PEND=$(printf '%s\n' "$PEND" | wc -l | tr -d ' ')
echo "   migraciones pendientes : $N_PEND"
echo "   objetos que crean      : $N_OBJ"
echo "   archivos de codigo que cambian: ${N_CAM:-0}"

# 3. ¿Alguno lo nombra? Se lee el contenido DEL COMMIT OBJETIVO, no el del arbol de trabajo:
#    lo que se despliega es el commit.
CHOQUES=0
if [ -s "$TMP/objetos.txt" ] && [ -s "$TMP/cambiados.txt" ]; then
  echo "" > "$TMP/choques.txt"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if (cd "$REPO" && git show "$OBJETIVO:$f" 2>/dev/null) > "$TMP/cur" 2>/dev/null; then
      HIT=$(cruzar "$TMP/objetos.txt" "$TMP/cur")
      if [ -n "$HIT" ]; then
        CHOQUES=$((CHOQUES+1))
        echo "   · $f" >> "$TMP/choques.txt"
        printf '%s\n' "$HIT" | sed 's/^/     usa "/; s/$/"/' >> "$TMP/choques.txt"
      fi
    fi
  done < "$TMP/cambiados.txt"
fi

if [ "$CHOQUES" -gt 0 ]; then
  echo ""
  echo "FRENA  el codigo de este despliegue NECESITA esquema que prod todavia no tiene:"
  head -30 "$TMP/choques.txt" | sed '/^$/d'
  echo ""
  echo "   Se aplican a mano, una por una, con lock_timeout. NUNCA migrate:latest"
  echo "   (hay DOS knex_migrations en prod)."
  exit 1
fi

if [ -n "$SIN_OBJETO" ]; then
  echo ""
  echo "NO_MEDIDO  hay migraciones de las que no se pudo extraer ningun objeto"
  echo "           (p.ej. solo GRANT o solo INSERT): no se puede probar que el codigo"
  echo "           no dependa de ellas. FRENA."
  for m in $SIN_OBJETO; do echo "   · $m"; done
  exit 1
fi

echo ""
echo "DESACOPLADO  ninguno de los archivos que cambian nombra los objetos pendientes."
echo "             El codigo puede desplegarse; las migraciones siguen pendientes."
exit 0
