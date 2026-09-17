/* eslint-disable no-console */
/**
 * EMB.0 smoke — la cabecera logística del embarque Kepler (U-D-41) llega a la Suite.
 *
 * Cubre las cuatro trampas que la migración `20260917120000` desarma, y cada una con la
 * prueba NEGATIVA correspondiente — porque un candado sin prueba negativa es una intención:
 *
 *   1. NO DUPLICACIÓN. Los catálogos de Kepler tienen la misma unidad dada de alta dos veces
 *      (`00018` y `018`). Si alguien cambia el resolvedor por un LEFT JOIN crudo, la vista
 *      multiplica embarques. Se compara contra la fuente, no contra sí misma.
 *   2. RESOLUCIÓN DEL TRANSPORTE. Documento y catálogo rellenan los ceros distinto; sin
 *      normalizar sólo resuelve el 27%. Se exige 100% de lo que trae código.
 *   3. EL DECODE, contra un hecho independiente. La fila UD4101-0000713 de la suc 06 es la
 *      de la captura de pantalla de Kepler que cerró el decode; si alguien reasigna c83/c84/
 *      c86 a otra columna, esta aserción es la que se rompe.
 *   4. LO QUE FALTA SE DECLARA. `chofer_sin_capturar` y `*_ambiguo` tienen que existir y
 *      valer true en algún lado: una bandera que nunca se enciende no está midiendo nada.
 *
 * Uso:  node database/tests/test-newdb-erp-shipment-headers.js
 *       DATABASE_URL_NEW=<url>  (o --prod para leer FLEET_DB_URL)
 */
require('dotenv').config();
const { Client } = require('pg');
const { correr, noMedido } = require('./_lib/no-medido');

const PROD = process.argv.includes('--prod');
const URL = PROD ? process.env.FLEET_DB_URL : process.env.DATABASE_URL_NEW;

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

const n = (v) => Number(v ?? 0);

