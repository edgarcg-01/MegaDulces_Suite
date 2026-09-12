/* eslint-disable no-console */
/**
 * `[CV.26]` — Lo que el verificador de precios publica, contra lo que Kepler dice.
 *
 * Tres preguntas, una por cosa que se ve en el mostrador:
 *   1. ¿el PRECIO de pieza es el de ESA tienda?
 *   2. ¿el MAYOREO (pieza y paquete) es el de ESA tienda?
 *   3. ¿los CÓDIGOS DE BARRAS resuelven al producto y a la unidad correctos?
 *
 * ── ⚠️ Lo esperado NO se re-deriva acá: se importa ───────────────────────────
 * La primera versión de este test reescribía la regla del mayoreo en SQL ("el escalón
 * más barato con umbral real, de esa presentación") y reportó **675 de 9,097
 * divergencias (7.42%)** que NO eran defectos: `assembleLabel` sólo guarda el mayoreo de
 * pieza cuando la presentación base del producto ES pieza, y a los de base agrupada
 * (PAQ, CJA, `500`, KG…) les pone NULL a propósito. El SQL los comparaba igual.
 *
 * Es el modo de falla que el proyecto ya tiene escrito: una copia de la regla se
 * desincroniza de la regla. Ahora se llaman `computeLabels` y `computeBarcodes` —los
 * MISMOS que corren el hop-2 y el reconciliador— y se compara campo por campo. Si la
 * regla cambia, el test la sigue solo.
 *
 * ── ⚠️ Tres veredictos, no dos ──────────────────────────────────────────────
 * `commercial.product_label_prices` gana grano por sucursal en `[NORM.3]` (migraciones
 * 20260911240000..240300). Sin esas migraciones la tabla guarda UNA fila por producto
 * con el precio elegido por `mode()` entre las ocho plazas, así que la divergencia por
 * plaza **es el defecto conocido**, no una regresión. En rojo sería una alarma que se
 * aprende a ignorar; en verde sería mentir. El test mira el esquema y decide:
 *
 *   · sin columna `sucursal` → `⬜ LÍNEA BASE` con la cifra. No falla.
 *   · con columna `sucursal` → `✔/✘`: exige CERO. Falla de verdad.
 *
 * Read-only. No escribe una sola fila.
 *
 *   node database/tests/test-newdb-verificador-precio-correcto.js       # prod
 *   TEST_DB_URL=... node database/tests/test-newdb-verificador-precio-correcto.js
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { computeLabels } = require('../../services/feeds-ingest/label-compute');
const { computeBarcodes } = require('../../services/feeds-ingest/barcode-compute');

const T = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
/**
 * Destino. `TEST_DB_URL` gana para poder apuntarlo a mano.
 *
 * ⚠️ No alcanza con borrar `FLEET_DB_URL` del entorno antes de requerir este archivo:
 * el `dotenv.config()` de arriba lo vuelve a cargar del `.env` y el test corre contra
 * prod creyendo que corre contra otra cosa. Pasó — y sólo se notó porque las cifras
 * salieron idénticas. Un test que no puede decir contra qué corrió no prueba nada; por
 * eso además imprime el destino.
 */
const DEST = process.env.TEST_DB_URL || process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;

let ok = 0; let mal = 0; let base = 0;
const fallidos = [];
const check = (n, cond, d) => {
  if (cond) { ok++; console.log(`  ✔ ${n}${d ? ` — ${d}` : ''}`); }
  else { mal++; fallidos.push(n); console.log(`  ✘ ${n}${d ? ` — ${d}` : ''}`); }
};
const linea = (n, d) => { base++; console.log(`  ⬜ ${n} — ${d}`); };
const nomedido = (n, m) => console.log(`  ○ NO MEDIDO — ${n}: ${m}`);
const num = (v) => (v == null ? null : Number(v));
const igual = (a, b) => {
  const x = num(a); const y = num(b);
  if (x == null && y == null) return true;
  if (x == null || y == null) return false;
  return Math.abs(x - y) < 0.005;   // centavos: la columna es numeric(14,4)
};

