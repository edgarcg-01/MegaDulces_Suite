/* eslint-disable no-console */
/**
 * CANDADO — LA ETIQUETA Y EL MOSTRADOR CONTRA SU FUENTE (ET.2).
 *
 * Edgar, 2026-09-14: *"también hay que usar fuentes principal y ver que esta interfaz tome
 * información correcta"*.
 *
 * ── Qué vigila, y por qué este candado existe ────────────────────────────────────────────────
 *
 * `commercial.product_label_prices` es una **COPIA** que mantiene un importer
 * (`import-label-data.js` → `services/feeds-ingest/label-compute.js`) de datos que viven en
 * `kepler_ods.kdii` + `kepler_ods.kdpv_prod_util`. De esa copia leen las DOS superficies que le
 * dicen un precio a un humano: la etiqueta del anaquel y el verificador de mostrador.
 *
 * ⭐ Y la copia **no tiene ningún dato propio**: medido, `source = 'kepler'` en el 100% de sus
 * filas y `'manual'` en CERO. Por la regla principal del proyecto —*todo dato sale del ODS, de una
 * tabla principal, derivando, no copiando*— esto debería ser una **VISTA derive-no-copy**. Mientras
 * siga siendo una copia, este candado es lo que impide que se desvíe en silencio.
 *
 * ⚠️ **El defecto de fondo que lo hace necesario:** el UPSERT es *churn-free* y escribe
 * `computed_at`/`updated_at` **sólo cuando la fila cambia**. O sea **no hay señal de frescura por
 * fila**: una fila de hace dos días puede ser *"correcta y sin cambios"* o *"abandonada y vieja"*,
 * y son **indistinguibles** desde la tabla. La única forma de saberlo es comparar contra la fuente
 * — que es lo que hace este archivo.
 *
 * ⛔ Lo que NO hace: arreglar nada. Mide y se pone rojo.
 *
 * ⚠️ El bloque 3 mide la COPIA y **declara** en vez de fallar, porque desde `[ET.3]` el defecto ya
 * no llega a un humano: la etiqueta toma el precio del ERP en vivo. Lo que ahí se asegura con un
 * FAIL es la otra mitad —**que el lector siga yendo a la fuente**— con un guard de código: si
 * alguien revierte eso, la tabla se seguiría viendo igual de sana y nada más lo notaría.
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

// Baselines MEDIDOS contra prod el 2026-09-14. Pueden BAJAR; si suben, la copia se está
// desviando de su fuente y alguien está imprimiendo un precio que el ERP ya no tiene.
const MAX_DIFIEREN = 40;      // medido: 17
const MAX_FANTASMA = 150;     // medido: 64
const MAX_HUECO_VIVO = 2000;  // medido: 1,492 (producto vivo en el catálogo y sin etiqueta)

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n ?? 0).toLocaleString('en-US');

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  console.log('\n=== CANDADO: la etiqueta y el mostrador contra su fuente (ET.2) ===\n');

  const vivo = (await q(`SELECT to_regclass('kepler_ods.kdii') t`))[0].t;
  if (!vivo) {
    nomedido('todo el candado', 'kepler_ods.kdii no es alcanzable desde esta DB');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  const CTES = `
    WITH ods AS (
      SELECT btrim(sucursal::text) AS suc, btrim(c1) AS sku,
             NULLIF(regexp_replace(c90::text, '[^0-9.]', '', 'g'), '')::numeric AS c90
        FROM kepler_ods.kdii
       WHERE btrim(coalesce(c1, '')) <> ''),
    lp AS (
      SELECT l.sucursal AS suc, btrim(p.sku) AS sku, p.id AS pid, p.deleted_at,
             l.piece_price, l.updated_at
        FROM commercial.product_label_prices l
        JOIN catalog.products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
       WHERE l.tenant_id = $1)`;

  // ── 1. ⭐ El precio de la etiqueta contra el del ERP ───────────────────────────────────────
  console.log('── 1. ⭐ El precio publicado contra kepler_ods.kdii.c90 ──');
  const [d] = await q(`${CTES}
    SELECT count(*) FILTER (WHERE o.sku IS NOT NULL AND lp.piece_price IS NOT NULL
             AND o.c90 IS NOT NULL AND abs(lp.piece_price - o.c90) >= 0.005)::int AS difieren,
           count(*) FILTER (WHERE o.sku IS NULL)::int AS fantasma,
           count(*)::int AS filas,
           round(max(abs(lp.piece_price - o.c90)) FILTER (WHERE o.c90 IS NOT NULL)::numeric, 2) AS peor_dif
      FROM lp LEFT JOIN ods o ON o.suc = lp.suc AND o.sku = lp.sku`, [T]);
  console.log(`     ${N(d.filas)} filas · DIFIEREN ${N(d.difieren)} (peor $${d.peor_dif})`
    + ` · fantasma ${N(d.fantasma)}`);
  check('⭐ el precio de la etiqueta no se desvía del ERP',
    Number(d.difieren) <= MAX_DIFIEREN,
    `${N(d.difieren)} filas contra un baseline de ${MAX_DIFIEREN}. Cada una es un precio que se `
    + 'imprime en papel o se muestra en el mostrador y que el ERP ya no tiene');
  check('las filas FANTASMA (que el ODS ya no tiene) no crecen',
    Number(d.fantasma) <= MAX_FANTASMA,
    `${N(d.fantasma)} contra ${MAX_FANTASMA}. El merge es UPSERT sin DELETE: una fila que deja de `
    + 'existir en el ERP se queda para siempre con su último precio');

  // ── 2. ⭐ El hueco: el ERP tiene precio y no hay etiqueta ──────────────────────────────────
  console.log('\n── 2. ⭐ Productos con precio en el ERP y SIN etiqueta ──');
  const [h] = await q(`${CTES},
    falta AS (
      SELECT o.suc, o.sku FROM ods o
       LEFT JOIN lp ON lp.suc = o.suc AND lp.sku = o.sku
       WHERE o.c90 > 0.05 AND lp.sku IS NULL)
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE p.id IS NOT NULL AND p.deleted_at IS NULL)::int AS producto_vivo,
           count(*) FILTER (WHERE p.id IS NULL)::int AS sku_fuera_del_catalogo
      FROM falta LEFT JOIN catalog.products p
             ON p.tenant_id = $1 AND btrim(p.sku) = falta.sku`, [T]);
  console.log(`     faltan ${N(h.filas)} · con producto VIVO en el catálogo ${N(h.producto_vivo)}`
    + ` · SKU fuera del catálogo ${N(h.sku_fuera_del_catalogo)}`);
  check('⭐ el hueco de productos vivos sin etiqueta no crece',
    Number(h.producto_vivo) <= MAX_HUECO_VIVO,
    `${N(h.producto_vivo)} contra ${MAX_HUECO_VIVO}: productos que el ERP cotiza y que la `
    + 'etiquetera y el mostrador no pueden mostrar');
  console.log('     ⚠️  Los que están fuera del catálogo NO son un defecto de la etiquetera: no hay');
  console.log('        product_id al que colgarlos. Es cobertura de catálogo, y se declara acá');
  console.log('        para que no se confunda con lo anterior.');

  // ── 3. ⭐⭐ El precio que cae a CERO en el ERP y sobrevive en la etiqueta ──────────────────
  console.log('\n── 3. ⭐⭐ El ERP bajó el precio a cero y la etiqueta lo conserva ──');
  const [z] = await q(`${CTES}
    SELECT count(*)::int AS filas,
           round(sum(lp.piece_price)::numeric, 2) AS suma_publicada
      FROM lp JOIN ods o ON o.suc = lp.suc AND o.sku = lp.sku
     WHERE COALESCE(o.c90, 0) <= 0.05 AND lp.piece_price > 0.05`, [T]);
  console.log(`     ${N(z.filas)} filas de la COPIA conservan un precio que el ERP dejó en 0`
    + ` ($${z.suma_publicada})`);
  console.log('     ⬜ DECLARADO, no FAIL: la copia efectivamente las conserva (el cómputo filtra');
  console.log('        `c90 > 0.05` y el merge no borra), pero desde [ET.3] **ninguna interfaz las');
  console.log('        publica**: la etiqueta toma el precio del ERP en vivo y dice SIN PRECIO');
  console.log('        cuando no lo cotiza; el verificador ya leía kdii. Lo que sigue abierto es');
  console.log('        la copia misma, y eso lo cierra la vista derive-no-copy.');

  // ⭐ EL CANDADO DE VERDAD ES DE CÓDIGO: que el lector siga yendo a la FUENTE.
  // Si alguien revierte [ET.3] y la etiqueta vuelve a imprimir `l.piece_price` de la copia, esas
  // filas vuelven al papel y nada más lo notaría — la tabla se vería igual de "sana".
  const fs = require('fs');
  const path = require('path');
  const svc = path.join(process.cwd(), 'libs', 'commercial', 'src', 'lib',
    'commercial-labels', 'commercial-labels.service.ts');
  if (!fs.existsSync(svc)) {
    nomedido('el guard de código de la etiquetera', `no encuentro ${svc}`);
  } else {
    // Se comparan sólo las líneas de CÓDIGO: un comentario que cite `kepler_ods.kdii` haría pasar
    // el guard sin que nadie lea la fuente. Ya pasó en esta sesión con otro grep.
    const codigo = fs.readFileSync(svc, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // `[ETQ-ODS.1]` Antes esto exigía el join literal a `kepler_ods.kdii` y la función
    // `precioVivoDe()`. Las dos desaparecieron, y NO porque se revirtiera el candado: ahora TODO
    // sale de `analytics.v_label_prices`, que es la vista derive-no-copy sobre ese mismo `kdii`.
    // El guard viejo afirmaba una IMPLEMENTACIÓN; éste afirma la PROPIEDAD.
    const leeVista = /analytics\.v_label_prices/.test(codigo);
    const leeCopia = /commercial\.product_label_prices/.test(codigo);
    check('⭐⭐ la etiquetera lee de la VISTA derivada, y ya no de la copia',
      leeVista && !leeCopia,
      `lee analytics.v_label_prices: ${leeVista} · todavía menciona la copia: ${leeCopia}`
      + ' — sin esto la etiqueta vuelve a imprimir el último precio conocido de la copia, que'
      + ' sobrevive aunque el ERP lo haya retirado');

    // ⭐ Y el grep NO alcanza: un nombre en el código no prueba que del otro lado haya una vista
    // sobre el ODS. Podría ser una TABLA con ese nombre, poblada por otro importer, y el candado
    // se pondría verde igual. Se pregunta a la base qué es y de qué deriva.
    const vd = await q(`SELECT c.relkind::text AS kind
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'analytics' AND c.relname = 'v_label_prices'`);
    if (!vd.length) {
      nomedido('la fuente de la etiquetera es una vista sobre el ODS',
        'analytics.v_label_prices no existe en esta DB');
    } else {
      const def = (await q(
        `SELECT pg_get_viewdef('analytics.v_label_prices'::regclass, true) AS d`))[0].d || '';
      const esVista = vd[0].kind === 'v';
      const deriva = /kepler_ods\.kdii/.test(def) && /kepler_ods\.kdpv_prod_util/.test(def);
      check('⭐⭐ y esa fuente es una VISTA que deriva del ODS, no otra copia',
        esVista && deriva,
        `relkind=${vd[0].kind} (v=vista) · la definición cita kdii y kdpv_prod_util: ${deriva}`
        + ' — si alguien la materializa como tabla, la etiqueta vuelve a tener dos frescuras');
    }
  }

  // ── 4. La copia no tiene dato propio → debería ser una VISTA ──────────────────────────────
  console.log('\n── 4. ¿La copia tiene algo que NO se pueda derivar? ──');
  const fuentes = await q(`
    SELECT COALESCE(source, '(null)') AS source, count(*)::int AS filas
      FROM commercial.product_label_prices WHERE tenant_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [T]);
  console.log(`     ${fuentes.map((r) => `${r.source}:${N(r.filas)}`).join(' · ')}`);
  const propias = fuentes.filter((r) => r.source === 'manual').reduce((s, r) => s + Number(r.filas), 0);
  console.log(`     filas con dato PROPIO (source='manual'): ${N(propias)}`);
  if (propias === 0) {
    console.log('     ⬜ CERO. Por la regla principal esto debería ser una VISTA derive-no-copy');
    console.log('        sobre kepler_ods, no una tabla que un importer mantiene. Mientras siga');
    console.log('        siendo copia, los bloques 1-3 son lo único que impide que se desvíe.');
  }
  check('el candado sabe si la copia tiene dato propio (la respuesta cambia el veredicto)',
    fuentes.length > 0, 'la tabla está vacía');

  // ── 5. Lo que este candado NO mide ────────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⛔ Los ESCALONES de mayoreo contra kdpv_prod_util. Se arreglaron aparte (ET.1:');
  console.log('        se publicaba el escalón más profundo y no el primero alcanzable) y su');
  console.log('        verificación vive en esa medición, no acá.');
  console.log('     ⚠️  No hay señal de FRESCURA por fila: el UPSERT es churn-free y sólo toca');
  console.log('        `updated_at` cuando la fila cambia, así que "fresca y sin cambios" y');
  console.log('        "abandonada" se ven igual. Por eso este candado compara contra la fuente en');
  console.log('        vez de mirar una marca de tiempo.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
