/* eslint-disable no-console */
/**
 * `[AUD-DAT.15]` — **Cada renglón de `commercial.reorder_policy` tiene UN dueño.**
 *
 * ── DE DÓNDE SALE ESTE CANDADO ──────────────────────────────────────────────────────────────
 * De la auditoría de la capa de datos. Su hallazgo #2 decía *"ninguna tabla maestra tiene dueño
 * único"*, y acá quedó capturado en el acto, con el log de cambios de VP.3.1 como testigo. La
 * noche del 2026-09-28, mismo registro y mismo minuto:
 *
 *     03:02:23.297   max_stock 112.000 → 92.000     (import-computed-reorder)
 *     03:02:28.511   max_stock  92.000 → 112.000    (import-network-reorder)
 *
 * Medido esa noche: `computed` cambió **9,132** filas, `network` **8,717**, y **7,197 eran las
 * mismas** — el 79 % de la segunda pasada pisaba lo que la primera había escrito cinco segundos
 * antes. El valor publicado dependía de quién corriera último.
 *
 * Y el daño no era sólo el desperdicio: `analytics.master_data_history` quedaba con **dos
 * cambios contradictorios por noche y por SKU**, o sea que la historia que la Fase VP existe para
 * poder leer se volvía ilegible justo donde más se la necesita. Ese log crece **26.5 MB/día** sin
 * política de retención (1,035,006 filas en 21 días), y `reorder_policy` es el **38.2 %**.
 *
 * ── EL REPARTO, Y POR QUÉ ES ASÍ ────────────────────────────────────────────────────────────
 * Gana `import-network-reorder` donde puede, y NO por orden de ejecución: su demanda es un
 * superconjunto (`media_red = Σ avg(hijas) + propio`, RA-PRO.6). Planear un punto de abasto con
 * su consumo de mostrador es el error que la fase DRP vino a corregir.
 *
 * ⛔ Pero el corte es por **(almacén, producto)**, no por almacén — y la diferencia son **2,801
 * filas**. El rollup DRP arma su universo desde la demanda de las HIJAS, así que un producto que
 * se mueve en el punto de abasto y en ninguna hija no existe para él. Con el filtro grueso esos
 * renglones se habrían congelado en silencio, que es exactamente
 * `[[feedback_filter_validated_on_one_branch_deletes_another]]`.
 *
 * ── QUÉ GUARDA ──────────────────────────────────────────────────────────────────────────────
 * Dos invariantes sobre los UNIVERSOS (no sobre montos, que se mueven todas las noches):
 *   1. **Disjuntos** — ningún par cae en los dos importers.
 *   2. **Completos** — ningún par con demanda se queda sin dueño.
 *
 * ⚠️ SÓLO LECTURA y contra PROD a propósito. El bloque 3 es la **prueba negativa**: rompe el
 * criterio a propósito (el filtro grueso, por almacén) y exige que el detector lo marque.
 *
 *   node database/tests/test-newdb-reorder-single-owner.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { assertTarget } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const URL = process.env.DATABASE_URL_NEW;
assertTarget('test-newdb-reorder-single-owner', { url: URL, intent: 'read', expect: 'prod' });

const knex = require('knex')({ client: 'pg', connection: { connectionString: URL }, pool: { min: 0, max: 2 } });
const MEGA = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·', 'NO MEDIDO —', m); };

/** El universo del rollup DRP: pares (punto de abasto, producto) con demanda en alguna HIJA. */
const SQL_RED = `
  SELECT DISTINCT w.source_warehouse_id AS warehouse_id, ih.product_id
    FROM commercial.warehouses w
    JOIN analytics.inventory_health ih ON ih.tenant_id = ? AND ih.warehouse_id = w.id
   WHERE w.tenant_id = ? AND w.source_warehouse_id IS NOT NULL AND w.deleted_at IS NULL
     AND ih.avg_daily_units > 0`;

/** El universo de import-computed-reorder, con el filtro por PAR que declara la cesión. */
const SQL_COMPUTED = `
  SELECT ih.warehouse_id, ih.product_id
    FROM analytics.inventory_health ih
    JOIN catalog.products p ON p.tenant_id = ? AND p.id = ih.product_id
   WHERE ih.tenant_id = ? AND ih.avg_daily_units > 0
     AND NOT EXISTS (
       SELECT 1 FROM commercial.warehouses n
         JOIN analytics.inventory_health ihc
           ON ihc.tenant_id = ? AND ihc.warehouse_id = n.id
          AND ihc.product_id = ih.product_id AND ihc.avg_daily_units > 0
        WHERE n.tenant_id = ? AND n.source_warehouse_id = ih.warehouse_id
          AND n.deleted_at IS NULL)`;