(async () => {
  if (!DEST) { console.error('Falta TEST_DB_URL/FLEET_DB_URL/DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({
    connectionString: DEST,
    ssl: /rlwy\.net|railway/i.test(DEST) ? { rejectUnauthorized: false } : false,
    statement_timeout: 300000,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);

  // Se dice contra QUÉ corrió, sin filtrar la credencial: host y base, nada más.
  // ⚠️ `new URL(...)` con una constante llamada `URL` tapa la clase global, y el error
  // que sale es `ENOTFOUND base`, que no se parece en nada a la causa.
  const d = new (require('url').URL)(DEST);
  console.log(`\nDestino: ${d.hostname}:${d.port || 5432}${d.pathname}`);

  const { rows: esq } = await c.query(
    `SELECT count(*) FILTER (WHERE column_name='sucursal')::int suc
       FROM information_schema.columns
      WHERE table_schema='commercial' AND table_name='product_label_prices'`);
  const PORPLAZA = esq[0].suc > 0;
  console.log('=== VERIFICADOR DE PRECIOS — lo publicado vs Kepler ===');
  console.log(`Grano de product_label_prices: ${PORPLAZA ? 'POR SUCURSAL (NORM.3 aplicado)' : 'CONSOLIDADO (NORM.3 pendiente)'}\n`);

  const juzgar = (n, divergentes, det) => (PORPLAZA ? check(n, divergentes === 0, det) : linea(n, det));

  // ── Lo esperado: el MISMO cómputo que corre en producción ──────────────────
  const esperados = await computeLabels(c, { schema: 'kepler_ods' });

  // ── Quién ESCRIBIÓ cada fila ────────────────────────────────────────────────
  // Se replica la resolución del reconciliador, y no una parecida: `sku → product_id`,
  // y si el SKU no está en el catálogo, **fallback por el barcode crudo**. El primer SKU
  // que reclama un producto se queda con TODAS sus plazas.
  //
  // Modelar sólo la mitad (sku → id) hacía que el test culpara al arreglo por plaza de
  // algo que no es suyo: un SKU que SÍ está en el catálogo puede encontrar su producto
  // ya tomado por otro que llegó antes por barcode, y entonces la etiqueta guardada es
  // la del otro. Eso no es "el precio no es el de la plaza" — es una colisión de
  // identidad, y merece su propio renglón.
  //
  // El orden importa: `ORDER BY (deleted_at IS NULL) ASC` deja a los vivos al final para
  // que GANEN el `set` (last-wins), igual que el importer.
  const { rows: prods } = await c.query(
    `SELECT id, btrim(coalesce(sku,'')) sku, btrim(coalesce(barcode,'')) barcode
       FROM catalog.products WHERE tenant_id = $1
      ORDER BY (deleted_at IS NULL) ASC`, [T]);
  const skuToId = new Map();
  const bcToId = new Map();
  for (const p of prods) {
    if (p.sku) skuToId.set(p.sku, p.id);
    if (p.barcode && !bcToId.has(p.barcode)) bcToId.set(p.barcode, p.id);
  }
  const resolver = (lab) => {
    const pid = skuToId.get(lab.sku);
    if (pid) return pid;
    const bc = String(lab.barcode_raw || '').trim();
    return bc ? bcToId.get(bc) : undefined;
  };
  const dueno = new Map();
  const colisionados = new Set();
  for (const lab of esperados) {
    const pid = resolver(lab);
    if (!pid) continue;
    if (!dueno.has(pid)) dueno.set(pid, lab.sku);
    else if (dueno.get(pid) !== lab.sku) colisionados.add(`${pid}|${lab.sku}`);
  }

  // Lo publicado.
  const { rows: pub } = await c.query(
    `SELECT product_id, ${PORPLAZA ? 'sucursal,' : ''} piece_price, wholesale_piece_price,
            wholesale_piece_min_qty, pack_price, pack_size, wholesale_pack_price,
            wholesale_pack_min_qty, unit_base, content
       FROM commercial.product_label_prices WHERE tenant_id = $1`, [T]);
  const guardado = new Map(pub.map((r) => [PORPLAZA ? `${r.product_id}|${r.sucursal}` : String(r.product_id), r]));

  const CAMPOS = [
    ['precio de pieza', 'piece_price'],
    ['mayoreo de PIEZA', 'wholesale_piece_price'],
    ['umbral del mayoreo de pieza', 'wholesale_piece_min_qty'],
    ['precio del paquete', 'pack_price'],
    ['piezas por paquete', 'pack_size'],
    ['mayoreo de PAQUETE', 'wholesale_pack_price'],
    ['umbral del mayoreo de paquete', 'wholesale_pack_min_qty'],
  ];
  const dif = Object.fromEntries(CAMPOS.map(([, k]) => [k, 0]));
  const ejemplo = {};
  let comparados = 0; let sinFila = 0;

  for (const lab of esperados) {
    const pid = resolver(lab);
    if (!pid || dueno.get(pid) !== lab.sku) continue;       // el que no es dueño no escribió
    const fila = guardado.get(PORPLAZA ? `${pid}|${lab.sucursal}` : String(pid));
    if (!fila) { sinFila++; continue; }
    comparados++;
    for (const [, k] of CAMPOS) {
      if (!igual(fila[k], lab[k])) {
        dif[k]++;
        if (!ejemplo[k]) ejemplo[k] = `sku ${lab.sku} plaza ${lab.sucursal}: publicado ${fila[k]} vs Kepler ${lab[k]}`;
      }
    }
  }

  console.log(`── 1 y 2. Precio y mayoreo, campo por campo (${comparados} filas comparadas) ──`);
  for (const [etiqueta, k] of CAMPOS) {
    const pct = comparados ? ((100 * dif[k]) / comparados).toFixed(2) : '0';
    juzgar(`el ${etiqueta} publicado es el de la plaza`, dif[k],
      `${dif[k]} de ${comparados} (${pct}%)${dif[k] && ejemplo[k] ? ` · p.ej. ${ejemplo[k]}` : ''}`);
  }
  if (sinFila) linea('filas que Kepler tiene y la tabla no', `${sinFila}`);
  if (colisionados.size) {
    // ⚠️ Esto NO es un defecto del precio por plaza: es identidad. Dos SKUs de Kepler
    // caen en el mismo producto del catálogo (uno por su sku, otro por su barcode), y la
    // etiqueta que se guarda es la del que llegó primero. O sea que en pantalla puede
    // salir el precio de OTRO producto, y no hay nada que falle. Se declara con su cifra.
    linea('SKUs que resuelven a un producto ya tomado por otro SKU (colisión de identidad)',
      `${colisionados.size} — el primero se queda con todas sus plazas; el resto no escribe`);
  }

  // ── 3. Los códigos de barras ───────────────────────────────────────────────
  console.log('\n── 3. Códigos de barras: ¿resuelven al producto y a la unidad? ────');
  {
    const espBc = await computeBarcodes(c, { schema: 'kepler_ods' });
    const { rows: viv } = await c.query(
      `SELECT count(*)::int n FROM catalog.product_barcodes
        WHERE tenant_id = $1 AND deleted_at IS NULL AND source LIKE 'kepler%'`, [T]);

    // ⚠️ La pregunta correcta no es "¿está todo lo que Kepler declara?" sino "¿está todo
    // lo que Kepler declara Y tiene producto en el catálogo?". Los escritores unen por
    // `INNER JOIN catalog.products` a propósito (`[NORM.2]`): un barcode cuyo SKU no
    // existe es el huérfano que la migración retiró, y volver a meterlo desharía el
    // arreglo. Medido en prod: de 444 ausentes, 444 sin producto vivo y 0 con producto.
    const { rows: falt } = await c.query(`
      WITH e AS (SELECT * FROM unnest($2::text[], $3::text[]) AS x(sku, barcode)),
      ausentes AS (
        SELECT e.* FROM e
         WHERE NOT EXISTS (SELECT 1 FROM catalog.product_barcodes b
                            WHERE b.tenant_id=$1 AND b.deleted_at IS NULL
                              AND btrim(b.sku)=e.sku AND b.barcode=e.barcode))
      SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog.products p
               WHERE p.tenant_id=$1 AND btrim(p.sku)=a.sku AND p.deleted_at IS NULL))::int con_producto,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM catalog.products p
               WHERE p.tenant_id=$1 AND btrim(p.sku)=a.sku AND p.deleted_at IS NULL))::int sin_producto
        FROM ausentes a`,
      [T, espBc.map((x) => x.sku), espBc.map((x) => x.barcode)]);
    const f = falt[0];
    check('todo barcode de Kepler con producto en el catálogo está guardado',
      f.con_producto === 0, `${espBc.length} esperados · ${viv[0].n} vivos kepler_* · ausentes con producto: ${f.con_producto}`);
    linea('barcodes de Kepler cuyo SKU no existe en el catálogo (no se pueden escanear)', `${f.sin_producto}`);

    // La UNIDAD de cada código decide qué escalón se agranda (`[TDA.3]`). Con la unidad
    // cambiada, el mostrador muestra el mayoreo del otro peldaño.
    const { rows: uni } = await c.query(`
      SELECT count(*)::int n FROM unnest($2::text[], $3::text[], $4::text[]) AS e(sku, barcode, unit)
       JOIN catalog.product_barcodes b
         ON b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(b.sku)=e.sku AND b.barcode=e.barcode
      WHERE btrim(upper(coalesce(b.unit,''))) IS DISTINCT FROM btrim(upper(coalesce(e.unit,'')))`,
      [T, espBc.map((x) => x.sku), espBc.map((x) => x.barcode), espBc.map((x) => x.unit)]);
    check('la unidad guardada de cada código es la que dice Kepler', uni[0].n === 0, `${uni[0].n} con unidad distinta`);

    // La FK de `[NORM.2]`. Donde esa migración no corrió se DECLARA: una columna que no
    // existe no es "cero huérfanos".
    const { rows: tieneCol } = await c.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='catalog' AND table_name='product_barcodes' AND column_name='product_id'`);
    if (!tieneCol[0].n) nomedido('ningún código vivo apunta a la nada', 'falta la migración 20260911230000 (sin columna product_id)');
    else {
      const { rows: hu } = await c.query(
        `SELECT count(*)::int n FROM catalog.product_barcodes
          WHERE tenant_id=$1 AND deleted_at IS NULL AND product_id IS NULL`, [T]);
      check('ningún código vivo apunta a la nada', hu[0].n === 0, `${hu[0].n} sin product_id`);
    }
  }

  // ── 4. Cómo resuelve el verificador el código escaneado ────────────────────
  console.log('\n── 4. La resolución del código escaneado ──────────────────────────');
  {
    // `getPrecio` resuelve con un OR de 6 columnas de kdii más el sku. Un código que cae
    // en más de un SKU devuelve el primero por `ORDER BY`: el mostrador puede publicar el
    // precio de otro producto sin que nada falle. Es un defecto de CAPTURA en el ERP, no
    // del código — se declara con su cifra para que no se descubra por accidente.
    const { rows } = await c.query(`
      WITH codes AS (
        SELECT btrim(c7::text) code, btrim(c1::text) sku FROM kepler_ods.kdii WHERE btrim(coalesce(c7::text,''))<>''
        UNION ALL SELECT btrim(c82::text), btrim(c1::text) FROM kepler_ods.kdii WHERE btrim(coalesce(c82::text,''))<>''
        UNION ALL SELECT btrim(c85::text), btrim(c1::text) FROM kepler_ods.kdii WHERE btrim(coalesce(c85::text,''))<>''
        UNION ALL SELECT btrim(c93::text), btrim(c1::text) FROM kepler_ods.kdii WHERE btrim(coalesce(c93::text,''))<>''
        UNION ALL SELECT btrim(c95::text), btrim(c1::text) FROM kepler_ods.kdii WHERE btrim(coalesce(c95::text,''))<>''
        UNION ALL SELECT btrim(c96::text), btrim(c1::text) FROM kepler_ods.kdii WHERE btrim(coalesce(c96::text,''))<>'')
      SELECT count(*)::int codigos, count(*) FILTER (WHERE n > 1)::int ambiguos
        FROM (SELECT code, count(DISTINCT sku) n FROM codes WHERE code ~ '^[0-9]{6,}$' GROUP BY 1) z`);
    linea('códigos que caen en más de un SKU (el mostrador elegiría uno)',
      `${rows[0].ambiguos} de ${rows[0].codigos}`);
  }

  console.log(`\n${mal === 0 ? '✅' : '❌'} ${ok} OK · ${mal} FAIL · ${base} línea base`);
  if (mal) console.log(`   Fallaron: ${fallidos.join(' · ')}`);
  if (!PORPLAZA) {
    console.log('\n⬜ Las líneas base son el DEFECTO CONOCIDO, no una regresión: la tabla');
    console.log('   todavía guarda una fila por producto (la moda entre plazas). Al aplicar');
    console.log('   20260911240000..240300 este test pasa a EXIGIR cero divergencia.');
  }
  await c.end();
  process.exitCode = mal ? 1 : 0;
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
