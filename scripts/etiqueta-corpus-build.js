/**
 * Arma el CORPUS CONGELADO con el que se mide la geometría de la etiqueta de anaquel.
 *
 * ¿Por qué congelado y no una consulta en vivo? Porque el antes y el después tienen que
 * medirse sobre las MISMAS filas. Si el corpus se re-consulta, un cambio de precio entre las
 * dos corridas se lee como efecto del rediseño — el repo ya tiene registrada una corrección
 * por comparar dos instantes distintos en vez de dos versiones del código.
 *
 * Se corre A MANO y sólo cuando se quiera renovar la muestra (y entonces hay que re-medir el
 * "antes" con el corpus nuevo). El que mide es `scripts/etiqueta-geometria.js`.
 *
 * Uso:  node scripts/etiqueta-corpus-build.js > scripts/fixtures/etiqueta-corpus.json
 */
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;

/**
 * Los que tienen que estar aunque el muestreo por estrato no los pesque.
 *
 * `[ETQ-PRES.4]` Se suman los cuatro que motivaron la migración: `18022` (tres presentaciones,
 * y el "25 kg" que colgaba del precio de la porción), `95717` (la caja con su peldaño real) y
 * `44228`/`83112` (mayoreo incoherente, que no se publica). Si la geometría se rompe, se tiene
 * que romper visiblemente en ellos.
 */
const TESTIGOS = ['78148', '20186', '70031', '70500', '70079', '70043',
  '18022', '95717', '44228', '83112'];

/**
 * ⭐ `[ETQ-PRES.4]` EL CORPUS SALE DEL ODS, NO DE LA COPIA.
 *
 * Hasta acá la población se leía de `commercial.product_label_prices`, que es la tabla que
 * mantiene un importer cada 30 min — la misma copia que el servicio dejó de leer en
 * `[ETQ-ODS.1]`. O sea que el arnés certificaba la geometría de una etiqueta armada con
 * precios que podían estar hasta media hora atrás de los que se imprimen.
 *
 * Ahora sale de `analytics.v_label_prices` + `analytics.v_label_presentations`, las dos
 * derivadas de `kepler_ods` sin tabla intermedia: la misma frontera que lee la pantalla.
 *
 * Y `renglones` deja de replicar los cuatro getters del modelo de cajones —que ya no
 * existen— para contar lo que el componente IMPRIME: el precio de lista de cada presentación
 * que no es la del hero, más el peldaño de las que tienen veredicto `ok` con umbral real.
 */
/**
 * ⭐ El BARCODE sale de `catalog.products`, NO de `commercial.product_label_prices`.
 *
 * Es lo que resuelve el backend (`commercial-labels.service.ts`: `rawBc = p.barcode` y la
 * simbología por longitud), o sea lo que de verdad se imprime. El corpus leía `lp.barcode` y
 * quedaba en null muchísimas veces → el arnés dibujaba el CODE128 de RESPALDO donde producción
 * dibuja un EAN-13/UPC. Y no es lo mismo: el alto del bloque del código es justo el insumo con
 * que `fitBarcode` reparte el aire de la columna, así que el arnés medía una etiqueta que no
 * existe y su invariante `tiers_recortado` daba 0 mientras el papel salía con un renglón cortado.
 *
 * Medido en PROD el 2026-09-18 sobre las 78,610 filas con precio: `lp.barcode` cubre 50,259 y
 * `p.barcode` cubre 78,531 — o sea 28,272 filas (36%) con la simbología equivocada.
 */
const BARCODE_SQL = `
         CASE WHEN btrim(coalesce(p.barcode,'')) ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13})$'
              THEN btrim(p.barcode) END AS barcode,
         CASE WHEN btrim(coalesce(p.barcode,'')) ~ '^[0-9]{13}$' THEN 'EAN13'
              WHEN btrim(coalesce(p.barcode,'')) ~ '^[0-9]{12}$' THEN 'UPC'
              WHEN btrim(coalesce(p.barcode,'')) ~ '^[0-9]{8}$'  THEN 'EAN8' END AS barcode_format,`;

/**
 * La población base. Se define UNA vez porque de acá salen las dos cosas que tienen que hablar
 * del mismo universo: la muestra del corpus y los PESOS con que el arnés pondera sus promedios.
 * Con dos definiciones, los pesos terminan describiendo un catálogo distinto del que se mide.
 */
