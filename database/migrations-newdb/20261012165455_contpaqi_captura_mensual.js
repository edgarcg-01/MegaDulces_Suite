'use strict';
/**
 * `[CPA.10]` — **Lo que la contadora TECLEA, por mes y por familia de captura.**
 *
 * El semáforo de `[CPA.0]` (`v_contpaqi_cierre_mensual`) contesta *¿el mes está asentado?* y
 * agrupa por **cuenta** (`2120`, `1020`, `401*`…). Esta vista contesta la otra pregunta, que es
 * la del trabajo diario: *¿qué estoy capturando a mano, y de eso cuánto podemos armarle?* — y
 * para eso el eje no es la cuenta, es el **concepto de la póliza**, que es como ella nombra su
 * propio trabajo. Son dos taxonomías distintas sobre la misma tabla; ninguna reemplaza a la otra.
 *
 * ── Lo medido antes, contra PROD (`system_identifier 7688376744939610156`), 2026-10-12 ─────────
 *  · ContPAQi recibe **~12,357 renglones al mes** capturados a mano, estable 5 meses
 *    (may 11,621 · jun 12,246 · jul 13,228 · ago 12,358 · sep 11,486).
 *  · Con el clasificador de abajo, jul–sep 2026 reparte así (renglones/mes):
 *      cobranza_sucursal 3,477 · pago_gasto 2,722 · venta_diaria 2,653 ·
 *      comisiones_bancarias 1,532 · nomina 706 · venta_telemarketing 408 ·
 *      libro_compras 407 · traspasos 371 · otros 44 · gastos_varios 37.
 *  · **93.6 %** cae en familias cuya fuente ya está cargada de este lado y a grano más fino.
 *
 * ── ⛔ Dos patrones que costaron encontrar, y que un clasificador "obvio" pierde ───────────────
 *  1. **`VTA.` lleva PUNTO, no espacio.** Con `concepto ILIKE 'VTA %'` la venta diaria caía de
 *     2,653 a 1,181 renglones/mes y los **1,472 restantes se iban a `otros`** sin que nada
 *     fallara. El concepto real es `VTA.4/9/26 Suc. 3 Morelia Madero`. Medido: con el patrón
 *     corregido la familia da **7,960 renglones en jul–sep**, idéntico al conteo independiente
 *     de `FASE_CPA` §3 — dos derivaciones distintas que coinciden.
 *  2. **`TLMKT <sucursal>` es una familia propia**, no ruido: 1,225 renglones en jul–sep
 *     (~408/mes) que `FASE_CPA` tenía enterrados en su `otros` del 4.0 %. Al separarla —y a
 *     `GASTOS *`— el bucket sin clasificar baja a **44 renglones/mes (0.4 %)**.
 *
 * ── ⛔ El `CROSS JOIN` no es adorno, es la lección de septiembre ───────────────────────────────
 * Con `GROUP BY` puro, el mes que no tiene **ni un renglón** de una familia simplemente no
 * produce fila, y la familia **desaparece del tablero** en vez de gritar. Así se perdió la
 * póliza de compras de septiembre-2026 ($30.3 M pagados a proveedores contra $0 de compras
 * registradas): nadie la vio faltar porque no había dónde verla faltar. Acá cada mes × familia
 * existe siempre, con `renglones = 0` cuando toca.
 *
 * ⚠️ **El veredicto NO se calcula acá.** La vista publica la señal; quién puede armarse, con qué
 * fuente y qué queda declarado lo decide `mi-cierre.engine.ts` (mismo reparto que
 * `cierre.engine.ts` en `[CPA.0]`). Una política de negocio dentro de un `CASE` de SQL es una
 * regla que nadie puede probar con una prueba negativa.
 *
 * Sólo lectura, idempotente, sin tablas nuevas.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_contpaqi_captura_mensual';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH familias(familia, orden) AS (
      VALUES
        ('cobranza_sucursal',    1),
        ('pago_gasto',           2),
        ('venta_diaria',         3),
        ('comisiones_bancarias', 4),
        ('nomina',               5),
        ('venta_telemarketing',  6),
        ('libro_compras',        7),
        ('traspasos',            8),
        ('gastos_varios',        9),
        ('otros',               10)
    ),
    -- Una póliza, una familia. El orden de los WHEN es la precedencia y NO es libre:
    -- '%COMISION%' va antes que 'PAGO%' porque existe "PAGO COMISIONES ..." y es comisión.
    clasificada AS (
      SELECT p.tenant_id,
             p.anio_mes,
             CASE
               WHEN p.concepto ILIKE 'NOM %'                  THEN 'nomina'
               WHEN p.concepto ILIKE '%COMISION%'             THEN 'comisiones_bancarias'
               WHEN p.concepto ILIKE '%TRASPASO%'             THEN 'traspasos'
               WHEN p.concepto ILIKE '%COMPRAS DEL MES%'
                 OR p.concepto ILIKE '%REGISTRO DE COMPRAS%'  THEN 'libro_compras'
               WHEN p.concepto ILIKE 'VENTAS %'               THEN 'cobranza_sucursal'
               -- ⛔ 'VTA%' sin espacio: el concepto real es 'VTA.4/9/26 Suc. 3 ...'
               WHEN p.concepto ILIKE 'VTA%'                   THEN 'venta_diaria'
               WHEN p.concepto ILIKE 'TLMKT%'                 THEN 'venta_telemarketing'
               WHEN p.concepto ILIKE 'PAGO%'                  THEN 'pago_gasto'
               WHEN p.concepto ILIKE 'GASTOS %'               THEN 'gastos_varios'
               ELSE 'otros'
             END AS familia,
             p.num_lines,
             p.cargos
        FROM analytics.gl_polizas p
       WHERE p.source = 'contpaqi'
         AND p.anio_mes >= '2025-01'
    ),
    medida AS (
      SELECT tenant_id, anio_mes, familia,
             count(*)                       AS polizas,
             coalesce(sum(num_lines), 0)    AS renglones,
             coalesce(sum(cargos), 0)       AS cargos
        FROM clasificada
       GROUP BY tenant_id, anio_mes, familia
    ),
    -- Todos los meses con actividad, para cruzarlos contra TODAS las familias.
    meses AS (
      SELECT DISTINCT tenant_id, anio_mes FROM clasificada
    )
    SELECT ms.tenant_id,
           ms.anio_mes,
           f.familia,
           f.orden,
           coalesce(md.polizas,   0)::int    AS polizas,
           coalesce(md.renglones, 0)::int    AS renglones,
           coalesce(md.cargos,    0)::numeric(18,2) AS cargos,
           -- El mes en curso está incompleto por definición: se marca, no se juzga.
           (ms.anio_mes = to_char(CURRENT_DATE, 'YYYY-MM')) AS en_curso
      FROM meses ms
      CROSS JOIN familias f
      LEFT JOIN medida md
             ON md.tenant_id = ms.tenant_id
            AND md.anio_mes  = ms.anio_mes
            AND md.familia   = f.familia`);

  // ⚠️ `security_invoker` NO se hereda y se PIERDE en cada `CREATE OR REPLACE VIEW` (ADR-057).
  // Sin esto la vista corre con los permisos de su dueño y el RLS del consumidor no aplica.
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW ${VISTA} IS
    'CPA.10 - lo que se captura A MANO en ContPAQi, por mes x familia de CONCEPTO (no de cuenta: eso es v_contpaqi_cierre_mensual). Medido 2026-10-12: ~12,357 renglones/mes, 93.6% en familias con fuente ya cargada de este lado. El patron VTA lleva PUNTO (VTA.4/9/26), no espacio: con espacio se pierden 1,472 renglones/mes a otros sin que nada falle. El CROSS JOIN es a proposito: con GROUP BY la familia ausente no produce fila y desaparece del tablero, que es como se perdio la poliza de compras de septiembre-2026. El veredicto (quien se puede armar y con que fuente) lo emite mi-cierre.engine.ts, no este SQL.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
