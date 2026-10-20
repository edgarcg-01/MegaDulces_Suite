'use strict';
/**
 * `[RD.84.0]` — **El padrón se leía A HOY y se aplicaba a CUALQUIER quincena.**
 *
 * ── Lo medido contra prod el 2026-10-20 (sólo lectura) ──────────────────────────────────────
 * `commission_route_config` ganó `activo_hasta` ayer (batch 968) y las rutas **321 y 322**
 * quedaron con `activo = false`, `activo_hasta = 2026-07-15`. Correcto: pasaron de Ruta Directa
 * a Vecinal.
 *
 * ⛔ **Pero nadie lee esa columna.** `analytics.v_rd_commission_universe` resuelve
 * `comisiona = (c.route_code IS NOT NULL AND c.activo)` — sin fecha — y el motor consume esa
 * vista **sin pasarle el periodo**. O sea que el padrón de HOY se aplica hacia atrás a toda la
 * historia:
 *
 *     el libro le pagó a la 321 ...... 5 quincenas con pago, $19,096.84 (2026-01-01 -> 2026-07-15)
 *     el motor hoy, al recalcularlas ..                   $0.00
 *
 * **$19,096.84 que una baja correcta convierte en cero.** No es un error de pintura: es el
 * resultado que `POST /commissions/recalculate-from` produciría si alguien lo corre sobre
 * Q10 — y ése es el único camino que el módulo tiene para escribir.
 *
 * ⭐⭐ **Por qué esto va ANTES de hacer el padrón editable (`[RD.84]`).** Mientras la vigencia no
 * se respete, cada baja hecha desde la pantalla **reescribe la historia en silencio** en el
 * siguiente recálculo. Darle el botón a Comercial sin esto es repartir esa trampa.
 *
 * ── Qué hace esta migración, y qué NO ───────────────────────────────────────────────────────
 * Agrega **`activo_desde`** (`date`, nullable), que es la mitad que faltaba: `activo_hasta`
 * cierra la vigencia y sin su par el alta de una ruta también reescribe hacia atrás — una ruta
 * dada de alta hoy comisionaría la quincena 1.
 *
 * ⭐ `NULL` significa **«desde siempre»**, y por eso el backfill es *no hacer nada*: las 13 filas
 * actuales conservan exactamente el comportamiento que tienen hoy. La migración **no cambia un
 * solo resultado por sí sola**; habilita que el motor lo haga, con su prueba.
 *
 * ⛔ **NO se toca `analytics.v_rd_commission_universe`.** Tiene nueve consumidores y describe el
 * universo **de hoy**, que es lo que la pantalla del padrón necesita. La vigencia **por periodo**
 * es una pregunta del motor, y el motor la resuelve leyendo la tabla con la fecha en la mano
 * (`universo(trx, tenantId, from, to)`). Mover esa regla a la vista obligaría a parametrizarla
 * —una vista no toma parámetros— o a congelar una fecha adentro, que es peor.
 *
 * ── La regla, escrita una sola vez ──────────────────────────────────────────────────────────
 *
 *     vigente_en(periodo) =
 *          (activo_desde IS NULL OR activo_desde <= date_to)
 *       AND (activo OR (activo_hasta IS NOT NULL AND activo_hasta >= date_from))
 *
 * ⚠️ `activo = false` **sin** `activo_hasta` no comisiona en ningún periodo. Es la lectura
 * conservadora y es la que conserva el comportamiento actual: una baja sin fecha es una baja de
 * la que no sabemos desde cuándo, y pagar sobre un «no sabemos» es justamente lo que ADR-056
 * prohíbe.
 *
 * ⚠️ Una baja **a mitad de quincena** (`activo_hasta` entre `date_from` y `date_to`) **paga la
 * quincena entera**, porque la venta de los días en que sí operó cuenta y el tabulador no se
 * puede prorratear sin inventar un escalón. La pantalla de `[RD.84]` tiene que avisarlo y
 * proponer el cierre del periodo como fecha.
 *
 * Idempotente: `hasColumn` antes de `addColumn`. Aditiva: ninguna columna se borra ni cambia de
 * tipo, y ningún `NOT NULL` nuevo (regla dura — un `NOT NULL` obliga a recorrer todos los
 * caminos que insertan).
 */

const TABLA = 'commission_route_config';

exports.up = async function up(knex) {
  const tiene = await knex.schema.withSchema('commercial').hasColumn(TABLA, 'activo_desde');
  if (!tiene) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => {
      t.date('activo_desde')
        .comment('Primer dia en que la ruta comisiona. NULL = desde siempre. Par de activo_hasta: '
          + 'sin el, un alta de hoy comisionaria la quincena 1. Ver [RD.84.0].');
    });
  }

  // El comentario de `activo_hasta` se completa acá: la columna existia desde el batch 968 pero
  // su contrato («>= date_from del periodo») no estaba escrito en la base, donde lo lee quien
  // consulta la tabla sin abrir el repositorio.
  await knex.raw(`
    COMMENT ON COLUMN commercial.commission_route_config.activo_hasta IS
      'Ultimo dia en que la ruta comisiona. NULL + activo=false = baja sin fecha: NO comisiona en '
      'ningun periodo (lectura conservadora, ADR-056). La regla completa en [RD.84.0].'
  `);
};

exports.down = async function down(knex) {
  // ⛔ No se borra la columna: la regla dura del repo prohibe borrar columnas en prod, y un
  // `down` que las borra es la misma accion con otro nombre. Revertir esta migracion significa
  // dejar de LEER `activo_desde` (eso vive en el codigo del motor), no destruir el dato que
  // alguien haya capturado mientras tanto.
  await knex.raw(`
    COMMENT ON COLUMN commercial.commission_route_config.activo_hasta IS NULL
  `);
};