const CTE_L = `
  SELECT DISTINCT ON (p.sku)
         p.sku, p.nombre AS name, lp.content, lp.sucursal, ${BARCODE_SQL}
         lp.piece_price, lp.wholesale_piece_min_qty, lp.wholesale_piece_price,
         lp.pack_size, lp.pack_price, lp.wholesale_pack_price, lp.wholesale_pack_min_qty,
         lp.box_size, lp.box_price, lp.unit_base, lp.sold_by_kg,
         pres.lista AS presentaciones,
         least(length(trim(to_char(coalesce(
           CASE WHEN lp.sold_by_kg THEN pres.precio_kg END,
           pres.precio_base, pres.precio_primero, lp.piece_price),'999999'))), 4) AS digitos,
         -- \`[ETQ-PRES.4]\` Los renglones que el componente IMPRIME, con su misma regla: el precio
         -- de lista de cada presentación que no es la del hero, más el peldaño de las que tienen
         -- veredicto \`ok\`. Contar los tres cajones acá daría un corpus de una etiqueta que ya no
         -- existe, y el arnés mediría el alto de renglones que nadie va a imprimir.
         coalesce(pres.renglones, 0) AS renglones,
         coalesce(pres.realce_flojo, false) AS realce_sin_descuento,
         coalesce(pres.sin_umbral, false)   AS sin_umbral
  FROM analytics.v_label_prices lp
  JOIN catalog.products p ON btrim(p.sku) = lp.sku AND p.deleted_at IS NULL
  -- ⚠️ Esto era un LEFT JOIN **LATERAL** y no se podía correr: el planificador ejecuta la vista
  -- una vez por fila, o sea 84,219 veces, y la consulta moría en el \`statement_timeout\` de 180 s.
  -- Por separado las dos vistas tardan 4.4 s y 7.2 s. Agrupar PRIMERO y unir después deja UNA
  -- pasada por cada lado. El precio de la lateral no estaba en la vista: estaba en la forma.
  LEFT JOIN (
    SELECT v.sucursal, v.sku,
           jsonb_agg(jsonb_build_object(
             'unidad', v.unidad, 'factor', v.factor, 'origen', v.origen,
             'contenido', v.contenido, 'precio_lista', v.precio_lista,
             'mayoreo_precio', v.mayoreo_precio, 'mayoreo_desde', v.mayoreo_desde,
             'mayoreo_veredicto', v.mayoreo_veredicto)
             ORDER BY v.factor NULLS LAST) AS lista,
           -- Las tres piezas del hero. Cuál gana lo decide el consumidor, que es el único que
           -- sabe si el producto se vende por kilo — igual que \`heroPres\` en el componente.
           min(v.precio_lista) FILTER (WHERE v.unidad = 'KG'   AND v.precio_lista > 0) AS precio_kg,
           min(v.precio_lista) FILTER (WHERE v.origen = 'base' AND v.precio_lista > 0) AS precio_base,
           (array_agg(v.precio_lista ORDER BY v.factor) FILTER (WHERE v.precio_lista > 0))[1] AS precio_primero,
           -- ⭐ Los renglones NO necesitan saber cuál es el hero: sea cual sea, es exactamente UNA
           -- de las que tienen precio. Contar "las que tienen precio menos una" es correcto para
           -- los tres caminos de la cascada, y no se puede desincronizar con ella.
           greatest(count(*) FILTER (WHERE v.precio_lista > 0) - 1, 0)
           + count(*) FILTER (WHERE v.mayoreo_veredicto = 'ok' AND coalesce(v.mayoreo_desde,0) > 1) AS renglones,
           bool_or(v.mayoreo_veredicto = 'ok' AND v.precio_lista > 0
                   AND (1 - v.mayoreo_precio / v.precio_lista) * 100 < 1) AS realce_flojo,
           bool_or(v.mayoreo_precio > 0 AND coalesce(v.mayoreo_desde,0) <= 1) AS sin_umbral
      FROM analytics.v_label_presentations v
     GROUP BY v.sucursal, v.sku) pres
    ON pres.sucursal = lp.sucursal AND pres.sku = lp.sku
  WHERE coalesce(lp.piece_price,0) > 0
  -- [NORM.3] el precio de Kepler es por PLAZA: sin esto cada producto entraría 9 veces.
  -- Se conserva una plaza por SKU (la primera) para que el corpus siga siendo una muestra de
  -- FORMAS de etiqueta, que es lo que la geometría mide.
  ORDER BY p.sku, lp.sucursal`;

/** Pesos del catálogo, derivados de la MISMA población que muestrea el corpus. */
const PESOS_SQL = `
WITH l AS (${CTE_L})
SELECT 'digitos' AS eje, digitos::text AS k, round(100.0*count(*)/sum(count(*)) OVER (),1) AS pct
  FROM l GROUP BY 1,2
UNION ALL
SELECT 'renglones', renglones::text, round(100.0*count(*)/sum(count(*)) OVER (),1)
  FROM l GROUP BY 1,2
ORDER BY 1,2`;

