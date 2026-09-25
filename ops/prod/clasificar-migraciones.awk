# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[VL.21]` UNA MIGRACIÓN "PENDIENTE" PUEDE SER UN NOMBRE VIEJO — Y APLICARLA HACE DAÑO.
#
# ── El caso real que lo obliga (2026-09-24) ─────────────────────────────────────────────────
# La compuerta reportó **2 migraciones sin aplicar** y frenó el despliegue:
#
#     20260925120000_finance_caos_cash_movements.js
#     20260925120100_grant_finance_caos_ver.js
#
# El reflejo natural —y lo que se pidió— era aplicarlas. **Habría sido un error.** Esos dos
# archivos son los nombres VIEJOS de un renombre a medio commitear: otra sesión los movió a
# `…140000` / `…140100` porque los slots `…1200xx` ya estaban ocupados, y esas dos SÍ están
# aplicadas en prod (lote 540, con `analytics.caos_cash_movements` poblada: 773 filas).
# El borrado de los originales está **stageado pero sin commitear**, así que `HEAD` todavía los
# lista y `comm -23` los ve como pendientes. La compuerta no estaba equivocada: `HEAD` los tiene
# y prod no. Lo que faltaba era la pregunta siguiente.
#
# ⛔ **El daño que evita:** aplicarlas deja en `public.knex_migrations` una fila para un archivo
# que en cuanto se commitee el renombre **ya no existe en el repo** — exactamente el estado que
# este proyecto ya vivió como *"directory corrupt" → crash loop* (por eso la regla dura de no
# borrar migraciones aplicadas). Más el `CREATE` repetido sobre lo que ya existe.
#
# ── Cómo distingue, sin adivinar ────────────────────────────────────────────────────────────
# ⭐ Por el **blob de git**, no por el nombre ni por un hash que haya que calcular: git ya es
# direccionable por contenido, así que dos archivos idénticos comparten SHA. Si una supuesta
# pendiente tiene el MISMO blob que una que prod ya aplicó bajo otro nombre, no falta nada:
# aplicarla volvería a correr, palabra por palabra, algo que ya corrió.
#
# ⚠️ Se compara CONTENIDO y no el sufijo del nombre a propósito. Dos migraciones distintas
# pueden llamarse `…_add_index.js`; dejarlas pasar por parecido sería el error opuesto —y peor,
# porque saltea una migración de verdad. Contenido idéntico no tiene ese falso negativo.
#
# ⚠️ Lo que NO cubre, y se declara: un renombre que además EDITA el archivo (aunque sea un
# comentario) cambia el blob y vuelve a verse como pendiente. Está bien que así sea: si el
# contenido cambió, alguien tiene que mirarlo.
#
# ── Entrada / salida ────────────────────────────────────────────────────────────────────────
#   awk -v prod=<archivo con los nombres aplicados en prod, uno por línea> \
#       -f clasificar-migraciones.awk <archivo con "  <blob-sha> <basename>" por línea>
#
#   PEND <basename>                 → falta de verdad; hay que aplicarla
#   DUP  <basename> <ya-aplicada>   → mismo contenido que una ya aplicada: NO aplicar
# ─────────────────────────────────────────────────────────────────────────────────────────────
BEGIN {
  if (prod == "") { print "ERROR: falta -v prod=<archivo>" > "/dev/stderr"; salir = 1; exit 2 }
  # ⚠️ `getline < archivo` devuelve 0 en fin de archivo y **-1 si no se pudo abrir**. Sin
  # distinguirlos, un archivo ilegible se leería como "prod no tiene ninguna aplicada" y TODAS
  # las migraciones saldrían como pendientes — un freno total que parece un hallazgo.
  while ((r = (getline linea < prod)) > 0) aplicada[linea] = 1
  if (r < 0) { print "ERROR: no se pudo leer " prod > "/dev/stderr"; salir = 1; exit 2 }
}

# "<blob-sha> <basename>"
NF >= 2 {
  sha = $1; base = $2
  blobDe[base] = sha
  orden[++n] = base
  if (base in aplicada) yaAplicadaConBlob[sha] = base
}

END {
  if (salir) exit 2
  for (i = 1; i <= n; i++) {
    base = orden[i]
    if (base in aplicada) continue
    sha = blobDe[base]
    if (sha in yaAplicadaConBlob) print "DUP " base " " yaAplicadaConBlob[sha]
    else print "PEND " base
  }
}
