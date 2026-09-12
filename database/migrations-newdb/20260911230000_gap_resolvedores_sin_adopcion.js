/**
 * VA.1 — EL HUECO QUE `VERDAD_ABSOLUTA` NUNCA SE DECLARÓ A SÍ MISMO.
 *
 * Edgar, 2026-09-11, tras encontrar un `UxC = 1` donde son 58: **"tu verdad absoluta fallo"**.
 *
 * ── Dónde falló ─────────────────────────────────────────────────────────────────────────────
 *
 * NO en el dato ni en los resolvedores: el resolvedor canónico decía 58 para ese SKU desde
 * siempre. Falló el documento **como mecanismo**.
 *
 *   · §5 declara QUÉ LEER para cada número.
 *   · §7 lista los huecos **del dato**, con nombre y monto.
 *   · Cada candado verifica que **un resolvedor concuerde con su testigo**.
 *   · ⛔ **Ninguno verificaba que alguien lo LEYERA.**
 *
 * Medido el 2026-09-11 sobre publicadores (servicios y componentes, sin comentarios, sin specs
 * ni migraciones ni importers):
 *
 *     eje                    resolvedor   crudas   adopcion
 *     factor de caja              5         21        19%
 *     costo unitario              5         29        15%
 *     unidad de la celda          2          0       100%
 *     renglon de venta            0          -        CERO LECTORES
 *     existencia valuada          0          -        CERO LECTORES
 *
 * ⛔ **`v_erp_sales_line_units` y `v_erp_stock_truth` tienen CERO publicadores.** Son vistas que
 * se construyeron, se arbitraron contra su testigo y se documentaron como canónicas — y no
 * cambian ningún número que alguien vea. `v_erp_sales_line_units` es, además, la vista sobre la
 * que la Fase R hizo todo su análisis de `U-D-8` esa misma mañana.
 *
 * Es el patrón de ADR-056 un escalón más arriba: el primitivo se construyó bien, se aplicó a un
 * dominio y nunca se generalizó. La diferencia es que acá había un documento declarándolo
 * canónico, y eso **se leía como si estuviera adoptado**.
 *
 * ── ⚠️ El límite de este hueco, dicho en vez de disimulado ──────────────────────────────────
 *
 * `declared_gaps.recheck_sql` corre **SQL**, y la adopción es una propiedad del **código**: desde
 * la base no se puede ver quién importa qué. Así que el recheck mide **sólo la parte que SQL sí
 * puede ver** — si los resolvedores huérfanos ganaron dependientes dentro de la base — y el resto
 * lo vigila `database/tests/test-newdb-resolver-adoption.js`, que es un candado de código.
 *
 * Dicho de otro modo: **este hueco no caduca solo del todo.** Es una limitación real del
 * mecanismo de la Fase R, y queda escrita acá para que nadie lea el verde del recheck como si
 * significara "ya se adoptó".
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// Lo que SQL sí puede ver: si alguien colgó algo de los resolvedores huérfanos DENTRO de la base.
// La adopción desde el código la mide el candado; acá se declara que este recheck no la alcanza.
const RECHECK = `
  WITH huerfanos(v) AS (VALUES ('v_erp_sales_line_units'), ('v_erp_stock_truth')),
  dep AS (
    SELECT h.v,
           count(DISTINCT d.relname) AS dependientes
      FROM huerfanos h
      LEFT JOIN pg_class src ON src.relname = h.v
      LEFT JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'analytics'
      LEFT JOIN pg_depend pd ON pd.refobjid = src.oid
      LEFT JOIN pg_rewrite r ON r.oid = pd.objid
      LEFT JOIN pg_class d ON d.oid = r.ev_class AND d.relname <> h.v
     GROUP BY h.v)
  SELECT (sum(dependientes) = 0) AS sigue_siendo_hueco,
         'dependientes DENTRO de la base: ' ||
         string_agg(v || '=' || dependientes, ', ' ORDER BY v) ||
         '. OJO: esto NO mide adopcion desde el codigo -- eso vive en ' ||
         'database/tests/test-newdb-resolver-adoption.js, y el 2026-09-11 daba CERO ' ||
         'publicadores para los dos' AS detalle
    FROM dep`;

const GAP = {
  clave: 'resolvedores_sin_adopcion',
  titulo: 'Los resolvedores canonicos existen, y casi nadie los lee',
  monto: 15,
  unidad: '% de adopcion (peor eje: costo)',
  declarado_en: '2026-09-11',
  motivo: 'VERDAD_ABSOLUTA declara que ARBITRA cada numero pero nunca verifico que los '
    + 'publicadores LEAN el arbitro. Medido 2026-09-11 sobre codigo (sin comentarios): factor de '
    + 'caja 5 publicadores contra 21 en fuentes crudas (19%); costo 5 contra 29 (15%); y DOS '
    + 'resolvedores con CERO lectores: v_erp_sales_line_units y v_erp_stock_truth. Lo destapo un '
    + 'humano mirando UNA celda (96504 con UxC 1 donde son 58), no un candado.',
  resolver_faltante: 'cablear cada publicador al resolvedor de su eje, o declarar por escrito por '
    + 'que ese consumidor usa la fuente cruda (valuar inventario con cost_base es legitimo, '
    + 'ADR-051). Mientras tanto el trinquete de test-newdb-resolver-adoption.js impide que empeore.',
  estado: 'abierto',
  recheck_sql: RECHECK,
};

exports.up = async function up(knex) {
  // El recheck se ejercita ANTES de sembrarlo: uno roto se leeria como "todo en orden".
  const r = (await knex.raw(GAP.recheck_sql)).rows[0];
  if (!r || typeof r.sigue_siendo_hueco !== 'boolean') {
    throw new Error(`el recheck no cumple el contrato: ${JSON.stringify(r)}`);
  }
  console.log(`  [gap] ${GAP.clave}: ${r.detalle}`);

  await knex('analytics.declared_gaps')
    .insert({
      tenant_id: T,
      clave: GAP.clave,
      titulo: GAP.titulo,
      monto: GAP.monto,
      unidad: GAP.unidad,
      declarado_en: GAP.declarado_en,
      motivo: GAP.motivo,
      resolver_faltante: GAP.resolver_faltante,
      recheck_sql: GAP.recheck_sql,
      estado: GAP.estado,
      ultima_medicion: knex.fn.now(),
      ultimo_detalle: r.detalle,
    })
    .onConflict(['tenant_id', 'clave'])
    .merge(['titulo', 'monto', 'unidad', 'motivo', 'resolver_faltante', 'recheck_sql',
      'estado', 'ultima_medicion', 'ultimo_detalle']);

  const n = (await knex('analytics.declared_gaps').where({ tenant_id: T }).count('* as n'))[0].n;
  console.log(`  [gap] la tabla queda con ${n} huecos declarados`);
};

exports.down = async function down(knex) {
  await knex('analytics.declared_gaps').where({ tenant_id: T, clave: GAP.clave }).del();
};