/** El universo COMPLETO: todo par con demanda que alguien tiene que planear. */
const SQL_TODO = `
  SELECT ih.warehouse_id, ih.product_id
    FROM analytics.inventory_health ih
    JOIN catalog.products p ON p.tenant_id = ? AND p.id = ih.product_id
   WHERE ih.tenant_id = ? AND ih.avg_daily_units > 0`;

/**
 * ⭐ Comparador ÚNICO: lo usan el veredicto real y la prueba negativa. Dos implementaciones
 * serían un candado que se pone verde midiendo algo distinto de lo que corre.
 */
function reparto(computed, red, todo) {
  const k = (r) => `${r.warehouse_id}|${r.product_id}`;
  const sc = new Set(computed.map(k));
  const sr = new Set(red.map(k));
  const dobles = [...sc].filter((x) => sr.has(x));
  const huerfanos = todo.map(k).filter((x) => !sc.has(x) && !sr.has(x));
  return { dobles, huerfanos };
}

(async () => {
  try {
    console.log('\n=== reorder_policy: un renglón, un dueño ===\n');
    const [computed, red, todo] = await Promise.all([
      knex.raw(SQL_COMPUTED, [MEGA, MEGA, MEGA, MEGA]).then((r) => r.rows),
      knex.raw(SQL_RED, [MEGA, MEGA]).then((r) => r.rows),
      knex.raw(SQL_TODO, [MEGA, MEGA]).then((r) => r.rows),
    ]);
    console.log(`  universo total ${todo.length} · computed ${computed.length} · red ${red.length}\n`);

    if (!todo.length) {
      noMedido('analytics.inventory_health no tiene demanda — sin universo no hay reparto que probar');
    } else {
      const { dobles, huerfanos } = reparto(computed, red, todo);

      console.log('1) Ningún par lo escriben LOS DOS importers');
      ok(dobles.length === 0, `${dobles.length} pares con dos dueños`);

      console.log('\n2) Ningún par con demanda se queda SIN dueño');
      ok(huerfanos.length === 0, `${huerfanos.length} pares sin dueño`);

      // El reparto declarado, para que el número viaje con el veredicto.
      //
      // ⚠️ La suma SUPERA al universo a propósito, y no es un descuadre: el rollup DRP planea el
      // punto de abasto para lo que necesitan sus hijas, incluso si ahí no se registró demanda
      // propia. Esos pares no están en `todo` (que se mide sobre la demanda del propio almacén)
      // y sí en `red`. Si algún día la suma fuera MENOR que el universo, eso sí sería un hueco
      // — y lo atrapa la aserción 2, no esta línea.
      const extra = computed.length + red.length - todo.length;
      console.log(`\n   reparto: ${computed.length} computed + ${red.length} red = ${computed.length + red.length}`
        + ` · universo propio ${todo.length} · ${extra} que el CEDIS surte sin demanda propia`);
    }

    // ── 3) PRUEBA NEGATIVA ───────────────────────────────────────────────────────────────────
    // El filtro que ESTUVE A PUNTO de escribir: excluir el almacén entero en vez del par. Tiene
    // que salir rojo por huérfanos — si saliera verde, este candado no distingue el arreglo
    // bueno del malo y no sirve para nada.
    console.log('\n3) Prueba negativa: el filtro GRUESO (por almacén) deja huérfanos');
    const abasto = new Set(red.map((r) => r.warehouse_id));
    const computedGrueso = todo.filter((r) => !abasto.has(r.warehouse_id));
    const malo = reparto(computedGrueso, red, todo);
    ok(malo.huerfanos.length > 0,
      `el filtro grueso deja ${malo.huerfanos.length} pares sin dueño (con el fino: 0)`);
    ok(malo.dobles.length === 0, 'el filtro grueso tampoco duplica (falla por lo otro, no por esto)');

    // Y el criterio SIN filtro —como estaba antes de [AUD-DAT.15]— tiene que salir rojo por dobles.
    const sinFiltro = reparto(todo, red, todo);
    ok(sinFiltro.dobles.length > 0,
      `sin filtro (como estaba antes) hay ${sinFiltro.dobles.length} pares con dos dueños`);

  } catch (e) {
    fail++;
    console.log('  ✗ ERROR:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nm} NO MEDIDO\n`);
    process.exit(fail ? 1 : 0);
  }
})();
