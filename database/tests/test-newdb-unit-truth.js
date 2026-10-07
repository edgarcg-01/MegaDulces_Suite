/* eslint-disable no-console */
/**
 * U.4 — CANDADO de `analytics.v_unit_truth`, el resolvedor de unidad con veredicto.
 *
 * Qué vigila, y por qué cada cosa:
 *
 *  1. ⭐ QUE NO CONTRADIGA AL DIVISOR QUE YA SE PUBLICA. `box_factor` tiene que ser exactamente
 *     el de `v_warehouse_box_factor`, fila por fila. Esta vista EXPLICA el número, no lo cambia.
 *     Es lo que autoriza a migrarle los 44 consumidores sin revalidar cada pantalla.
 *  2. ⭐ QUE NO PASE EN VACÍO. Una vista que no encuentra ninguna disputa se lee igual que una
 *     que no tiene nada que encontrar. Las poblaciones se afirman contra lo medido en prod
 *     el 2026-09-05.
 *  3. ⭐ ANTI-REGRESIÓN del agujero del factor 1: `no_aplica` no puede aplicarse a una celda
 *     cuyo testigo dice que SÍ hay caja. Eran 13 SKUs / $5.1M de granel archivados como
 *     "nada que verificar", entre ellos `20555`, el SKU que destapó la auditoría de peldaño.
 *  4. QUE `medible` NO SE DESINCRONICE del veredicto. Antes eran dos predicados duplicados.
 *  5. QUE LOS DOS EJES NO SE MEZCLEN. El testigo va contra `base_per_box` (unidades base por
 *     caja), NUNCA contra `box_factor` (el divisor nativo del almacén). Confundirlos marcaba
 *     16,897 celdas de Wincaja como falsos positivos: los multipack legítimos de ADR-055.
 *  6. QUE EL TESTIGO SEA INDEPENDIENTE. Si `v_unit_truth` leyera la etiquetera para juzgar a la
 *     etiquetera, el 99.84% de concordancia sería circular y no probaría nada.
 *  7. TAXONOMÍA CERRADA: un veredicto que nadie declaró acá rompe el test a propósito.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-unit-truth.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const NUM = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const MONEY = (n) => '$' + NUM(n);
const PCT = (a, b) => (b ? (100 * Number(a) / Number(b)).toFixed(2) : '0.00') + '%';

const VEREDICTOS = ['verificado', 'no_aplica', 'sin_testigo', 'en_disputa', 'disputa_granel'];
const NATIVOS = ['nativo_es_base', 'vende_la_base', 'vende_paquete', 'no_explicado', 'sin_razon'];
const METODOS = ['dinero', 'peso', 'divisor', 'unidad_es_caja', 'sin_metodo'];

(async () => {
  console.log('\n=== VERDAD DE UNIDAD (v_unit_truth) ===\n');
  const c = new Client({
    connectionString: URL,
    ssl: URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  // ── 0. Es VISTA (derivar-no-copiar) y filtra por la RLS del invocador.
  const v = (await c.query(
    `SELECT count(*)::int n FROM pg_views
      WHERE schemaname = 'analytics' AND viewname = 'v_unit_truth'`,
  )).rows[0];
  check('v_unit_truth existe y es VISTA', v.n === 1);

  const si = (await c.query(
    `SELECT c.reloptions::text AS opts FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_unit_truth'`,
  )).rows[0];
  check('tiene security_invoker (la RLS del que consulta filtra el tenant)',
    (si?.opts || '').includes('security_invoker=true'), si?.opts || 'sin reloptions');

  // ── 1. ⭐ NO CONTRADICE AL DIVISOR VIGENTE. Es el candado que habilita la migración.
  const eq = (await c.query(
    `SELECT count(*)::int pares,
            count(*) FILTER (WHERE abs(t.box_factor - w.box_factor) > 0.0001)::int discrepan,
            (SELECT count(*) FROM analytics.v_warehouse_box_factor WHERE tenant_id = $1)::int en_wbf
       FROM analytics.v_unit_truth t
       JOIN analytics.v_warehouse_box_factor w
         ON w.tenant_id = t.tenant_id AND w.warehouse_id = t.warehouse_id
        AND w.product_id = t.product_id
      WHERE t.tenant_id = $1`, [T],
  )).rows[0];
  check('box_factor == el que publica v_warehouse_box_factor, fila por fila',
    eq.discrepan === 0, `${eq.discrepan} de ${eq.pares} filas discrepan`);
  check('cubre el mismo universo que v_warehouse_box_factor',
    eq.pares === eq.en_wbf, `truth=${eq.pares} wbf=${eq.en_wbf}`);

  // ── 2. ⭐ QUE NO PASE EN VACÍO. Poblaciones medidas en prod 2026-09-05.
  const t0 = Date.now();
  const pob = (await c.query(
    `SELECT veredicto, count(*)::int celdas, count(DISTINCT product_id)::int skus,
            count(*) FILTER (WHERE medible)::int medibles,
            count(*) FILTER (WHERE base_per_box <= 1
                               AND (COALESCE(testigo_pago,0) > 1.05
                                 OR COALESCE(testigo_erp,0)  > 1.05))::int uno_con_testigo
       FROM analytics.v_unit_truth WHERE tenant_id = $1 GROUP BY 1`, [T],
  )).rows;
  const ms = Date.now() - t0;
  const by = Object.fromEntries(pob.map((r) => [r.veredicto, r]));
  const n = (k) => (by[k]?.celdas ?? 0);
  console.log(`  poblaciones (${ms} ms): ${pob.map((r) => `${r.veredicto}=${r.celdas}`).join(' · ')}\n`);

  check('hay celdas VERIFICADAS por un testigo independiente', n('verificado') > 50000,
    `verificado=${n('verificado')} — si cae, el testigo dejó de llegar`);
  check('hay celdas SIN testigo (no todo el catálogo se puede probar)', n('sin_testigo') > 0);
  check('hay celdas EN DISPUTA (si da 0, el detector está pasando en vacío)',
    n('en_disputa') > 0);
  check('hay disputa de GRANEL, separada de la mecánica', n('disputa_granel') > 0);
  check('la mayoría NO está en disputa (si todo fuera anomalía, nada lo sería)',
    n('en_disputa') + n('disputa_granel') < 0.05 * (eq.pares || 1),
    `${n('en_disputa') + n('disputa_granel')} de ${eq.pares}`);

  // ── 3. ⭐ ANTI-REGRESIÓN del agujero del factor 1.
  // Medido antes del fix: 13 SKUs / $5,135,134 con base_per_box = 1 y DOS testigos coincidiendo
  // en 18 / 12 / 5 / 10 / 20 / 24 / 25 / 27 / 40, archivados como `no_aplica`.
  check('`no_aplica` NUNCA se aplica a una celda cuyo testigo ve caja',
    (by.no_aplica?.uno_con_testigo ?? 0) === 0,
    `${by.no_aplica?.uno_con_testigo} celdas — es el bug del factor 1 de 2026-09-05`);

  const uno = (await c.query(
    `SELECT count(DISTINCT product_id)::int skus, count(*)::int celdas
       FROM analytics.v_unit_truth
      WHERE tenant_id = $1 AND base_per_box <= 1
        AND (COALESCE(testigo_pago,0) > 1.05 OR COALESCE(testigo_erp,0) > 1.05)`, [T],
  )).rows[0];
  check('los SKUs que declaran "sin caja" contra el testigo SIGUEN visibles',
    uno.skus > 0, 'si da 0, o se corrigieron o el testigo desapareció — hay que mirarlo');

  // ── 4. `medible` se DERIVA del veredicto, no lo duplica.
  const md = (await c.query(
    `SELECT count(*) FILTER (WHERE medible <> (veredicto IN ('verificado','no_aplica')))::int desync,
            count(*) FILTER (WHERE medible AND veredicto IN ('en_disputa','disputa_granel','sin_testigo'))::int fugas
       FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('`medible` coincide con el veredicto en el 100% de las filas', md.desync === 0,
    `${md.desync} filas desincronizadas`);
  check('ninguna celda en disputa o sin testigo se declara medible', md.fugas === 0);

  // ── 5. ⭐ LOS DOS EJES NO SE MEZCLAN. El testigo juzga base_per_box, no el divisor nativo.
  // Sin esto, los 1,085 multipack legítimos de Wincaja (ADR-055) saldrían marcados.
  const mp = (await c.query(
    `SELECT count(*)::int multipack,
            count(*) FILTER (WHERE veredicto IN ('en_disputa','disputa_granel'))::int marcados
       FROM analytics.v_unit_truth
      WHERE tenant_id = $1 AND veredicto_nativo = 'vende_paquete'`, [T],
  )).rows[0];
  check('los multipack de Wincaja existen y NO se marcan por vender en paquete',
    mp.multipack > 500 && mp.marcados === 0,
    `multipack=${mp.multipack} marcados=${mp.marcados}`);

  const nat = (await c.query(
    `SELECT veredicto_nativo, count(*)::int celdas
       FROM analytics.v_unit_truth WHERE tenant_id = $1 GROUP BY 1`, [T],
  )).rows;
  const byN = Object.fromEntries(nat.map((r) => [r.veredicto_nativo, r.celdas]));
  check('ADR-055 se sostiene: el nativo se explica por la escalera en > 99% de Wincaja',
    (byN.vende_la_base + byN.vende_paquete)
      / ((byN.vende_la_base + byN.vende_paquete + (byN.no_explicado || 0)) || 1) > 0.99,
    JSON.stringify(byN));
  check('quedan celdas `no_explicado` a la vista (el defecto vivo de ADR-055, 45 SKUs)',
    (byN.no_explicado || 0) > 0);

  // ── 5bis. ⭐⭐ EL PELDAÑO COBRADO CONTRA EL FACTOR DE CAJA — SÓLO EN UNA DIRECCIÓN.
  //
  // ⛔ PRIMERO EL ERROR QUE ESTE BLOQUE NO COMETE, porque casi se comete (revisión KX,
  // 2026-09-09): `kdm2.c58` (en qué unidad se vendió ESE renglón) **no es testigo de
  // `box_factor`** (cuántas bases hay en una caja). Son los DOS EJES del bloque 5. Medido: la
  // mediana de c58_max / box_factor es **0.0667 = 1/15**, y en 15,587 de 19,787 pares el peldaño
  // es menor — no porque el factor esté mal, sino porque **el mostrador vende piezas**. Usar eso
  // como veredicto marcaría 15,587 pares sanos, que es exactamente el falso positivo de ADR-055.
  //
  // ⭐ PERO UNA DIRECCIÓN SÍ ES IMPOSIBLE: que el ERP venda una unidad MAYOR que la caja que
  // declaramos. Si box_factor dice 1 (o sea "este producto no viene en caja") y el ticket vendió
  // peldaños de 12, 18, 20 o 24, el factor está mal por debajo y no hay lectura benigna.
  //
  // Medido en prod (90 d, U-D 8/10/12): **41 pares / $1,395,458**, con un patrón nítido:
  //   · **36 de 41 tienen box_factor = 1**, el valor que significa "no hay caja";
  //   · **35 de 41 vienen de override**, el factor MANUAL, con razón mediana **12.00x**;
  //   · y los nombres traen el número: GOMA A GRANEL LA ROSA 12KG con c58 12 · LA ROSA
  //     CONFICHOCKY GRANEL 9KG con 18 · CAR SURTIDO 18KG COLOMBINA con 18 · ALMENDRA CONFITADA
  //     10 KG con 24 · PASTA B. GUSTINOS 20KG con 20. Es granel por kilo y alguien puso 1.
  //
  // ⭐⭐ Y el override vuelve a ser la PEOR fuente, por dos órdenes de magnitud. ADR-057 ya lo
  // decía contra el testigo de PAGO; acá lo confirma, independiente, el peldaño COBRADO:
  //     override .... 1,199 pares · $13,526,866 · contradicho en 2.92%
  //     default ..... 1,161 pares ·  $6,853,643 · contradicho en 0.17%
  //     kepler_c84 .. 7,246 pares · $64,907,048 · contradicho en 0.03%
  //     etiquetera .. 9,964 pares · $43,284,758 · contradicho en 0.02%
  //     factor_sale ..  217 pares ·  $2,707,930 · contradicho en 0.00%
  console.log('\n── 5bis. ⭐⭐ El peldaño cobrado contra el factor de caja (una sola dirección) ──');
  const t58 = Date.now();
  await c.query(`CREATE TEMP TABLE _c58 AS
    SELECT d.sucursal, btrim(d.c8) sku,
           max(NULLIF(btrim(d.c58::text), '')::numeric) c58_max,
           sum(d.c13::numeric) importe
      FROM kepler_ods.kdm2 d
      JOIN kepler_ods.kdm1 h ON h.sucursal = d.sucursal AND h.c2 = d.c2 AND h.c3 = d.c3
                            AND h.c4 = d.c4 AND h.c6 = d.c6
     WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.c4::text) IN ('8','10','12')
       AND h.c9 >= current_date - 90
       AND d.sucursal = btrim(d.c1)
       AND NULLIF(btrim(d.c58::text), '')::numeric > 0
     GROUP BY 1, 2`);
  const imp = (await c.query(
    `WITH j AS (
       SELECT x.c58_max, x.importe, u.box_factor, u.factor_source
         FROM _c58 x
         JOIN commercial.warehouses w ON w.kepler_code = x.sucursal AND w.deleted_at IS NULL
         JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = x.sku
                                AND p.deleted_at IS NULL
         JOIN analytics.v_unit_truth u ON u.tenant_id = w.tenant_id
                                      AND u.warehouse_id = w.id AND u.product_id = p.id
        WHERE u.box_factor > 0)
     SELECT count(*)::int pares,
            count(*) FILTER (WHERE c58_max > box_factor * 1.02)::int imposibles,
            coalesce(sum(importe) FILTER (WHERE c58_max > box_factor * 1.02), 0)::numeric imp,
            count(*) FILTER (WHERE c58_max > box_factor * 1.02 AND box_factor = 1)::int bf1,
            count(*) FILTER (WHERE c58_max > box_factor * 1.02
                             AND factor_source = 'override')::int ovr,
            count(*) FILTER (WHERE factor_source = 'override')::int ovr_tot,
            count(*) FILTER (WHERE factor_source = 'etiquetera')::int etq_tot,
            count(*) FILTER (WHERE c58_max > box_factor * 1.02
                             AND factor_source = 'etiquetera')::int etq_mal
       FROM j`)).rows[0];
  console.log(`     ${NUM(imp.pares)} pares comparables · ${NUM(imp.imposibles)} contradichos = ${MONEY(imp.imp)}`
    + ` · con box_factor=1: ${NUM(imp.bf1)} · de override: ${NUM(imp.ovr)}`);

  // ⭐⭐ KX.4 — EL GUARD YA APLICÓ, y el techo baja de 80 a 10 porque el caso grande se cerró
  // POR CONSTRUCCIÓN, no a mano. Edgar: *"nada de corregir desde ui... un 100% de que lo que
  // decimos es real"*. La regla nueva vive en `v_product_box_factor` (mig 20260910120000): un
  // override de **1** no puede tapar un factor del ERP > 1, porque un `1` escrito a mano no es
  // una afirmación — significa lo mismo que el `default` y borra evidencia.
  //
  //     contradicciones .... 41 -> 8      ($1,395,458 -> $370,806)
  //     de override ........ 35 -> 2
  //     overrides tumbados . 13, y los 13 recuperaron el factor del ERP
  //     overrides intactos . 265 de 278 (los que valen > 1 son afirmaciones, no se tocan)
  //
  // ⚠️ Y ACÁ ESTÁ EL LÍMITE HONESTO DEL 100%, que no es pereza: **un peldáño vendido mayor que
  // la caja NO prueba que la caja esté mal.** Prueba que existe una presentación mayor. Si la
  // caja trae 6 y el ERP vendió un paquete de 12, `bf = 6` puede ser correcto. La contradicción
  // es inequívoca **sólo cuando `box_factor = 1`** — "no viene en caja" contra "vendí bultos de
  // 20" no admite lectura benigna. De los 8 que quedan: **2 son inequívocos** (`default`, bf=1,
  // $190,737) y **6 son ambiguos** (bf entre 6 y 20 con un peldáño mayor). Los 2 inequívocos
  // necesitan el peldáño PERSISTIDO para cerrarse, y hoy no existe: `sales_daily.rung_factor`
  // dice **1.0000 en los 8** (el fact lo deduce por PRECIO y no lo ve), así que hace falta
  // materializar `c58` — medido: 29.5 s de agregación, no va dentro de una vista caliente.
  check('⛔ la contradicción imposible EXISTE y se cuenta (c58 > box_factor)',
    imp.imposibles > 0,
    `${NUM(imp.imposibles)} — si da 0, o se corrigió el dato maestro o dejó de medirse`);
  check('⭐⭐ el guard de KX.4 mordió: quedan ≤ 10 contradicciones (eran 41)',
    imp.imposibles <= 10, `${NUM(imp.imposibles)} pares / ${MONEY(imp.imp)}`);
  check('⭐⭐ y el override ya NO es la fuente dominante del error (≤ 3, eran 35)',
    imp.ovr <= 3, `${NUM(imp.ovr)} de override sobre ${NUM(imp.imposibles)} contradicciones`);

  // ⭐⭐⭐ KX.5 — LO INEQUÍVOCO TIENE QUE DAR **CERO**, y por construcción.
  //
  // De las 8 que dejó KX.4, **2 eran inequívocas**: `box_factor = 1` —o sea *"este producto no
  // viene en caja"*— contra un ERP que vendió bultos de **20**. Eso no admite lectura benigna, y
  // los otros 6 sí (una caja de 6 y un paquete de 12 conviven).
  //
  // No se podían cerrar con lo que había: la cadena entera da 1 (son `default`),
  // `sales_daily.rung_factor` dice **1.0000 en los 8** porque el fact deduce el peldaño por
  // PRECIO, y agregar `kdm2` dentro de una vista caliente cuesta **38 s**. Se materializó:
  // `analytics.mv_kepler_sold_rung` (mig 20260910130000, batch 364) — 20,560 pares
  // sucursal×SKU, 4,249 con peldaño > 1 — y `v_warehouse_box_factor` la usa como **piso sólo
  // cuando el factor publicado es 1**. Aplicó a **2 filas**, exactamente las 2 declaradas:
  // `ALTOS ROLLO ALTA 20X30 1KG` (alm 06) y `REYMA ROLLO ALTA 15X25 1KG` (alm 03), las dos 1 -> 20.
  //
  // Este check es el que hace verdadera la frase "100% de lo que decimos es real" en la parte
  // que SÍ se puede probar: **cero contradicciones inequívocas publicadas**. Lo ambiguo sigue
  // contado arriba y declarado, no escondido.
  const ineq = (await c.query(
    `SELECT count(*)::int n, coalesce(sum(x.importe), 0)::numeric imp
       FROM _c58 x
       JOIN commercial.warehouses w ON w.kepler_code = x.sucursal AND w.deleted_at IS NULL
       JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = x.sku
                              AND p.deleted_at IS NULL
       JOIN analytics.v_unit_truth u ON u.tenant_id = w.tenant_id
                                    AND u.warehouse_id = w.id AND u.product_id = p.id
      WHERE u.box_factor = 1 AND x.c58_max > 1.02`)).rows[0];
  console.log(`     inequívocas (box_factor = 1 contra un peldaño vendido): ${NUM(ineq.n)} = ${MONEY(ineq.imp)}`);
  check('⭐⭐⭐ CERO contradicciones INEQUÍVOCAS: ningún `box_factor = 1` sobrevive a un bulto vendido',
    ineq.n === 0,
    `${NUM(ineq.n)} filas dicen "no viene en caja" y el ERP vendió bultos — ${MONEY(ineq.imp)}`);

  // Y el piso tiene que estar APLICÁNDOSE: si deja de aparecer, o se corrigió el dato maestro o
  // la MV se quedó parada (su latido vive en CRON_JOBS como `analytics_refresh_sold_rung`).
  const piso = (await c.query(
    `SELECT count(*)::int n FROM analytics.v_warehouse_box_factor
      WHERE factor_source = 'kepler_peldano_vendido'`)).rows[0].n;
  const mv = (await c.query(
    `SELECT count(*)::int n, max(ultimo_visto)::text ult,
            count(*) FILTER (WHERE rung_max > 1)::int mayor
       FROM analytics.mv_kepler_sold_rung`)).rows[0];
  console.log(`     mv_kepler_sold_rung: ${NUM(mv.n)} pares (${NUM(mv.mayor)} con peldaño > 1)`
    + ` · última venta vista ${mv.ult} · el piso aplica en ${NUM(piso)} filas`);
  check('⛔ la MV del peldaño está poblada y trae peldaños > 1',
    mv.n > 1000 && mv.mayor > 100, `${NUM(mv.n)} pares, ${NUM(mv.mayor)} con peldaño > 1`);
  check('⚠️ el piso NO se desbordó (2 filas medidas; techo 400 — si crece, revisar el eje)',
    piso <= 400, `${NUM(piso)} filas con el peldaño como factor`);
  console.log(`     (${((Date.now() - t58) / 1000).toFixed(1)}s)`);

  // ── 5ter. ⚠️ EL NULL MUDO DE WINCAJA en el peldaño. `sales_daily.rung_factor` va NULL en el
  // 100% de las celdas de Wincaja — legítimo, porque Wincaja no declara peldaño — pero
  // `units_unresolved`, la columna que existe para DECLARARLO, está en cero. Son 353,595 celdas
  // y $86,189,728: el 55% del ingreso de 90 días sin nada que diga "acá no se midió" (ADR-056).
  //
  // ⚠️ Y una mala atribución propia que este bloque existe para no repetir: partir el fact por
  // `w.kepler_code IS NOT NULL` da "Kepler sin peldaño en el 73% de la suc 06". **Es falso** —
  // las sucursales 01 y 06 tienen los DOS ERPs sobre el mismo almacén, así que el ERP se
  // distingue por CANAL, no por el código del almacén. Kepler puro: 533 de 361,051 (0.15%).
  console.log('\n── 5ter. ⚠️ El NULL mudo de Wincaja en el peldaño ──');
  const mudo = (await c.query(
    `SELECT count(*) FILTER (WHERE ch = 'KEPLER')::int kep,
            count(*) FILTER (WHERE ch = 'KEPLER' AND rf IS NULL)::int kep_null,
            count(*) FILTER (WHERE ch = 'WINCAJA')::int win,
            count(*) FILTER (WHERE ch = 'WINCAJA' AND rf IS NULL)::int win_null,
            coalesce(sum(rev) FILTER (WHERE ch = 'WINCAJA' AND rf IS NULL), 0)::numeric win_rev,
            count(*) FILTER (WHERE rf IS NULL AND COALESCE(unres, 0) > 0)::int declaradas
       FROM (SELECT CASE WHEN channel IN ('tienda','mostrador','credito','ruta','mayoreo')
                         THEN 'KEPLER' ELSE 'WINCAJA' END ch,
                    rung_factor rf, revenue rev, units_unresolved unres
               FROM analytics.sales_daily
              WHERE tenant_id = $1 AND sale_date >= current_date - 90) t`, [T],
  )).rows[0];
  console.log(`     KEPLER : ${NUM(mudo.kep_null)} de ${NUM(mudo.kep)} sin peldaño (${PCT(mudo.kep_null, mudo.kep)})`);
  console.log(`     WINCAJA: ${NUM(mudo.win_null)} de ${NUM(mudo.win)} (${PCT(mudo.win_null, mudo.win)}) = ${MONEY(mudo.win_rev)}`
    + ` · declaradas en units_unresolved: ${NUM(mudo.declaradas)}`);
  check('⭐ KEPLER sí resuelve el peldaño (≥ 99% de sus celdas)',
    (100 * mudo.kep_null / (mudo.kep || 1)) <= 1,
    `${PCT(mudo.kep_null, mudo.kep)} sin peldaño`);
  // ⭐⭐ R.2 (2026-09-11) — EL HUECO SE CERRO, Y LA ASERCION SE DA VUELTA. Era un NULL mudo sobre
  // 353,595 celdas / $86,189,728 y resulto que el divisor SIEMPRE se supo: la proyeccion de
  // Wincaja (sales-daily-projection.js:65) ya multiplicaba por factor_venta cuando la unidad es
  // CJA, y el importer no escribia esa columna. Tercera vez que el mismo defecto aparece -- el
  // divisor se calcula y se tira.
  //
  // Medido: el divisor es 1 en el 99.69% de las celdas y factor_venta en el 0.31% (solo uv='CJA'),
  // y ESO ES CORRECTO por ADR-055 -- Wincaja guarda en SU unidad de venta, asi que un factor_venta
  // sobre un articulo 'PZA' es divisor de DISPLAY, no de conversion (15,177 articulos PZA con
  // factor_venta mediana 16, y ninguno se multiplica).
  check('⭐⭐ WINCAJA ya declara su peldaño — el NULL dejó de ser mudo (R.2)',
    (100 * mudo.win_null / (mudo.win || 1)) <= 5,
    `${NUM(mudo.win_null)} de ${NUM(mudo.win)} celdas siguen sin peldaño (${PCT(mudo.win_null, mudo.win)})`);
  // ⛔ Y lo que queda NULL tiene que estar EXPLICADO, no simplemente ausente: o peldaños mezclados
  // en el grupo, o unidades que no se pudieron resolver. Un NULL sin ninguna de las dos es el
  // mismo defecto de antes con menos filas.
  const winNullSinExplicar = (await c.query(
    `SELECT count(*)::int n FROM analytics.sales_daily
      WHERE tenant_id = $1 AND sale_date >= current_date - 90 AND channel LIKE 'wincaja_%'
        AND rung_factor IS NULL AND COALESCE(rung_mixed, false) = false
        AND COALESCE(units_unresolved, 0) = 0`, [T])).rows[0].n;
  check('⛔ ningún NULL de Wincaja queda SIN EXPLICAR (ni mezclado ni declarado sin resolver)',
    winNullSinExplicar === 0, `${NUM(winNullSinExplicar)} celdas NULL sin motivo`);

  // ── 6. ⭐ EL TESTIGO ES INDEPENDIENTE, verificado sobre la DEFINICIÓN.
  // Si la vista leyera la etiquetera para juzgar a la etiquetera, la concordancia sería circular.
  const def = (await c.query(
    `SELECT pg_get_viewdef('analytics.v_unit_truth'::regclass, true) AS d`,
  )).rows[0].d;
  check('el testigo sale de v_supplier_cost_ladder (lo PAGADO al proveedor)',
    def.includes('v_supplier_cost_ladder'));
  check('NO lee product_label_prices directo (juzgar la etiquetera con la etiquetera es circular)',
    !def.includes('product_label_prices'));
  check('NO lee catalog.products.factor_sale directo (la fuente sin unidad)',
    !def.includes('factor_sale'));

  // ── 7. TAXONOMÍA CERRADA.
  const tax = (await c.query(
    `SELECT array_agg(DISTINCT veredicto) v, array_agg(DISTINCT veredicto_nativo) vn
       FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('todo `veredicto` está en la taxonomía declarada',
    (tax.v || []).every((x) => VEREDICTOS.includes(x)), (tax.v || []).join(','));
  check('todo `veredicto_nativo` está en la taxonomía declarada',
    (tax.vn || []).every((x) => NATIVOS.includes(x)), (tax.vn || []).join(','));

  // ── 8. La cobertura se PUBLICA, no se asume. Medido: 93.1% de la venta 365d verificada.
  const cob = (await c.query(
    `WITH s AS (SELECT product_id, sum(revenue)::numeric rev FROM analytics.sales_daily
                 WHERE tenant_id = $1 AND sale_date >= current_date - 365 GROUP BY 1),
     u AS (SELECT DISTINCT product_id, medible FROM analytics.v_unit_truth WHERE tenant_id = $1)
     SELECT round(100 * sum(s.rev) FILTER (WHERE u.medible) / NULLIF(sum(s.rev),0), 1) pct_medible,
            round(sum(s.rev) FILTER (WHERE NOT COALESCE(u.medible, true)))::numeric venta_no_medible
       FROM s LEFT JOIN u ON u.product_id = s.product_id`, [T],
  )).rows[0];
  console.log(`\n  cobertura por PRODUCTO: ${cob.pct_medible}% de la venta 365d es medible · `
    + `$${Number(cob.venta_no_medible).toLocaleString('es-MX')} no lo es`);
  check('la cobertura medible supera el 85% de la venta', Number(cob.pct_medible) > 85,
    `${cob.pct_medible}%`);
  check('queda venta NO medible declarada (si diera 0, nadie estaría mirando)',
    Number(cob.venta_no_medible) > 0);

  // ── 8bis. ⭐ EL EJE QUE SE ESCAPÓ. La medición de arriba agrupa por PRODUCTO y por eso decía
  // 98.2% mientras 13 almacenes con el 9.4% de la venta no tenían NINGUNA fila en el resolvedor.
  // Una fila ausente llega como NULL a un LEFT JOIN y un COALESCE(medible, true) la cuenta como
  // medible: el hueco se lee igual que la salud. Esto vigila el eje ALMACÉN, contra la vista que
  // lo declara.
  const cov = (await c.query(
    `SELECT count(*)::int almacenes,
            count(*) FILTER (WHERE cubierto)::int cubiertos,
            count(*) FILTER (WHERE NOT cubierto AND venta_365d > 0)::int sin_cubrir_con_venta,
            round(100 * sum(venta_365d) FILTER (WHERE cubierto)
                      / NULLIF(sum(venta_365d), 0), 1) pct_venta_cubierta,
            round(sum(venta_365d) FILTER (WHERE NOT cubierto))::numeric venta_sin_cubrir,
            count(*) FILTER (WHERE NOT cubierto AND motivo = 'sin_mapeo_erp'
                               AND venta_365d > 0)::int sin_explicacion
       FROM analytics.v_unit_truth_coverage WHERE tenant_id = $1`, [T],
  )).rows[0];
  console.log(`  cobertura por ALMACÉN: ${cov.pct_venta_cubierta}% de la venta · `
    + `${cov.sin_cubrir_con_venta} almacenes vivos sin divisor `
    + `($${Number(cov.venta_sin_cubrir || 0).toLocaleString('es-MX')})`);

  check('existe la vista de cobertura y no viene vacía', cov.almacenes > 0);
  check('la venta con divisor resuelto supera el 90% (eje almacén, no producto)',
    Number(cov.pct_venta_cubierta) > 90, `${cov.pct_venta_cubierta}%`);
  check('TODO almacén vivo sin divisor tiene un motivo declarado (ninguno queda "sin_mapeo_erp")',
    cov.sin_explicacion === 0,
    `${cov.sin_explicacion} almacenes con venta y sin explicación — hay que investigarlos`);
  check('los almacenes sin cubrir SIGUEN visibles (si dieran 0, o se cerró el hueco o se ocultó)',
    cov.sin_cubrir_con_venta > 0,
    'si de verdad se cerró, actualizar este candado y la cifra del header');

  // El fix del motivo: mezclarlo con el cambio de ERP marcaba 5 sucursales Kepler cubiertas
  // ($300.6M) como "ERP mixto". La cobertura va primero; el cambio de ERP viaja aparte.
  const mot = (await c.query(
    `SELECT count(*) FILTER (WHERE cubierto AND motivo = 'erp_mixto_por_fecha')::int mal_etiquetados,
            count(*) FILTER (WHERE cambio_de_erp)::int con_cambio_de_erp
       FROM analytics.v_unit_truth_coverage WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('ningún almacén CUBIERTO se etiqueta como "erp_mixto_por_fecha"',
    mot.mal_etiquetados === 0, `${mot.mal_etiquetados} mal etiquetados — es el bug del 2026-09-07`);
  check('el cambio de ERP se conserva como dato aparte, no se pierde',
    mot.con_cambio_de_erp > 0);

  // ── 8ter. ⭐ EL MÉTODO DE CAJAS: ordena los testigos en vez de elegir uno.
  // El divisor solo no alcanza: en 296 SKUs ($78.3M) NINGÚN divisor acierta contra el árbitro de
  // dinero, porque `units` mezcla peldaños. Pero el divisor verificado SÍ coincide con el dinero
  // donde dice estarlo (razón mediana 0.997 sobre $547M). Por eso hay orden: dinero > peso >
  // divisor verificado > declarar NULL.
  const met = (await c.query(
    `WITH s AS (SELECT product_id, warehouse_id, sum(revenue)::numeric rev
                  FROM analytics.sales_daily
                 WHERE tenant_id = $1 AND sale_date >= current_date - 365 GROUP BY 1,2)
     SELECT round(100 * sum(s.rev) FILTER (WHERE t.metodo_cajas IN ('dinero','divisor','peso'))
                      / NULLIF(sum(s.rev), 0), 1) pct_convertible,
            round(sum(s.rev) FILTER (WHERE t.metodo_cajas = 'sin_metodo'))::numeric venta_sin_metodo,
            count(*) FILTER (WHERE t.metodo_cajas = 'divisor' AND NOT t.medible)::int divisor_no_medible,
            count(*) FILTER (WHERE t.metodo_cajas = 'dinero' AND COALESCE(t.cja_price,0) <= 0)::int dinero_sin_precio
       FROM s LEFT JOIN analytics.v_unit_truth t
              ON t.tenant_id = $1 AND t.warehouse_id = s.warehouse_id
             AND t.product_id = s.product_id`, [T],
  )).rows[0];
  console.log(`  método de cajas: ${met.pct_convertible}% de la venta convertible · `
    + `$${Number(met.venta_sin_metodo || 0).toLocaleString('es-MX')} sin método (declarado)`);

  check('más del 85% de la venta tiene un método de cajas defendible',
    Number(met.pct_convertible) > 85, `${met.pct_convertible}%`);
  check('el método `divisor` NUNCA se usa con un factor no verificado',
    met.divisor_no_medible === 0,
    `${met.divisor_no_medible} celdas usarían un divisor sin testigo`);
  check('el método `dinero` NUNCA se elige sin precio de caja', met.dinero_sin_precio === 0);
  check('queda venta SIN método, declarada (si diera 0, se estaría dibujando lo que no se sabe)',
    Number(met.venta_sin_metodo) > 0);

  // ⭐ ANTI-REGRESIÓN de `unidad_es_caja`. Tratar "no hay factor de caja" como "no sé convertir"
  // bajaba el total del sell-out de 602,049 a 399,494 cajas (−33.6%) sobre 90 días, y el 95% de
  // esa caída eran productos cuya unidad de venta ES la más grande — verificado contra el precio
  // realizado en 240 de 278 SKUs (`57009 CUBETA 20K` a $1,453 vs p1 $1,500; `87234` unit_base CJA).
  const uec = (await c.query(
    `SELECT array_agg(DISTINCT metodo_cajas) metodos,
            count(*) FILTER (WHERE metodo_cajas = 'unidad_es_caja')::int uec,
            count(*) FILTER (WHERE metodo_cajas = 'unidad_es_caja' AND box_factor > 1)::int uec_con_divisor,
            count(*) FILTER (WHERE metodo_cajas = 'unidad_es_caja'
                               AND veredicto <> 'no_aplica')::int uec_sin_veredicto,
            -- Solo cuenta como PERDIDA si ademas no hay divisor nativo. Con box_factor > 1 la
            -- celda es una contradiccion de verdad: Wincaja declara "12 de mis unidades hacen una
            -- caja" mientras la escalera del producto dice que NO hay caja (79035, 97225 con
            -- veredicto_nativo = no_explicado). Ahi sin_metodo es la respuesta honesta.
            -- SIN BACKTICKS: este comentario vive dentro de un template literal de JS.
            count(*) FILTER (WHERE metodo_cajas = 'sin_metodo'
                               AND veredicto = 'no_aplica'
                               AND box_factor <= 1)::int no_aplica_perdido,
            count(*) FILTER (WHERE metodo_cajas = 'sin_metodo'
                               AND veredicto = 'no_aplica'
                               AND box_factor > 1)::int contradiccion_nativo
       FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('todo `metodo_cajas` está en la taxonomía declarada',
    (uec.metodos || []).every((m) => METODOS.includes(m)), (uec.metodos || []).join(','));
  check('`unidad_es_caja` existe y no pasa en vacío', uec.uec > 0);
  check('`unidad_es_caja` NUNCA se usa cuando el almacén declara un divisor nativo > 1',
    uec.uec_con_divisor === 0, `${uec.uec_con_divisor} celdas con divisor pisado`);
  check('`unidad_es_caja` sólo aplica sobre veredicto `no_aplica`', uec.uec_sin_veredicto === 0);
  check('ninguna celda `no_aplica` SIN divisor nativo cae en `sin_metodo` (bug del −33.6%)',
    uec.no_aplica_perdido === 0,
    `${uec.no_aplica_perdido} celdas volvieron a tratarse como ignorancia`);
  // Éstas SÍ tienen que caer en sin_metodo, y tienen que seguir contándose: son las celdas donde
  // Wincaja declara una caja que la escalera del producto niega (79035 factor_venta 12 contra
  // base_per_box 1). No se resuelven con software — alguien tiene que decidir cuál miente.
  check('las contradicciones nativo-vs-escalera siguen VISIBLES como sin_metodo',
    uec.contradiccion_nativo > 0,
    'si dieran 0, o se resolvieron en la fuente o se están escondiendo');

  // ── 9. Perf. Se mide, no se estima.
  check('la agregación completa cuesta < 8,000 ms', ms < 8000, `${ms} ms`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
