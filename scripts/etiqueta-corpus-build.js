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

/** Los que tienen que estar aunque el muestreo por estrato no los pesque. */
const TESTIGOS = ['78148', '20186', '70031', '70500', '70079', '70043'];

/**
 * `renglones` replica los getters del componente con el hero por default:
 *   hasMayoreoPza = base suelta  && wpza > 0 && (base <= 0 || wpza < base)
 *   hasMayoreoPaq = base agrupada && base > 0 && wpaq > 0 && wpaq < base
 *   hasPaquete    = pack_price > 0 && pack_size > 0
 *   hasCaja       = box_price  > 0 && box_size  > 0
 * Contar columnas de la tabla en vez de esto sobreestima: da 73.7% con 2 renglones
 * cuando lo que se imprime de verdad es 78.4%.
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
         least(length(trim(to_char(lp.piece_price,'999999'))), 4) AS digitos,
         least(
           CASE WHEN NOT (upper(btrim(coalesce(lp.unit_base,''))) IN ('PAQ','CJA'))
                     AND coalesce(lp.wholesale_piece_price,0) > 0
                     AND (coalesce(lp.piece_price,0) <= 0 OR lp.wholesale_piece_price < lp.piece_price)
                THEN 1 ELSE 0 END
         + CASE WHEN (upper(btrim(coalesce(lp.unit_base,''))) IN ('PAQ','CJA'))
                     AND coalesce(lp.piece_price,0) > 0 AND coalesce(lp.wholesale_pack_price,0) > 0
                     AND lp.wholesale_pack_price < lp.piece_price
                THEN 1 ELSE 0 END
         + CASE WHEN coalesce(lp.pack_price,0) > 0 AND coalesce(lp.pack_size,0) > 0 THEN 1 ELSE 0 END
         + CASE WHEN coalesce(lp.box_price,0) > 0 AND coalesce(lp.box_size,0) > 0 THEN 1 ELSE 0 END, 3) AS renglones,
         -- el mayoreo con menos de 1% de descuento: hoy imprime chip de oferta sin serlo
         (upper(btrim(coalesce(lp.unit_base,''))) IN ('PAQ','CJA')
           AND coalesce(lp.piece_price,0) > 0 AND coalesce(lp.wholesale_pack_price,0) > 0
           AND lp.wholesale_pack_price < lp.piece_price
           AND (1 - lp.wholesale_pack_price/lp.piece_price) * 100 < 1) AS realce_sin_descuento,
         (coalesce(lp.wholesale_pack_price,0) > 0 AND coalesce(lp.wholesale_pack_min_qty,0) <= 1) AS sin_umbral
  FROM commercial.product_label_prices lp
  JOIN catalog.products p ON p.id = lp.product_id
  WHERE coalesce(lp.piece_price,0) > 0
  -- [NORM.3] la tabla paso a tener grano por PLAZA: sin esto cada producto entraría 9 veces.
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
    fuente: 'commercial.product_label_prices + catalog.products (PROD)',
    nota: 'CONGELADO a proposito: el antes y el despues se miden sobre las MISMAS filas. '
        + 'Regenerar obliga a re-medir el antes.',
    pesos_catalogo_pct: pesos,
    filas: corpus.length,
    corpus,
  }, null, 1) + '\n');
})().catch((e) => { console.error(e.message); process.exit(1); });