const SQL = `
WITH l AS (${CTE_L}),
muestra AS (
  SELECT *, row_number() OVER (
    PARTITION BY digitos, renglones, upper(btrim(coalesce(unit_base,'?')))
    ORDER BY sku) rn
  FROM l)
SELECT * FROM muestra WHERE rn <= 3
UNION ALL SELECT *, 0 FROM l WHERE sku = ANY($1::text[])
-- los casos que el rediseño tiene que dejar en cero
UNION ALL SELECT *, 0 FROM (SELECT * FROM l WHERE realce_sin_descuento ORDER BY sku LIMIT 6) a
UNION ALL SELECT *, 0 FROM (SELECT * FROM l WHERE sin_umbral ORDER BY sku LIMIT 6) b
-- los extremos de magnitud, que son los que desbordan
UNION ALL SELECT *, 0 FROM (SELECT * FROM l ORDER BY piece_price DESC LIMIT 3) c
UNION ALL SELECT *, 0 FROM (SELECT * FROM l ORDER BY coalesce(box_price,0) DESC LIMIT 3) d
UNION ALL SELECT *, 0 FROM (SELECT * FROM l ORDER BY length(name) DESC LIMIT 3) e
-- ⭐ La población que se recorta y que el corpus viejo NO podía representar: 3 renglones CON
-- código real. Medido en prod: 654 de las 1,180 filas de 3 renglones. Entra explícita porque el
-- muestreo por estrato no la garantiza — y es justo el caso que el arnés tiene que poder ver.
UNION ALL SELECT *, 0 FROM (
  SELECT * FROM l WHERE renglones >= 3 AND barcode IS NOT NULL
   ORDER BY coalesce(box_price,0) DESC LIMIT 12) f`;

(async () => {
  if (!URL) { console.error('Falta FLEET_DB_URL'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 180000 });
  await c.connect();
  const { rows } = await c.query(SQL, [TESTIGOS]);
  const { rows: pesosRows } = await c.query(PESOS_SQL);
  await c.end();

  const visto = new Set();
  const corpus = [];
  for (const r of rows) {
    if (visto.has(r.sku)) continue;
    visto.add(r.sku);
    const { rn, digitos, renglones, realce_sin_descuento, sin_umbral, ...modelo } = r;
    corpus.push({ ...modelo, _digitos: digitos, _renglones: renglones,
      _realce_sin_descuento: realce_sin_descuento, _sin_umbral: sin_umbral });
  }
  corpus.sort((a, b) => a.sku.localeCompare(b.sku));

  // Pesos del catálogo COMPLETO, para que el promedio del arnés sea representativo y no el
  // promedio de la muestra (que sobre-representa los estratos raros a propósito).
  //
  // ⭐ Se DERIVAN de la misma consulta, ya no se escriben a mano. Estaban clavados en
  // {1:9.1, 2:78.2, ...} / {0:5.0, 1:14.6, 2:78.4, 3:1.9} y para el 2026-09-18 el catálogo ya
  // decía {1:6.9, 2:80.1, ...} / {0:3.6, 1:20.2, 2:74.3, 3:1.9}: un número copiado a mano se
  // separa de su fuente en silencio, y acá ese número pondera TODO lo que el arnés publica.
  const pesos = { digitos: {}, renglones: {} };
  for (const r of pesosRows) pesos[r.eje][r.k] = Number(r.pct);

  process.stdout.write(JSON.stringify({
    generado: new Date().toISOString().slice(0, 10),
    fuente: 'analytics.v_label_prices + analytics.v_label_presentations + catalog.products (PROD, derivadas del ODS)',
    nota: 'CONGELADO a proposito: el antes y el despues se miden sobre las MISMAS filas. '
        + 'Regenerar obliga a re-medir el antes. '
        + '[ETQ-PRES.4] Regenerado el 2026-09-24 al migrar la etiqueta a la LISTA de '
        + 'presentaciones: el corpus anterior salia de commercial.product_label_prices (la COPIA '
        + 'que mantiene un importer) y contaba renglones con el modelo de tres cajones, o sea '
        + 'que media una etiqueta que ya no se imprime. El "antes" que conservaba dejo de existir.',
    pesos_catalogo_pct: pesos,
    filas: corpus.length,
    corpus,
  }, null, 1) + '\n');
})().catch((e) => { console.error(e.message); process.exit(1); });