correr(async () => {
  if (!URL) noMedido(`falta ${PROD ? 'FLEET_DB_URL' : 'DATABASE_URL_NEW'} en el entorno`);
  const db = new Client({ connectionString: URL, ssl: PROD ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const q = async (sql, args) => (await db.query(sql, args)).rows;

  try {
    const [{ db: dbname }] = await q('SELECT current_database() AS db');
    console.log(`\n=== EMB.0 — cabecera de embarque Kepler · destino ${dbname} ===\n`);

    // ── 0. Las cuatro relaciones existen y son VISTAS (no una tabla copiada) ──────────────
    console.log('── 0. Contrato: son vistas en vivo, no copias');
    const rels = await q(`
      SELECT c.relname, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'analytics' AND c.relname IN
        ('v_kepler_transporte','v_kepler_chofer','erp_shipment_headers','erp_shipment_trips')`);
    if (rels.length === 0) noMedido('las vistas de EMB.0 no están en este destino (migración sin aplicar)');
    assert(rels.length === 4, `las 4 relaciones existen (${rels.length})`);
    assert(rels.every((r) => r.kind === 'v'),
      'las 4 son VISTAS — si alguna fuera tabla habría vuelto el lag de batch que EMB.0 evita');

    // ── 1. NO DUPLICACIÓN: la vista cuadra con la fuente, fila por fila ───────────────────
    console.log('\n── 1. No duplicación (la trampa de las altas repetidas en el catálogo)');
    const [par] = await q(`
      SELECT (SELECT count(*) FROM analytics.erp_shipment_headers) AS vista,
             (SELECT count(DISTINCT (sucursal, serie, folio)) FROM analytics.erp_shipment_headers) AS llaves,
             (SELECT count(DISTINCT (btrim(c1),(c5)::int,btrim(c6::text))) FROM kepler_ods.kdm1
               WHERE c2='U' AND c3='D' AND (c4)::int=41 AND btrim(c1)=btrim(sucursal)) AS fuente`);
    if (n(par.fuente) === 0) noMedido('no hay embarques U-D-41 en kepler_ods.kdm1 de este destino');
    assert(n(par.vista) === n(par.llaves),
      `1 fila por (sucursal, serie, folio) — ${par.vista} filas, ${par.llaves} llaves`);
    assert(n(par.vista) === n(par.fuente),
      `la vista NO inventa ni pierde documentos: ${par.vista} = ${par.fuente} en kdm1`);

    // ── 2. RESOLUCIÓN: la normalización de ceros funciona ────────────────────────────────
    console.log('\n── 2. Resolución contra el catálogo (la trampa del relleno de ceros)');
    const [res] = await q(`
      SELECT count(*) FILTER (WHERE transporte_code IS NOT NULL) AS con_codigo,
             count(*) FILTER (WHERE transporte_code IS NOT NULL AND transporte_resuelto) AS resueltos,
             count(*) FILTER (WHERE transporte_placas IS NOT NULL) AS con_placas,
             count(*) FILTER (WHERE chofer_code IS NOT NULL AND NOT chofer_resuelto) AS chofer_sin_resolver
      FROM analytics.erp_shipment_headers`);
    assert(n(res.con_codigo) > 0, `hay embarques con unidad asignada (${res.con_codigo})`);
    assert(n(res.resueltos) === n(res.con_codigo),
      `el 100% de las unidades resuelve contra kdm_transporte (${res.resueltos}/${res.con_codigo}) — sin normalizar los ceros esto cae a ~27%`);
    assert(n(res.con_placas) > 0, `la placa llega desde el catálogo (${res.con_placas} filas)`);
    assert(n(res.chofer_sin_resolver) === 0,
      `ningún chofer capturado queda sin resolver (${res.chofer_sin_resolver})`);

    // ── 2a. EMB.0.1: el código LITERAL manda sobre el normalizado ────────────────────────
    // Normalizar siempre atribuía mal 582 de 3,870 embarques con chofer (15%), porque el
    // espacio de claves cortas de Kepler es local a la sucursal y está reusado.
    console.log('\n── 2a. Precedencia exacto > normalizado (la corrección EMB.0.1)');
    const [met] = await q(`
      SELECT count(*) FILTER (WHERE chofer_metodo = 'sin_resolver') AS ch_perdidos,
             count(*) FILTER (WHERE transporte_metodo = 'sin_resolver') AS tr_perdidos,
             count(*) FILTER (WHERE chofer_metodo = 'exacto') AS ch_exacto,
             count(*) FILTER (WHERE transporte_metodo = 'normalizado') AS tr_normalizado
      FROM analytics.erp_shipment_headers`);
    assert(n(met.ch_perdidos) === 0 && n(met.tr_perdidos) === 0,
      `nada queda en 'sin_resolver' (chofer ${met.ch_perdidos}, unidad ${met.tr_perdidos})`);
    assert(n(met.ch_exacto) > 0 && n(met.tr_normalizado) > 0,
      `los DOS métodos se usan de verdad (${met.ch_exacto} exactos, ${met.tr_normalizado} normalizados) — si uno cayera a cero, la precedencia dejó de existir`);

    // Ancla exacta de la corrección: en la suc 05, el chofer `09` es BENJAMIN ALONZO
    // ZARAGOZA; el `00009` de todas las ramas es MARIA CANDELARIA SALGADO MORALES. Con el
    // normalizado ciego estos embarques decían "MARIA".
    const benja = await q(`
      SELECT DISTINCT chofer_nombre, chofer_metodo FROM analytics.erp_shipment_headers
      WHERE sucursal='05' AND chofer_code='09'`);
    if (benja.length === 0) {
      console.log('  ⓘ la suc 05 no tiene embarques con chofer 09 en este destino — no se comprueba el ancla acá');
    } else {
      assert(benja.length === 1 && /BENJAMIN/i.test(benja[0].chofer_nombre || ''),
        `suc 05 chofer 09 → BENJAMIN (no MARIA, que es el 00009) — vino ${benja.map((b) => b.chofer_nombre).join(', ')}`);
      assert(benja[0].chofer_metodo === 'exacto',
        'y se resolvió por código exacto, que es lo que lo hace correcto');
    }

    // ── 2b. PRUEBA NEGATIVA del resolvedor: sin normalizar, el match se desploma ──────────
    const [neg] = await q(`
      WITH e AS (
        SELECT btrim(c1) suc, NULLIF(btrim(c83::text),'') crudo
        FROM kepler_ods.kdm1
        WHERE c2='U' AND c3='D' AND (c4)::int=41 AND btrim(c1)=btrim(sucursal)
          AND NULLIF(btrim(c83::text),'') IS NOT NULL)
      SELECT count(*) total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM kepler_ods.kdm_transporte t
               WHERE btrim(t.sucursal)=e.suc AND btrim(t.c1)=e.crudo)) AS literal
      FROM e`);
    assert(n(neg.literal) < n(neg.total),
      `prueba negativa: con igualdad literal sólo resolvería ${neg.literal}/${neg.total} — la normalización es la que hace el trabajo, no el azar`);

    // ── 3. EL DECODE, contra la captura de pantalla de Kepler ─────────────────────────────
    console.log('\n── 3. Decode anclado a un hecho independiente (captura UD4101-0000713)');
    const [arb] = await q(`
      SELECT * FROM analytics.erp_shipment_headers
      WHERE sucursal='06' AND serie=1 AND folio='0000713'`);
    if (!arb) {
      console.log('  ⓘ la fila árbitro no está en este destino (espejo con rezago) — no se comprueba el decode acá');
    } else {
      assert(arb.transporte_code === '00017', `transporte = 00017 (pantalla: "Transporte Asignado 00017") — vino ${arb.transporte_code}`);
      assert(arb.transporte_placas === 'NC-1134-D', `placas NC-1134-D desde el catálogo — vino ${arb.transporte_placas}`);
      assert(arb.chofer_code === '00017', `chofer = 00017 (pantalla: "Chofer 00017") — vino ${arb.chofer_code}`);
      assert(/CESAR CASAS/i.test(arb.chofer_nombre || ''), `chofer resuelto a CESAR CASAS MENDOZA — vino ${arb.chofer_nombre}`);
      assert(arb.guia_embarque === '0001295', `guía de embarque = 0001295 (pantalla) — vino ${arb.guia_embarque}`);
      assert(arb.resp_surtido === '01' && arb.resp_checado === '01' && arb.resp_embarque === '01',
        `responsables surtido/checado/embarque = 01/01/01 (pantalla) — vino ${arb.resp_surtido}/${arb.resp_checado}/${arb.resp_embarque}`);
      assert(Number(arb.total) === 12006.29, `IMPORTE 12,006.29 (pantalla) — vino ${arb.total}`);
      assert(arb.pedido_folio === '0000738', `pedido padre UD4001-0000738 (pantalla) — vino ${arb.pedido_folio}`);
      assert(/telemarketing/i.test(arb.serie_label || ''),
        `la etiqueta de la serie sale de kdmm, no de un CASE quemado — "${arb.serie_label}"`);
    }

    // ── 4. LO QUE FALTA SE DECLARA (y las banderas de verdad se encienden) ────────────────
    console.log('\n── 4. Los huecos se declaran, no se disfrazan');
    const [dec] = await q(`
      SELECT count(*) FILTER (WHERE chofer_sin_capturar) AS sin_chofer,
             count(*) FILTER (WHERE ruta_declarada IS NOT NULL) AS con_ruta,
             count(*) FILTER (WHERE NOT fecha_pago_valida) AS pago_inconsistente,
             count(*) AS total
      FROM analytics.erp_shipment_headers`);
    assert(n(dec.sin_chofer) > 0,
      `el chofer sin capturar se DECLARA en vez de inventarse (${dec.sin_chofer} de ${dec.total})`);
    assert(n(dec.con_ruta) === 0,
      'ruta_declarada va NULL: kdm1 no referencia kdm_rutas y la vista no lo simula');
    assert(n(dec.pago_inconsistente) > 0,
      `la fecha de pago que se contradice queda marcada, no silenciada (${dec.pago_inconsistente})`);

    const [amb] = await q(`SELECT count(*) FILTER (WHERE ambiguo) AS ambiguos, count(*) AS total FROM analytics.v_kepler_chofer`);
    assert(n(amb.ambiguos) > 0,
      `el resolvedor denuncia las claves ambiguas del catálogo (${amb.ambiguos} de ${amb.total}) — una bandera que nunca enciende no mide nada`);

    // ── 5. EL VIAJE: la guía agrupa las paradas ───────────────────────────────────────────
    console.log('\n── 5. El viaje (guía) contra la parada (embarque)');
    const [trips] = await q(`
      SELECT (SELECT count(*) FROM analytics.erp_shipment_trips) AS viajes,
             (SELECT coalesce(sum(paradas),0) FROM analytics.erp_shipment_trips) AS paradas,
             (SELECT count(*) FROM analytics.erp_shipment_headers WHERE guia_embarque IS NOT NULL) AS con_guia,
             (SELECT max(paradas) FROM analytics.erp_shipment_trips) AS max_paradas,
             (SELECT count(*) FROM analytics.erp_shipment_trips WHERE multi_chofer) AS multi_chofer`);
    assert(n(trips.paradas) === n(trips.con_guia),
      `ninguna parada se pierde al agrupar: ${trips.paradas} = ${trips.con_guia}`);
    assert(n(trips.viajes) < n(trips.con_guia),
      `la guía agrupa de verdad: ${trips.viajes} viajes para ${trips.con_guia} paradas (máx ${trips.max_paradas} en una) — mapear 1 embarque = 1 shipment inventaría ${n(trips.con_guia) - n(trips.viajes)} viajes`);
    assert(n(trips.multi_chofer) === 0,
      `el viaje lleva un solo chofer, que es lo que justifica el grano (${trips.multi_chofer} excepciones)`);

    // ── 6. LA FLOTA: del embarque a la unidad de la Suite y a su GPS ─────────────────────
    console.log('\n── 6. Embarque → unidad → GPS (EMB.5/EMB.6)');
    const tieneCol = await q(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='analytics' AND table_name='erp_shipment_headers' AND column_name='vehicle_id'`);
    if (tieneCol.length === 0) {
      console.log('  ⓘ sin vehicle_id en este destino (mig 20260917160000 sin aplicar) — no se comprueba la flota acá');
    } else {
      // ⛔ Una unidad física, UNA fila. El defecto que EMB.5 arregló fue tener la camioneta dos
      // veces porque Kepler escribe 'GA-2027-C' y MagniTracking 'GA2027C': el GPS colgaba de
      // una fila y la clave de Kepler de la otra.
      const [dup] = await q(`
        SELECT count(*) AS pares FROM (
          SELECT regexp_replace(upper(btrim(plate)),'[^A-Z0-9]','','g') pn
            FROM logistics.vehicles WHERE deleted_at IS NULL AND btrim(coalesce(plate,'')) <> ''
           GROUP BY 1 HAVING count(*) > 1) x`);
      assert(n(dup.pares) === 0,
        `ninguna placa está dos veces con distinta puntuación (${dup.pares} pares) — así volvieron a juntarse el GPS y la clave de Kepler`);

      const [flota] = await q(`
        SELECT count(DISTINCT transporte_clave_kepler) AS unidades,
               count(DISTINCT transporte_clave_kepler) FILTER (WHERE vehicle_id IS NOT NULL) AS en_flota
          FROM analytics.erp_shipment_headers
         WHERE fecha >= current_date - 90 AND transporte_clave_kepler IS NOT NULL`);
      assert(n(flota.en_flota) > 0 && n(flota.en_flota) <= n(flota.unidades),
        `${flota.en_flota} de ${flota.unidades} unidades que embarcan resuelven a una fila de logistics.vehicles`);

      // El NULL viaja crudo a propósito: "no tiene rastreador" y "no se pudo resolver" son
      // hechos distintos y el consumidor tiene que poder separarlos.
      const [gps] = await q(`
        SELECT count(*) AS con_gps FROM (
          SELECT DISTINCT h.vehicle_id FROM analytics.erp_shipment_headers h
            JOIN logistics.trackers t ON t.vehicle_id = h.vehicle_id AND t.deleted_at IS NULL
           WHERE h.fecha >= current_date - 90 AND h.vehicle_id IS NOT NULL) x`);
      assert(n(gps.con_gps) > 0,
        `${gps.con_gps} unidades que embarcaron tienen rastreador alcanzable — antes de la fusión eran 3`);

      const [tr] = await q(`
        SELECT count(*) AS viajes, count(vehicle_id) AS con_unidad FROM analytics.erp_shipment_trips`);
      assert(n(tr.con_unidad) > 0 && n(tr.con_unidad) <= n(tr.viajes),
        `el viaje también trae la unidad (${tr.con_unidad} de ${tr.viajes})`);
    }

    // ── 7. QUÉ LLEVA: los renglones del embarque (EMB.7) ─────────────────────────────────
    console.log('\n── 7. Qué lleva el camión (EMB.7)');
    const hayLineas = await q(`SELECT relkind::text AS k FROM pg_class WHERE oid = to_regclass('analytics.erp_shipment_lines')`);
    if (hayLineas.length === 0) {
      console.log('  ⓘ analytics.erp_shipment_lines no está en este destino — no se comprueba acá');
    } else {
      assert(hayLineas[0].k === 'v', 'los renglones son una vista en vivo, no una copia');

      // ⛔ CONTRATO DE COSTO (EMB.7.1). La vista NO debe unir el resolvedor de unidad:
      // `v_warehouse_box_factor`/`v_unit_truth` se materializan enteros (11,246 filas) y con
      // el join, pedir UN documento —lo que hace un clic— costaba 1,189 ms contra 157 ms sin él.
      // Si alguien "simplifica" volviendo a meterlo en la vista, esta aserción es la que avisa.
      const [{ tiene }] = await q(`
        SELECT count(*)::int AS tiene FROM information_schema.columns
         WHERE table_schema='analytics' AND table_name='erp_shipment_lines'
           AND column_name IN ('cajas','factor_caja','unidad_veredicto')`);
      assert(n(tiene) === 0,
        'la vista de renglones NO une el resolvedor de unidad — lo resuelve el servicio aparte (con el join, un clic costaba 1,189 ms)');

      const arb = await q(`
        SELECT nro_linea, sku, cantidad, unidad, importe
          FROM analytics.erp_shipment_lines
         WHERE sucursal='06' AND serie=1 AND folio='0000713' ORDER BY nro_linea`);
      if (arb.length === 0) {
        console.log('  ⓘ el documento árbitro no tiene renglones en este destino');
      } else {
        const l1 = arb[0];
        assert(l1.sku === '70168' && Number(l1.cantidad) === 24 && l1.unidad === 'PAQ',
          `renglón 1 = 24 PAQ del SKU 70168 — vino ${l1.cantidad} ${l1.unidad} de ${l1.sku}`);
        assert(Number(l1.importe) === 1350.96,
          `y su importe es 1,350.96, el MISMO que muestra Kepler pintando "1 CJA" — vino ${l1.importe}`);

        // El resolvedor canónico es el que convierte 24 PAQ en la caja que ve el almacenista.
        const [f] = await q(`
          SELECT box_factor, box_label FROM analytics.v_warehouse_box_factor
           WHERE warehouse_code='06' AND sku='70168' LIMIT 1`);
        if (!f) console.log('  ⓘ el resolvedor de unidad no cubre 70168 en la suc 06 en este destino');
        else assert(Number(f.box_factor) === 24,
          `24 PAQ = 1 ${f.box_label || 'CJA'} según v_warehouse_box_factor — así la pantalla dice lo mismo que Kepler`);

        // ⚠️ Lo que NO se puede afirmar: la suma de renglones NO es el total del documento.
        const suma = arb.reduce((a, r) => a + Number(r.importe || 0), 0);
        const [h] = await q(`SELECT total FROM analytics.erp_shipment_headers WHERE sucursal='06' AND serie=1 AND folio='0000713'`);
        assert(Math.abs(suma - Number(h.total)) > 1,
          `la suma de renglones (${suma.toFixed(2)}) NO reproduce el total de la cabecera (${h.total}) — está medido y sin decodificar (EMB.10); la pantalla no debe presentarla como el total`);
      }
    }

    console.log(`\n✅ EMB: ${assertions} aserciones, 0 fallas.\n`);
  } finally {
    await db.end();
  }
});
