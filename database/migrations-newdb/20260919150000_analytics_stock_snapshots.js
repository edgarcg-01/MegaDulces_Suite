'use strict';
/**
 * AB.0b — La foto de inventario. **El reloj de la Fase AB.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * Pedido del PM (2026-09-19): *"desarrolla un sistema de fotografía de inventario
 * diario, semanal, mensual, trimestral y anual, para tener esa historia por cierre"*.
 *
 * Medido antes de construir: **no hay ninguna serie histórica de existencia**.
 * `commercial.stock` (57,805 pares) es estado ACTUAL y se pisa a sí mismo;
 * `analytics.stock_ledger` y `commercial.floor_stockouts` tienen 1 fila cada una.
 * O sea: hoy nadie puede responder *"¿cuánto inventario había el 31 de agosto?"*.
 *
 * ⏱️ **Es un reloj de una sola dirección.** La venta se puede reconstruir del ERP;
 * la EXISTENCIA de un día que ya pasó, no — nadie la guardó. Cada día que esto no
 * corre es un día de historia que no se recupera. Por eso va primero, antes que
 * cualquier pantalla.
 *
 * ── Qué desbloquea ───────────────────────────────────────────────────────────
 * El §5 del pedido exige, antes de proponer bajar un parámetro, descartar que la
 * venta haya caído **porque no había producto**. Eso pide contar *días con
 * existencia*, y sin esta serie el descarte es incomputable. Es el caso que el
 * propio pedido marca como el más caro si falla.
 *
 * ── Dos tablas, y la segunda es la que evita mentir ──────────────────────────
 * `stock_snapshots` guarda sólo los pares con **saldo ≠ 0**: medido, son 27,269 de
 * 57,805 (10.0 M filas/año en vez de 21.1 M). Pero entonces una fila ausente es
 * ambigua — puede ser *"tenía cero"* o *"ese almacén no reportó ese día"*, y las
 * dos se leen igual en un LEFT JOIN. Exactamente la trampa de ADR-056.
 *
 * `stock_snapshot_coverage` desambigua: una fila por (almacén × fecha) que SÍ se
 * fotografió. Con ella, ausencia DENTRO de un almacén reportado = cero real;
 * ausencia del almacén = **no medido**, y se declara como tal.
 *
 * ── Las cadencias NO son cinco capturas ──────────────────────────────────────
 * Se captura **una vez al día**. Semana, mes, trimestre y año son *la foto diaria
 * que cae en el último día del periodo*, marcada con su bandera. Capturarlas por
 * separado abriría la puerta a que el cierre de mes no coincida con el diario del
 * día 31 — dos cifras oficiales del mismo hecho, que es el problema que la Fase VP
 * existe para cerrar.
 *
 * Las banderas se derivan de `fecha_corte` y se **materializan** para poder purgar
 * el diario viejo conservando los cierres (ver `retencion` abajo).
 *
 * ── El cierre se registra en el primitivo que YA existe ──────────────────────
 * El total mensual además se congela en `analytics.period_close`
 * (`superficie = 'inventario'`), que VP.4.1 ya construyó y VP.4.3 ya vigila con su
 * comparador de deriva. **No se inventa un segundo lugar para "la cifra oficial"**
 * — ADR-056: un primitivo que ya existe se consume, no se copia.
 *
 * ── Retención (declarada, no implementada acá) ───────────────────────────────
 * El barrido lo hará el propio servicio cuando la tabla lo pida: diario > 400 días
 * se purga salvo que tenga bandera de cierre. Hoy no se purga nada — con 0 filas
 * sería código muerto, y se declara en el tracker en vez de escribirse a ciegas.
 *
 * Patrón `analytics.*`: **sin RLS**, `tenant_id` explícito en cada query
 * (mismo criterio que `demand_acceleration` y `replenishment_plan`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('stock_snapshots'))) {
    await knex.raw(`
      CREATE TABLE analytics.stock_snapshots (
        tenant_id        uuid        NOT NULL,
        warehouse_id     uuid        NOT NULL,
        product_id       uuid        NOT NULL,
        fecha_corte      date        NOT NULL,
        -- Cantidad tal como la guarda commercial.stock: en la unidad del ERP que manda en
        -- ESE almacén. ⚠️ NO es conmensurable entre Kepler y Wincaja sin el divisor de
        -- ADR-055 (v_warehouse_box_factor). Se guarda cruda a propósito: convertir al
        -- fotografiar congelaría un factor que puede corregirse después.
        unidades         numeric(18,4) NOT NULL,
        reservadas       numeric(18,4) NOT NULL DEFAULT 0,
        disponibles      numeric(18,4) NOT NULL,
        -- Valorizado al costo del día. NULL = no se pudo costear, NUNCA 0 (ADR-056):
        -- un cero acá se sumaría al inventario total como si el producto no valiera nada.
        costo_unitario   numeric(18,6),
        valor            numeric(18,4),
        costo_fuente     text,
        -- Banderas de cierre, derivadas de fecha_corte. Materializadas para poder purgar
        -- el diario viejo sin perder los cierres.
        cierre_semana    boolean     NOT NULL DEFAULT false,
        cierre_mes       boolean     NOT NULL DEFAULT false,
        cierre_trimestre boolean     NOT NULL DEFAULT false,
        cierre_anio      boolean     NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, warehouse_id, product_id, fecha_corte)
      )`);
    // El acceso natural es "la serie de ESTE producto en ESTE almacén" (contar días con
    // existencia para el descarte del §5) — por eso producto+almacén antes que fecha.
    await knex.raw(`CREATE INDEX ix_stocksnap_serie ON analytics.stock_snapshots (tenant_id, product_id, warehouse_id, fecha_corte DESC)`);
    // Parcial: los cierres son ~3% de las filas y son los que se consultan por periodo.
    await knex.raw(`CREATE INDEX ix_stocksnap_cierre_mes ON analytics.stock_snapshots (tenant_id, fecha_corte) WHERE cierre_mes`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.stock_snapshots TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.stock_snapshots IS 'AB.0b — foto diaria de existencia (sólo saldo <> 0). Ausencia = cero SÓLO si su almacén figura en stock_snapshot_coverage; si no, es NO MEDIDO.'`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('stock_snapshot_coverage'))) {
    await knex.raw(`
      CREATE TABLE analytics.stock_snapshot_coverage (
        tenant_id        uuid        NOT NULL,
        warehouse_id     uuid        NOT NULL,
        fecha_corte      date        NOT NULL,
        pares            integer     NOT NULL,          -- pares con saldo <> 0 guardados
        pares_en_cero    integer     NOT NULL,          -- los que NO se guardaron, contados
        unidades_total   numeric(18,4),
        valor_total      numeric(18,4),                 -- NULL si no se pudo costear todo
        pares_sin_costo  integer     NOT NULL DEFAULT 0,-- se DECLARA cuánto del total no tiene costo
        cierre_semana    boolean     NOT NULL DEFAULT false,
        cierre_mes       boolean     NOT NULL DEFAULT false,
        cierre_trimestre boolean     NOT NULL DEFAULT false,
        cierre_anio      boolean     NOT NULL DEFAULT false,
        duration_ms      integer,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, warehouse_id, fecha_corte)
      )`);
    await knex.raw(`CREATE INDEX ix_stocksnapcov_fecha ON analytics.stock_snapshot_coverage (tenant_id, fecha_corte DESC)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.stock_snapshot_coverage TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.stock_snapshot_coverage IS 'AB.0b — qué almacén se fotografió qué día. Es lo que distingue "tenía cero" de "no se midió".'`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.stock_snapshots`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.stock_snapshot_coverage`);
};
