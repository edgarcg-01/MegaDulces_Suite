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
const SQL = `
WITH l AS (
  SELECT p.sku, p.nombre AS name, lp.content, lp.barcode, lp.barcode_format,
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
  WHERE coalesce(lp.piece_price,0) > 0),
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
UNION ALL SELECT *, 0 FROM (SELECT * FROM l ORDER BY length(name) DESC LIMIT 3) e`;

(async () => {
  if (!URL) { console.error('Falta FLEET_DB_URL'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 180000 });
  await c.connect();
  const { rows } = await c.query(SQL, [TESTIGOS]);
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
  const pesos = { digitos: { 1: 9.1, 2: 78.2, 3: 12.3, 4: 0.4 },
                  renglones: { 0: 5.0, 1: 14.6, 2: 78.4, 3: 1.9 } };

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
