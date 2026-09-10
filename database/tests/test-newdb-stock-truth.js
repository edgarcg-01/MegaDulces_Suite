/* eslint-disable no-console */
/**
 * CANDADO — LA VERDAD DE LA EXISTENCIA DE KEPLER.
 *
 * Pedido de Edgar: *"necesitamos verdad absoluta de existencia, ventas y unidades"* ·
 * *"solo hay que enfocarnos en kepler"*.
 *
 * ── Lo que YA era verdad y este candado protege ────────────────────────────────────────────
 *
 * La CANTIDAD de la existencia de Kepler cierra sola. Medido contra prod el 2026-09-08:
 *   · la identidad `entradas - salidas = qty` cuadra en 20,681 de 22,426 (92.22%), y las 1,748
 *     restantes son EXACTAMENTE los saldos negativos que la vista recorta a cero por diseño;
 *   · `kdil.c4` (el inicial) es 0 en el 100% de las filas;
 *   · la sucursal `00` de Kepler deriva **122,096,465** unidades fantasma y ya está excluida.
 *
 * ⚠️ **Y ACÁ ESTABA EL AGUJERO DE ESTE PROPIO ARCHIVO** (revisión KX, 2026-09-09, pedido de
 * Edgar: *"no busquemos patrones en lo correcto, busquemos patrones en lo incorrecto"*). Las dos
 * frases de arriba se escribieron como si fueran el final de la historia, y **dos de los checks
 * de este archivo no podían fallar**:
 *
 *   1. `SIN EXPLICAR = 0` NO era un hallazgo: la consulta define `sin_explicar` con
 *      `AND entradas - salidas >= 0`, o sea **excluye por construcción** los negativos, que son
 *      el único residuo que existe. El cero era la definición, no la medición. Los negativos se
 *      imprimían al costado y **nadie los asertaba**: podían triplicarse en silencio. Medidos
 *      hoy: **1,817 filas y −68,513 unidades** en las siete sucursales.
 *   2. `kdil.c4 = 0 en el 100%` no dice "el baseline es cero"; dice **"esa columna no se usa"**.
 *      La prueba: **747 SKUs venden sin tener UNA sola entrada** (−14,640 u). Un saldo inicial
 *      que no existe no es lo mismo que un saldo inicial de cero.
 *
 * Y la firma de los negativos también quedó medida, para no volver a suponerla: **NO es error de
 * unidad**. Sólo 2 de 1,796 tienen la firma de caja (`salidas/bf == entradas`), la mediana de
 * `salidas/entradas` es **1.090** — no 12 ni 24 — y 729 no tienen entradas en absoluto.
 *
 * ⚠️⚠️ **Y UNA RETRACTACIÓN MÍA, EL MISMO DÍA.** En el primer pase de KX escribí que la etiqueta
 * "réplica" del filtro `sucursal = c1` estaba **refutada**, porque contra suc02/alm02 sólo el
 * 3.66% de las entradas acumuladas coincidía y **1,049 SKUs iban por delante del original**. Eso
 * era **falso, y el error fue de TESTIGO**: `kdil` es un acumulado recalculable, así que su
 * divergencia no dice nada sobre el origen de los datos. El testigo fuerte estaba disponible y no
 * lo usé — la **identidad documental**:
 *
 *     docs de suc03 con almacén 02 ............ 37,020
 *     el mismo (folio, doctype) en la suc 02 .. 37,020  = 100.00%   -> ES RÉPLICA
 *     la réplica llega a 2026-01-07; la sucursal 02 real llega a hoy  -> CONGELADA
 *
 * Y publicarla costaría caro: de 2,594 celdas con existencia, **1,771 (78,633 u) tienen el SKU ya
 * publicado desde la sucursal 02** — doble conteo. **El filtro está correcto y el "hueco" de
 * 90,630 u no existe: es doble conteo evitado.** La lección se suma a R6 y la matiza: buscar el
 * patrón en el error es lo correcto, pero **el testigo tiene que ser el más fuerte disponible**, y
 * una identidad de folios le gana a un acumulado. El bloque 3 ahora asegura la RAZÓN, no la
 * etiqueta.
 *
 * ── Lo que NO era verdad: el VALOR ⭐ ───────────────────────────────────────────────────────
 *
 * La existencia se valuaba con `catalog.products` — un costo por PRODUCTO, global, en la unidad
 * que el catálogo tenga. Kepler trae SU costo por **sucursal × SKU** (`kdik.c16`), al mismo grano
 * que la cantidad. Contrastados: `cost_base / c16` da mediana **1.0000** (pega ±2% en 72.46%),
 * mientras `cost_with_tax / c16` da **1.0800**. O sea `cost_base` ES el costo de Kepler, y el
 * dictamen publica con impuesto.
 *
 * Estado en PROD al crear este candado (filas con existencia > 0):
 *
 *     veredicto                 filas     publicado      arbitrado        brecha
 *     confirmado               11,917   $31,238,287    $28,442,898    $2,795,389   <- el IMPUESTO
 *     contradicho_por_factor      273    $2,675,506       $650,079    $2,025,427   <- el FACTOR
 *     precio_movido             4,237    $8,792,029     $7,986,439      $805,590
 *     sin_testigo                  26       $16,316           NULL            --
 *
 * Las razones de las 273 contradichas son 16.2 · 21.6 · 20.0 · 14.0 · 32.0 · 31.4 · 10.8 · 3.3
 * — factores de caja. Y los nombres cierran el caso: ROLLO GUAYABA CHICO GRANEL · CHOC HERSHEY
 * BARRA GRANEL 14KG · TURIN CONF SEMIAMARGO 16KG. `cost_base` viene por bulto; `c16` por pieza.
 *
 * ── ⭐ EL MAPA DEL ERROR, por causa nombrada (revisión KX, prod 2026-09-09, qty > 0) ─────────
 *
 *     causa                                                    filas      |brecha|
 *     1. impuesto en el costo publicado                       15,090    $4,024,239
 *     2. sin impuesto: diferencia real de costo                3,555       $87,361
 *     3. contradicho por factor (resto)                          234    $2,314,520
 *     4. catálogo con las DOS columnas en unidades distintas      101      $354,067
 *     5. sin testigo de Kepler                                    28            $0
 *
 * **La tasa de error no predice el dinero, y por eso contar filas engaña.** La suc 04 tiene la
 * peor tasa (36.02% de filas objetadas) y sólo $114,670 de brecha; la suc 06 tiene la mejor
 * (20.47%) y **$2,981,753**. Y está concentrado: **100 filas de 18,967 cargan el 47%** de la
 * brecha, 10 filas cargan el 24%.
 *
 * ── ⭐ Tres hipótesis que sonaban bien y la medición REFUTÓ (revisión KX) ────────────────────
 *
 *  a. **"lo contradicho es granel/peso"** — NO: 279 de 306 filas contradichas son
 *     `is_weight = false` y cargan $2,289,685 de los $2,680,453. El granel son 27 filas.
 *  b. **"la razón del error es el factor de caja declarado"** — NO: contra el resolvedor
 *     canónico (`v_unit_truth`), sólo **28 de 306** tienen `razon == box_factor`; en 264 la razón
 *     no coincide (mediana razón **4.18** contra un `box_factor` mediano de **40.0**). Tampoco es
 *     el `units_per_box` pagado (**0** aciertos), ni `f3` (0), ni casi `f2` (15). Y sólo el
 *     **15.03%** de las razones contradichas es casi-entera: si fuera un factor de unidad, casi
 *     todas lo serían.
 *  c. **"un `cost_base` compartido entre SKUs es la causa"** — NO, va al revés: los costos
 *     ÚNICOS se contradicen más (2.25%) que los compartidos por >20 SKUs (0.37%).
 *
 * ── ⭐⭐ Lo que sí resultó ser la causa, con la prueba ────────────────────────────────────────
 *
 *  1. **`cost_with_tax / cost_base` toma CUATRO valores discretos** — ×1.000 (1,142 SKUs),
 *     ×1.080 (2,725), ×1.160 (1,091) y **×1.240 (278)**, que es IVA 16% + IEPS 8%. O sea el
 *     recargo es coherente como concepto fiscal; el error es **valuar inventario con el costo
 *     con impuestos**, y por eso KE.2 lo cambió. Pero no es UN recargo: son cuatro.
 *  2. **En 62 SKUs las dos columnas del catálogo están en UNIDADES DISTINTAS** — y ahí
 *     `cost_with_tax` es el costo unitario correcto y `cost_base` es el bulto, o sea **al revés
 *     de lo que dicen sus nombres**. La prueba contra Kepler, en las 101 filas con existencia:
 *     `cost_with_tax / c16` pega en 60 con mediana **1.000**, y `cost_base / c16` pega en 21 con
 *     mediana **10.872**. Ejemplos: `TURIN CONF BLANCO 16KG` $5,002.56 vs $152.11 (1/32.9) ·
 *     `ROLLO GUAYABA CHICO GRANEL` $891.00 vs $55.00 (1/16.2). Son **los mismos nombres** que la
 *     doc citaba como "factor de caja" — la causa no era el factor: era que las dos columnas del
 *     mismo producto miden cosas distintas.
 *     ⚠️ Hoy no llega ninguna de esas filas al fallback del service (las 101 tienen costo de
 *     Kepler), así que la pantalla no las publica mal. Es una **bomba latente**: si Kepler dejara
 *     de traer `c16` para una, el fallback `cost_base` la valuaría **10.9× arriba**.
 *  3. **`kdik.c16` NO es "el costo de Kepler hoy": es el costo PROMEDIO PONDERADO HISTÓRICO.**
 *     Probado sin ambigüedad: `kdik.c5 == kdil.c8` (entradas acumuladas) en **25,142 de 25,142
 *     pares = 100.00%**, y `c16 = c8/c5`. O sea el árbitro divide valor acumulado entre unidades
 *     acumuladas de TODA la historia de compras. Consecuencia medida: contra `c18` (último
 *     costo) la mediana de `c16/c18` es **0.9805** — el árbitro valúa **~2% barato de forma
 *     sistemática**, y `c18` falta en el 56% de los pares. Valuar a promedio ponderado es
 *     legítimo; **publicarlo como si fuera costo de reposición no lo es**.
 *
 * ── Dos errores silenciosos que este archivo existe para que no vuelvan ─────────────────────
 *
 *  1. ⛔ **`?` en un `raw` de knex.** El primer intento guardaba el guard de `c16` como regex de
 *     texto; knex tomó cada `?` como binding y Postgres almacenó
 *     `'^-$1[0-9]+(\.[0-9]+)$2([eE][+-]$3[0-9]+)$4$'`. No falló: **no matcheó nada**, y la vista
 *     devolvió `sin_testigo` en las 16,453 filas — que se lee igual que "Kepler no tiene costo".
 *  2. ⛔ **La columna del ERP es `source = 'kepler_ods'`, no `'kepler'`** (eso es `unit_source`).
 *     Filtrar por el valor equivocado devuelve cero filas sin decir nada.
 *
 * Los dos los cazó la auto-verificación de la migración, no una pantalla. Por eso las
 * afirmaciones de acá miran CANTIDADES, no la forma del SQL.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-stock-truth.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n) => `$${N(n)}`;
const pct = (a, b) => (b ? (100 * a / b) : 0);

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '900s'");
  console.log('\n=== CANDADO · la verdad de la EXISTENCIA de Kepler ===\n');

  if (!(await c.query(`SELECT to_regclass('analytics.v_erp_stock_truth') t`)).rows[0].t) {
    nomedido('analytics.v_erp_stock_truth no existe', 'correr la migración 20260908180000');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  // ⚠️ UNA SOLA PASADA. Cada aserción que lee `v_erp_stock_truth` re-deriva `v_erp_stock_on_hand`
  // (que agrega `kdil`) y `v_kepler_unit_cost` (que agrega `kdik`). Con seis bloques eso son seis
  // derivaciones y el archivo se iba a `statement timeout` — exactamente la misma lección que el
  // candado de renglones de venta. Se materializa una vez y todos los bloques leen la temporal.
  const t0 = Date.now();
  await c.query(`CREATE TEMP TABLE st AS
    SELECT tenant_id, warehouse_id, kepler_code, product_id, sku, qty,
           costo_kepler, costo_catalogo, costo_publicado_hoy, razon, veredicto,
           factor_aparente, valor_arbitrado, valor_publicado_hoy
      FROM analytics.v_erp_stock_truth`);
  const nSt = (await c.query('SELECT count(*)::int n FROM st')).rows[0].n;
  console.log(`(materializada una vez: ${N(nSt)} filas en ${((Date.now() - t0) / 1000).toFixed(1)}s)
`);

  // ── 1. La forma ────────────────────────────────────────────────────────────────────────────
  console.log('── 1. La forma ──');
  const meta = (await c.query(
    `SELECT c.relkind, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname='v_erp_stock_truth'`)).rows[0];
  check('es VISTA, no una tabla copiada (regla ⭐ del proyecto)', meta.relkind === 'v', `relkind=${meta.relkind}`);
  check('⭐ conserva security_invoker (se pierde en cada CREATE OR REPLACE — lección U.7)',
    (meta.reloptions || []).some((o) => String(o).includes('security_invoker')));
  const gr = (await c.query(
    `SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='analytics' AND table_name='v_erp_stock_truth'
        AND grantee='app_runtime' AND privilege_type='SELECT'`)).rowCount;
  check('app_runtime puede leerla (el GRANT tampoco se hereda)', gr === 1);

  // ── 2. El testigo es de Kepler, y sólo de Kepler ───────────────────────────────────────────
  // ⚠️ NO se verifica leyendo el TEXTO del SQL. La primera versión de este bloque exigía que la
  // definición mencionara `kepler_ods.kdik`, y se puso ROJA sola en KE.2 — cuando el costo se
  // extrajo a `analytics.v_kepler_unit_cost` la vista dejó de nombrar la tabla y empezó a nombrar
  // a quien la lee. La afirmación era sobre la forma del SQL, no sobre de dónde sale el dato.
  // Ahora se pregunta al GRAFO DE DEPENDENCIAS de Postgres, que es la verdad y sobrevive a que
  // alguien meta otra vista en medio.
  console.log('\n── 2. El testigo es de Kepler, y sólo de Kepler ──');
  const deps = (await c.query(
    `WITH RECURSIVE d(oid) AS (
       SELECT 'analytics.v_erp_stock_truth'::regclass::oid
       UNION
       SELECT DISTINCT rd.refobjid
         FROM d
         JOIN pg_rewrite rw ON rw.ev_class = d.oid
         JOIN pg_depend  rd ON rd.objid = rw.oid AND rd.classid = 'pg_rewrite'::regclass
        WHERE rd.refobjid <> d.oid AND rd.refclassid = 'pg_class'::regclass)
     SELECT DISTINCT n.nspname || '.' || cl.relname AS rel
       FROM d JOIN pg_class cl ON cl.oid = d.oid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      ORDER BY 1`)).rows.map((r) => r.rel);
  console.log(`     depende de: ${deps.join(' · ')}`);
  check('⭐ el costo TRAZA hasta kepler_ods.kdik (por el grafo, no por el texto)',
    deps.includes('kepler_ods.kdik'), deps.join(','));
  check('⭐ y lo lee del primitivo único analytics.v_kepler_unit_cost',
    deps.includes('analytics.v_kepler_unit_cost'));
  // ⚠️ Y acá va una aserción que ya estuvo MAL una vez: exigía que el grafo entero no tocara
  // `wincaja.*`. Imposible y además irrelevante — la vista lee `v_erp_stock_on_hand`, que es un
  // UNION de los dos ERPs, así que Wincaja aparece por construcción; lo que separa los dos mundos
  // es el `WHERE source = 'kepler_ods'` sobre los DATOS (que el bloque de abajo comprueba
  // contando). La afirmación que sí importa es sobre EL TESTIGO: el costo tiene que salir de
  // Kepler y de nada más. Eso se pregunta al grafo de `v_kepler_unit_cost`, no al de la vista.
  const depCost = (await c.query(
    `WITH RECURSIVE d(oid) AS (
       SELECT 'analytics.v_kepler_unit_cost'::regclass::oid
       UNION
       SELECT DISTINCT rd.refobjid
         FROM d
         JOIN pg_rewrite rw ON rw.ev_class = d.oid
         JOIN pg_depend  rd ON rd.objid = rw.oid AND rd.classid = 'pg_rewrite'::regclass
        WHERE rd.refobjid <> d.oid AND rd.refclassid = 'pg_class'::regclass)
     SELECT DISTINCT n.nspname || '.' || cl.relname AS rel
       FROM d JOIN pg_class cl ON cl.oid = d.oid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      ORDER BY 1`)).rows.map((r) => r.rel);
  console.log(`     el TESTIGO depende de: ${depCost.join(' · ')}`);
  const wincDeps = depCost.filter((d) => /^wincaja\./.test(d));
  check('⛔ el TESTIGO no toca wincaja — Edgar: "solo hay que enfocarnos en kepler"',
    wincDeps.length === 0, wincDeps.join(','));
  check('⛔ ni la etiquetera ni el factor de caja entran al testigo (seria circular)',
    !depCost.some((d) => /product_label_prices|box_factor|factor_sale|product_unit_overrides/.test(d)),
    depCost.filter((d) => /label|box_factor|factor_sale|overrides/.test(d)).join(','));
  // Y el dato: la vista no puede traer ni una fila que no sea de Kepler. Se pregunta CONTANDO
  // sus almacenes, no re-derivando la vista de existencia (eso la hacia timeoutear).
  const noKep = (await c.query(
    `SELECT count(*)::int n FROM st t
       JOIN commercial.warehouses w ON w.tenant_id=t.tenant_id AND w.id=t.warehouse_id
      WHERE w.kepler_code IS NULL`)).rows[0].n;
  check('⛔ y en los datos tampoco entra Wincaja (cero filas de almacén sin kepler_code)',
    noKep === 0, `${N(noKep)} filas`);

  // ⭐ El costo que la vista publica tiene que ser el que Kepler tiene escrito. Se compara contra
  // `kdik` CRUDO — el testigo del testigo — sobre una muestra acotada.
  const trace = (await c.query(
    `WITH m AS (
       SELECT t.kepler_code, t.sku, t.costo_kepler
         FROM st t
        WHERE t.costo_kepler IS NOT NULL AND t.qty > 0
        LIMIT 400)
     SELECT count(*)::int n,
            count(*) FILTER (WHERE abs(m.costo_kepler - k.c16::numeric) <= 0.01)::int iguales
       FROM m JOIN kepler_ods.kdik k
         ON k.sucursal = m.kepler_code AND btrim(k.c2::text) = m.sku
        AND k.sucursal = btrim(k.c1::text)`)).rows[0];
  check('⭐ el costo publicado es, al centavo, el que kdik.c16 tiene escrito',
    trace.n > 0 && trace.iguales === trace.n, `${N(trace.iguales)} de ${N(trace.n)}`);

  // ── 3. ⭐⭐ El filtro `sucursal = c1`: por qué hace falta, PROBADO ───────────────────────────
  // Este bloque tuvo dos versiones malas antes de esta:
  //
  //   v1: `check('la réplica existe y por eso el filtro hace falta', replica > 0)`. No era una
  //       prueba, era la etiqueta: pasa mientras la columna exista.
  //   v2: al medir el descarte contra suc02/alm02 por **entradas acumuladas de `kdil`** dio
  //       3.66% idénticas y **1,049 SKUs por DELANTE del original**, y de ahí concluí que la
  //       etiqueta "réplica" estaba refutada. **Estaba mal, y el error fue de testigo:** `kdil`
  //       es un ACUMULADO recalculable, así que su divergencia no prueba nada sobre el origen de
  //       los datos. Había un testigo fuerte disponible y no lo usé.
  //
  // El testigo fuerte es la IDENTIDAD DOCUMENTAL, y es concluyente (prod 2026-09-09):
  //     docs de suc03 con almacén 02 ............. 37,020
  //     el mismo (folio, doctype) en la suc 02 ... 37,020  = 100.00%   -> ES RÉPLICA
  //     rango de la réplica ....... 2025-01-01 -> 2026-01-07  (la 02 sigue hasta hoy: CONGELADA)
  // Y el costo de publicarla, medido: de 2,594 celdas con existencia, **1,771 (78,633 u) tienen
  // el SKU YA publicado desde la sucursal 02** — sería doble conteo.
  //
  // Así que el filtro está CORRECTO y las 90,630 u no son un hueco: son doble conteo evitado.
  // Lo que este bloque asegura es que la razón siga siendo verdad, no que la etiqueta exista.
  console.log('\n── 3. ⭐⭐ Por qué hace falta el filtro `sucursal = c1` (identidad documental) ──');
  const rep = (await c.query(
    `SELECT count(*) FILTER (WHERE sucursal = btrim(c1::text))::int propias,
            count(*) FILTER (WHERE sucursal <> btrim(c1::text))::int fuera,
            count(DISTINCT sucursal) FILTER (WHERE sucursal <> btrim(c1::text))::int sucs_fuera
       FROM kepler_ods.kdik`)).rows[0];
  const kdil = (await c.query(
    `SELECT count(*) FILTER (WHERE sucursal <> btrim(c1))::int fuera,
            coalesce(sum(c4+c8-c9) FILTER (WHERE sucursal <> btrim(c1)), 0)::numeric u_fuera
       FROM kepler_ods.kdil WHERE sucursal <> '00'`)).rows[0];
  console.log(`     kdik: ${N(rep.propias)} propias · ${N(rep.fuera)} descartadas, de ${rep.sucs_fuera} sucursal(es)`);
  console.log(`     kdil: ${N(kdil.fuera)} descartadas = ${N(kdil.u_fuera)} unidades`);
  check('⛔ el descarte existe y por eso el filtro cambia el resultado', rep.fuera > 0, `${N(rep.fuera)}`);
  check('⛔ el descarte está ACOTADO a una sucursal (si se abre, hay que re-investigarlo)',
    rep.sucs_fuera === 1, `${rep.sucs_fuera} sucursales — ya no es el caso único de la 03`);

  // ⭐⭐ LA PRUEBA FUERTE: el almacén descartado replica documentos de otra sucursal.
  // `kdm1`: `c1` = almacén y `c6` = FOLIO (lo fija `mart_refresh_ventas.sql`, que selecciona
  // `h.c1, h.c6, ...` hacia `(almacen, folio, ...)`). ⚠️ Medir `c6` como almacén devuelve 20 MB
  // de folios sueltos y parece que la sucursal vende desde 4,000 almacenes.
  const dup = (await c.query(
    `WITH a AS (SELECT btrim(c6) folio, c4 dt FROM kepler_ods.kdm1
                 WHERE sucursal = '03' AND btrim(c1) = '02' AND c2 = 'U' AND c3 = 'D'),
          b AS (SELECT btrim(c6) folio, c4 dt FROM kepler_ods.kdm1
                 WHERE sucursal = '02' AND btrim(c1) = '02' AND c2 = 'U' AND c3 = 'D')
     SELECT (SELECT count(*) FROM a)::int en_03,
            (SELECT count(*) FROM a WHERE EXISTS
               (SELECT 1 FROM b WHERE b.folio = a.folio AND b.dt = a.dt))::int tambien_en_02,
            (SELECT max(c9)::date FROM kepler_ods.kdm1
              WHERE sucursal='03' AND btrim(c1)='02' AND c2='U' AND c3='D')::text hasta_03,
            (SELECT max(c9)::date FROM kepler_ods.kdm1
              WHERE sucursal='02' AND btrim(c1)='02' AND c2='U' AND c3='D')::text hasta_02`)).rows[0];
  console.log(`     ${N(dup.en_03)} docs de suc03/alm02 · el mismo (folio,doctype) en la suc 02:`
    + ` ${N(dup.tambien_en_02)} (${pct(dup.tambien_en_02, dup.en_03).toFixed(2)}%)`);
  console.log(`     la réplica llega a ${dup.hasta_03} · la sucursal 02 real llega a ${dup.hasta_02} (CONGELADA)`);
  check('⭐⭐ el almacén descartado REPLICA documentos de otra sucursal (≥ 99% de folios idénticos)',
    pct(dup.tambien_en_02, dup.en_03) >= 99,
    `${pct(dup.tambien_en_02, dup.en_03).toFixed(2)}% — si baja, ya no es réplica y el filtro esconde stock real`);

  const doble = (await c.query(
    `WITH t3 AS (SELECT btrim(c3) sku, GREATEST(SUM(c4+c8-c9),0) qty FROM kepler_ods.kdil
                  WHERE sucursal='03' AND btrim(c1)='02' GROUP BY 1),
          t2 AS (SELECT btrim(c3) sku, GREATEST(SUM(c4+c8-c9),0) qty FROM kepler_ods.kdil
                  WHERE sucursal='02' AND btrim(c1)='02' GROUP BY 1)
     SELECT count(*) FILTER (WHERE t3.qty>0)::int celdas,
            count(*) FILTER (WHERE t3.qty>0 AND t2.qty>0)::int solapadas,
            coalesce(sum(t3.qty) FILTER (WHERE t3.qty>0 AND t2.qty>0),0)::numeric u_doble
       FROM t3 LEFT JOIN t2 USING (sku)`)).rows[0];
  console.log(`     publicarlo sería doble conteo en ${N(doble.solapadas)} de ${N(doble.celdas)} celdas`
    + ` = ${N(doble.u_doble)} unidades`);
  check('⭐ y publicarlo sería DOBLE CONTEO medido, no una hipótesis', Number(doble.u_doble) > 0,
    `${N(doble.u_doble)} u ya publicadas desde la sucursal 02`);
  const dupRows = (await c.query(
    `SELECT count(*)::int n FROM (
       SELECT warehouse_id, product_id FROM st
        GROUP BY 1,2 HAVING count(*) > 1) t`)).rows[0].n;
  check('⛔ el testigo NO duplica filas (un almacén×producto, una fila)', dupRows === 0, `${N(dupRows)} duplicadas`);

  // ── 4. ⭐ El veredicto ──────────────────────────────────────────────────────────────────────
  console.log('\n── 4. ⭐ El veredicto (los pisos son lo MEDIDO en prod 2026-09-08) ──');
  const v = (await c.query(
    `SELECT veredicto, count(*)::int filas,
            sum(valor_publicado_hoy)::numeric pub,
            sum(valor_arbitrado)::numeric arb
       FROM st WHERE qty > 0
      GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const by = Object.fromEntries(v.map((x) => [x.veredicto, x]));
  const tot = v.reduce((a, x) => a + x.filas, 0);
  for (const x of v) {
    console.log(`     ${String(x.veredicto).padEnd(24)} ${String(N(x.filas)).padStart(7)} (${pct(x.filas, tot).toFixed(2)}%)`
      + `  publicado ${money(x.pub).padStart(14)}  arbitrado ${x.arb === null ? 'NULL'.padStart(14) : money(x.arb).padStart(14)}`);
  }
  const conf = (by.confirmado || {}).filas || 0;
  const contra = (by.contradicho_por_factor || {}).filas || 0;
  check('⭐ el costo del catálogo COINCIDE con el de Kepler en la mayoría (≥ 65%)',
    pct(conf, tot) >= 65, `${pct(conf, tot).toFixed(2)}%`);
  check('⛔ `contradicho_por_factor` EXISTE — un árbitro que nunca contradice es un espejo',
    contra > 0, `${N(contra)}`);
  check('⛔ y no se come la población (≤ 5%)', pct(contra, tot) <= 5, `${pct(contra, tot).toFixed(2)}%`);

  // ── 5. ⛔ Nunca un valor de relleno (ADR-056) ───────────────────────────────────────────────
  console.log('\n── 5. ⛔ Sin testigo NO significa cero ──');
  const st = (await c.query(
    `SELECT count(*)::int filas,
            count(*) FILTER (WHERE valor_arbitrado IS NOT NULL)::int con_valor
       FROM st WHERE veredicto='sin_testigo'`)).rows[0];
  console.log(`     sin_testigo: ${N(st.filas)} filas`);
  check('⛔ `sin_testigo` viaja con valor_arbitrado NULL, jamás con 0 de relleno',
    st.con_valor === 0, `${N(st.con_valor)} traen número`);
  check('⛔ `sin_testigo` EXISTE — un 0 significaría que la vista inventa el costo',
    st.filas > 0, 'si da 0, revisar si el LEFT JOIN se volvió INNER');
  // Las DOS ausencias tienen que ser distinguibles: no es lo mismo que falte el testigo de
  // Kepler a que falte el costo del catálogo.
  const dos = (await c.query(
    `SELECT count(DISTINCT veredicto)::int n FROM st
      WHERE veredicto IN ('sin_testigo','sin_costo_catalogo')`)).rows[0].n;
  check('⭐ las dos ausencias son etiquetas distintas (o al menos una está poblada)', dos >= 1, `${dos}`);

  // ── 6. ⭐ Las DOS causas de la brecha, separadas ────────────────────────────────────────────
  // Que el total cuadre no alcanza: hay que poder decir CUÁNTO es impuesto y CUÁNTO es unidad.
  console.log('\n── 6. ⭐ La brecha, partida por causa ──');
  const b = (await c.query(
    `SELECT
       sum(valor_publicado_hoy) FILTER (WHERE veredicto='confirmado')::numeric pub_conf,
       sum(valor_arbitrado)     FILTER (WHERE veredicto='confirmado')::numeric arb_conf,
       sum(valor_publicado_hoy) FILTER (WHERE veredicto='contradicho_por_factor')::numeric pub_fac,
       sum(valor_arbitrado)     FILTER (WHERE veredicto='contradicho_por_factor')::numeric arb_fac,
       sum(valor_publicado_hoy)::numeric pub_tot,
       sum(valor_arbitrado)::numeric arb_tot
     FROM st WHERE qty > 0`)).rows[0];
  const gapTax = Number(b.pub_conf) - Number(b.arb_conf);
  const gapFac = Number(b.pub_fac) - Number(b.arb_fac);
  const gapTot = Number(b.pub_tot) - Number(b.arb_tot);
  console.log(`     el IMPUESTO (filas donde el costo YA coincide): ${money(gapTax)}  razón ${(Number(b.pub_conf) / Number(b.arb_conf)).toFixed(4)}`);
  console.log(`     el FACTOR   (${N((by.contradicho_por_factor || {}).filas || 0)} filas de bulto)          : ${money(gapFac)}`);
  console.log(`     brecha TOTAL publicado - arbitrado            : ${money(gapTot)}  (${pct(gapTot, Number(b.pub_tot)).toFixed(2)}% de lo publicado)`);
  check('⭐ el impuesto explica una brecha ≈ 8-12% en las filas confirmadas',
    Number(b.pub_conf) / Number(b.arb_conf) >= 1.05 && Number(b.pub_conf) / Number(b.arb_conf) <= 1.15,
    `${(Number(b.pub_conf) / Number(b.arb_conf)).toFixed(4)} — si se va a 1.0000, la pantalla ya dejó de publicar con impuesto`);
  check('⛔ la brecha por FACTOR sigue medida y no se ignora', gapFac > 0, money(gapFac));

  // ── 7. La cantidad, que ya era verdad — y su hueco declarado ───────────────────────────────
  console.log('\n── 7. La CANTIDAD (lo que ya cerraba, y sigue cerrando) ──');
  const q = (await c.query(
    `SELECT count(*)::int filas,
            count(*) FILTER (WHERE abs(coalesce(entradas,0)-coalesce(salidas,0)-coalesce(qty_publicada,0)) <= 0.01)::int cuadran,
            count(*) FILTER (WHERE coalesce(entradas,0)-coalesce(salidas,0) < 0)::int negativos,
            count(*) FILTER (WHERE abs(coalesce(entradas,0)-coalesce(salidas,0)-coalesce(qty_publicada,0)) > 0.01
                             AND coalesce(entradas,0)-coalesce(salidas,0) >= 0)::int sin_explicar
       FROM analytics.v_existencia_dictamen WHERE erp='kepler'`)).rows[0];
  console.log(`     ${N(q.filas)} filas · identidad directa ${pct(q.cuadran, q.filas).toFixed(2)}% · negativos recortados ${N(q.negativos)}`);
  // ⚠️ Este check dice MENOS de lo que su nombre viejo prometía, y a propósito. `sin_explicar` se
  // define con `AND entradas - salidas >= 0`, así que **excluye por construcción** los negativos,
  // que son el único residuo que existe. Cerrar en 0 era la definición, no un hallazgo.
  check('la identidad cuadra donde el neto es ≥ 0 (los negativos NO entran en esta cuenta)',
    q.sin_explicar === 0, `${N(q.sin_explicar)} filas sin explicar`);

  // ── 7b. ⭐ LOS NEGATIVOS, que se contaban y no se asertaban ────────────────────────────────
  // Un saldo negativo no es una fila sana: es mercancía que Kepler dice que salió sin haber
  // entrado. Se recortan a cero (`GREATEST(...,0)`) para no publicar existencia imposible — eso
  // está bien — pero **recortar no es explicar**, y sin techo podían triplicarse en silencio.
  console.log('\n── 7b. ⭐ Los NEGATIVOS: recortar no es explicar ──');
  const neg = (await c.query(
    `WITH raw AS (
       SELECT k.sucursal suc, btrim(k.c3) sku,
              SUM(k.c8) ent, SUM(k.c9) sal, SUM(k.c4+k.c8-k.c9) neto
         FROM kepler_ods.kdil k
        WHERE k.sucursal = k.c1 AND k.sucursal <> '00'
          AND btrim(k.c3) <> ALL (ARRAY['00001','00002','00022'])
        GROUP BY 1,2)
     SELECT count(*) FILTER (WHERE neto < 0)::int negativos,
            count(*)::int filas,
            coalesce(sum(neto) FILTER (WHERE neto < 0), 0)::numeric unidades,
            count(*) FILTER (WHERE neto < 0 AND ent = 0)::int sin_entradas,
            count(*) FILTER (WHERE neto < 0 AND ent > 0)::int con_entradas_insuf,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY sal/nullif(ent,0))
                  FILTER (WHERE neto < 0)::numeric, 3) med_sal_ent
        FROM raw`)).rows[0];
  console.log(`     ${N(neg.negativos)} de ${N(neg.filas)} filas (${pct(neg.negativos, neg.filas).toFixed(2)}%)`
    + ` = ${N(neg.unidades)} unidades imposibles`);
  console.log(`     sin NINGUNA entrada: ${N(neg.sin_entradas)} · con entradas insuficientes: ${N(neg.con_entradas_insuf)}`
    + ` · mediana salidas/entradas ${neg.med_sal_ent}`);
  check('⛔ los negativos EXISTEN y se cuentan (si dan 0, el recorte se movió y ya no se ven)',
    neg.negativos > 0, `${N(neg.negativos)}`);
  check('⚠️ los negativos no CRECIERON (1,817 filas medidas; techo 2,500)',
    neg.negativos <= 2500, `${N(neg.negativos)} filas — investigar antes de subir el techo`);
  check('⚠️ las unidades imposibles no CRECIERON (−68,513 medidas; techo −120,000)',
    Number(neg.unidades) >= -120000, `${N(neg.unidades)} u`);
  // La firma: NO es error de unidad. Si algún día la mediana se pega a un factor de caja (12, 24),
  // entonces sí lo es, y este check se pone rojo para forzar la re-investigación.
  check('⭐ la causa NO es error de unidad (mediana salidas/entradas cerca de 1, no de 12 ni 24)',
    Number(neg.med_sal_ent) > 0.5 && Number(neg.med_sal_ent) < 2,
    `mediana ${neg.med_sal_ent} — si se fue a ~12 o ~24, ahora SÍ es un peldaño mal capturado`);
  check('⛔ el "baseline = 0" NO significa que el inicial sea cero: hay SKUs que venden sin entrar',
    neg.sin_entradas > 0, `${N(neg.sin_entradas)} SKUs con salidas y cero entradas`);
  const cero = (await c.query(
    `SELECT count(*)::int n FROM st t
       JOIN commercial.warehouses w ON w.tenant_id=t.tenant_id AND w.id=t.warehouse_id
      WHERE w.kepler_code = '00'`)).rows[0].n;
  check('⛔ la sucursal 00 de Kepler (122M unidades fantasma) NO entra', cero === 0, `${N(cero)} filas`);

  // ── 7c. ⭐⭐ QUÉ ES EL ÁRBITRO: `c16` es un PROMEDIO HISTÓRICO, no el costo de hoy ──────────
  // `c16 = c8/c5`, y `c5` resultó ser **las entradas acumuladas** — idéntico a `kdil.c8` en el
  // 100.00% de 25,142 pares. O sea el árbitro divide el valor acumulado de TODA la historia de
  // compras entre las unidades acumuladas. Es un costo promedio ponderado, legítimo para valuar
  // inventario, pero **rezagado por construcción**. Este bloque lo deja probado y acotado, porque
  // §9.4 de la doc sólo decía qué NO era `c5`, no qué ES — y sin eso el árbitro parecía "el costo
  // de Kepler hoy", que no lo es.
  console.log('\n── 7c. ⭐⭐ El árbitro es un promedio histórico (prueba de qué es kdik.c5) ──');
  const c5 = (await c.query(
    `WITH l AS (SELECT k.sucursal suc, btrim(k.c3) sku, SUM(k.c8) ent
                  FROM kepler_ods.kdil k
                 WHERE k.sucursal = k.c1 AND k.sucursal <> '00' GROUP BY 1,2),
          kk AS (SELECT k.sucursal suc, btrim(k.c2::text) sku, max(k.c5::numeric) c5
                   FROM kepler_ods.kdik k
                  WHERE k.sucursal = btrim(k.c1::text) AND k.sucursal <> '00' GROUP BY 1,2)
     SELECT count(*)::int pares,
            count(*) FILTER (WHERE abs(kk.c5 - l.ent) <= 0.01)::int c5_es_entradas
       FROM l JOIN kk ON kk.suc = l.suc AND kk.sku = l.sku`)).rows[0];
  console.log(`     kdik.c5 == kdil.c8 (entradas acumuladas) en ${N(c5.c5_es_entradas)} de ${N(c5.pares)}`
    + ` (${pct(c5.c5_es_entradas, c5.pares).toFixed(2)}%)`);
  check('⭐⭐ `c5` son las ENTRADAS ACUMULADAS, así que `c16 = c8/c5` es costo promedio histórico',
    pct(c5.c5_es_entradas, c5.pares) >= 99, `${pct(c5.c5_es_entradas, c5.pares).toFixed(2)}%`);

  const c18 = (await c.query(
    `WITH kk AS (SELECT sucursal suc, btrim(c2::text) sku,
                        max(c16::numeric) c16, max(NULLIF(c18,0)::numeric) c18
                   FROM kepler_ods.kdik
                  WHERE sucursal = btrim(c1::text) AND sucursal <> '00' GROUP BY 1,2)
     SELECT count(*)::int pares, count(c18)::int con_c18,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c16/nullif(c18,0))::numeric,4) med
       FROM kk WHERE c16 > 0`)).rows[0];
  console.log(`     contra c18 (último costo): mediana c16/c18 = ${c18.med}`
    + ` · c18 falta en ${pct(c18.pares - c18.con_c18, c18.pares).toFixed(2)}% de los pares`);
  check('⚠️ el árbitro valúa ~2% BARATO por ser promedio, y eso se declara (banda 0.90–1.05)',
    Number(c18.med) >= 0.90 && Number(c18.med) <= 1.05,
    `${c18.med} — si se aleja, el promedio dejó de seguir al costo real`);

  // ── 7d. ⭐ El catálogo: cuatro recargos, y 62 SKUs con las columnas al revés ────────────────
  // Publicar con impuesto no era UN error uniforme: `cost_with_tax/cost_base` toma cuatro valores
  // (1.000 / 1.080 / 1.160 / 1.240 = IVA 16 + IEPS 8). Y hay 62 SKUs donde la razón es MENOR a 1,
  // que ningún impuesto puede producir: ahí las dos columnas están en unidades distintas y la que
  // se llama "con impuesto" es la que trae la unidad chica.
  console.log('\n── 7d. ⭐ El catálogo: cuatro recargos + 62 SKUs con las columnas al revés ──');
  const tasas = (await c.query(
    `SELECT round(cost_with_tax/nullif(cost_base,0), 3)::numeric ratio, count(*)::int skus
       FROM catalog.products
      WHERE tenant_id = '${T}' AND deleted_at IS NULL
        AND cost_base > 0 AND cost_with_tax > 0
        AND cost_with_tax >= cost_base * 0.95
      GROUP BY 1 HAVING count(*) >= 50 ORDER BY 2 DESC`)).rows;
  console.log('     ' + tasas.map((x) => `×${x.ratio} (${N(x.skus)})`).join(' · '));
  check('⭐ el recargo NO es uno solo: hay ≥ 3 tasas distintas conviviendo', tasas.length >= 3,
    `${tasas.length} tasas con ≥50 SKUs`);

  const inv = (await c.query(
    `WITH bad AS (
       SELECT id FROM catalog.products
        WHERE tenant_id = '${T}' AND deleted_at IS NULL
          AND cost_base > 0 AND cost_with_tax > 0 AND cost_with_tax < cost_base * 0.95)
     SELECT (SELECT count(*) FROM bad)::int skus,
            count(*)::int filas,
            count(*) FILTER (WHERE abs(s.costo_publicado_hoy/s.costo_kepler - 1) <= 0.05)::int contax_pega,
            count(*) FILTER (WHERE abs(s.costo_catalogo/s.costo_kepler - 1) <= 0.05)::int base_pega,
            count(*) FILTER (WHERE coalesce(s.costo_kepler,0) <= 0)::int al_fallback
       FROM st s JOIN bad ON bad.id = s.product_id
      WHERE s.qty > 0 AND s.costo_kepler > 0`)).rows[0];
  console.log(`     ${N(inv.skus)} SKUs con cost_with_tax < cost_base · ${N(inv.filas)} filas con existencia`);
  console.log(`     contra Kepler: cost_with_tax pega en ${N(inv.contax_pega)} · cost_base sólo en ${N(inv.base_pega)}`);
  check('⛔ existen SKUs donde cost_with_tax < cost_base (imposible para un impuesto)',
    inv.skus > 0, `${N(inv.skus)}`);
  check('⭐⭐ y ahí gana `cost_with_tax`: es la unidad chica, al revés de lo que dice su nombre',
    inv.contax_pega > inv.base_pega, `${N(inv.contax_pega)} vs ${N(inv.base_pega)}`);
  check('⚠️ NINGUNA de esas filas cae al fallback del service (si cae, se valúa ~11× arriba)',
    inv.al_fallback === 0, `${N(inv.al_fallback)} filas sin costo de Kepler — la bomba se armó`);

  // KX — y el fallback va BLINDADO, con las dos mitades del trato medidas: que arregle el caso
  // roto y que NO toque el sano. La expresión es un LEAST entre las dos columnas del catálogo.
  const least = (await c.query(
    `WITH bad AS (
       SELECT id, cost_base, cost_with_tax FROM catalog.products
        WHERE tenant_id = '${T}' AND deleted_at IS NULL
          AND cost_base > 0 AND cost_with_tax > 0 AND cost_with_tax < cost_base * 0.95),
      agg AS (
       SELECT coalesce(sum(s.qty * b.cost_base), 0)::numeric                         viejo,
              coalesce(sum(s.qty * LEAST(b.cost_base, b.cost_with_tax)), 0)::numeric nuevo,
              coalesce(sum(s.valor_arbitrado), 0)::numeric                           erp
         FROM st s JOIN bad b ON b.id = s.product_id WHERE s.qty > 0),
      sano AS (
       SELECT count(*)::int n,
              count(*) FILTER (WHERE cost_base = LEAST(cost_base,
                        COALESCE(NULLIF(cost_with_tax, 0), cost_base)))::int gana_base
         FROM catalog.products
        WHERE tenant_id = '${T}' AND deleted_at IS NULL AND cost_base > 0
          AND NOT (COALESCE(cost_with_tax, 0) > 0 AND cost_with_tax < cost_base))
     SELECT agg.viejo, agg.nuevo, agg.erp, sano.n, sano.gana_base FROM agg, sano`)).rows[0];
  console.log(`     el fallback sobre esas filas: viejo ${money(least.viejo)}`
    + ` · blindado ${money(least.nuevo)} · el ERP dice ${money(least.erp)}`);
  check('⭐ el blindaje ACERCA el fallback al costo del ERP (al menos 3× más cerca que cost_base)',
    Number(least.viejo) > Number(least.nuevo) * 3,
    `viejo ${money(least.viejo)} vs blindado ${money(least.nuevo)}`);
  // ⚠️ Y lo que el blindaje NO hace, dicho: sigue ~2.3× arriba del ERP porque cost_with_tax trae
  // impuesto. Es un fallback, no el árbitro — reduce el error de ~14.5× a ~2.3×, no lo elimina.
  check('⛔ y NO toca el caso sano: en los SKUs normales el LEAST sigue eligiendo cost_base',
    least.gana_base === least.n, `${N(least.gana_base)} de ${N(least.n)}`);

  // ── 8. Lo que este candado NO mide, declarado ──────────────────────────────────────────────
  console.log('\n── 8. Lo que este candado no mide ──');
  console.log('     ⚠️  Sólo KEPLER. Wincaja tiene su propia identidad de existencia (cuadra al');
  console.log('        100.00% en sus 21 sucursales) y su propio costo, pero queda fuera por');
  console.log('        decisión explícita: "solo hay que enfocarnos en kepler".');
  console.log('     ⚠️  `precio_movido` NO se juzga: una diferencia < 50% entre los dos costos');
  console.log('        puede ser deriva de precio y no un error de unidad. Se enumera, no se acusa.');
  console.log('     ⚠️  Esta vista NO elige el costo bueno. Devuelve los dos y el veredicto; quién');
  console.log('        valúa la pantalla es un cambio aparte, con su antes/después.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
