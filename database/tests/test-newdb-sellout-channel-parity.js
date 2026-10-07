/* eslint-disable no-console */
/**
 * `[VSO.1]` CANDADO del CANAL del sell-out — que lo PUBLICADO concuerde con lo arbitrado.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────
 * El 2026-09-28, medido contra prod: el universo publicaba SEIS canales crudos y la pantalla
 * conocía CUATRO. `mayoreo` ($21,373,739 / 90 d) y `contado_nf` ($381,787) no tenían etiqueta, ni
 * casilla de filtro, ni hoja en el árbol Avanzado — y como el árbol arma un `cellFilter`, abrirlo y
 * elegir cualquier hoja **tiraba los $21.4M sin decir nada**.
 *
 * Ninguno de los dos candados que ya existían podía verlo: `test-newdb-sellout-parity.js` mide el
 * dedup Kepler↔Wincaja y `test-newdb-sellout-filter-sync.js` mide la atribución ruta→plaza. La
 * distancia entre el vocabulario REAL y el vocabulario PUBLICADO no estaba en ninguna lista — que
 * es, textual, la R7 de `docs/VERDAD_ABSOLUTA.md`.
 *
 * ── LAS CINCO PREGUNTAS ──────────────────────────────────────────────────────────────────────
 *  1. ¿El mapa explica TODO lo que el universo publica? (un canal crudo sin fila = dinero mudo)
 *  2. ¿Cada canal de negocio tiene UN rótulo y UN orden? (dos filas discrepando = la columna
 *     cambia de nombre según de qué ERP venga la venta)
 *  3. ¿`wincaja:credito` y `kepler:mayoreo` caen en el MISMO canal? Es la razón de existir del
 *     mapa: son la caja 70 "Mayoreo a credito" y la `U-D-8` "Factura Telemarketing", o sea el
 *     mismo canal a los dos lados del cutover. Separarlos vuelve a partir la columna Mayoreo.
 *  4. ¿El presupuesto sigue cubriendo el universo? `v_sales_entity` entra por INNER JOIN en
 *     `budget-sales-*`: un (canal, almacén) sin entidad no da error, **desaparece del real**.
 *  5. NEGATIVA: si se borra una fila del mapa, ¿el bloque 1 se pone rojo? Sin esto el bloque 1 es
 *     una intención, no una compuerta.
 *
 * ── TERCER ESTADO ────────────────────────────────────────────────────────────────────────────
 * Lo que no se puede medir se reporta `NO MEDIDO`, nunca ✔ (ADR-056). Acá aplica a un destino sin
 * el rollup poblado: "cero canales sin mapear" sería cierto y no probaría nada.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-sellout-channel-parity.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL || process.env.FLEET_DB_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW o FLEET_DB_URL'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);

  const dest = (await q(`SELECT current_database() d, (SELECT system_identifier FROM pg_control_system()) sid`))[0];
  console.log(`\n=== SELL-OUT · paridad del CANAL (base "${dest.d}" · sysid ${dest.sid}) ===\n`);

  const existe = async (rel) => (await q(`SELECT to_regclass($1) r`, [rel]))[0].r !== null;
  const hayMapa = await existe('analytics.sellout_channel_map');
  const hayCob = await existe('analytics.v_sellout_channel_coverage');
  console.log('0 · EL RESOLVEDOR EXISTE');
  check('analytics.sellout_channel_map existe', hayMapa);
  check('analytics.v_sellout_channel_coverage existe', hayCob);
  if (!hayMapa || !hayCob) {
    console.log('\n⛔ sin el resolvedor no hay nada que medir — aplicá 20260928190000_sellout_channel_map.js');
    await c.end(); process.exit(1);
  }

  const universo = Number((await q(`SELECT count(*)::int n FROM analytics.mv_sellout_monthly`))[0].n);

  // ── 1. El mapa explica TODO lo que el universo publica ────────────────────────────────────
  console.log('\n1 · COBERTURA (un canal crudo sin fila en el mapa es dinero mudo)');
  if (!universo) {
    noMedido('el mapa cubre el universo',
      'analytics.mv_sellout_monthly está vacío en este destino. Con el rollup vacío "cero canales sin mapear" es cierto y no prueba nada.');
  } else {
    const huerfanos = await q(
      `SELECT source, raw_channel, monto_total FROM analytics.v_sellout_channel_coverage
        WHERE NOT mapeado ORDER BY monto_total DESC`);
    check('todo (source, canal) del universo tiene fila en el mapa', huerfanos.length === 0,
      huerfanos.map((h) => `${h.source}:${h.raw_channel} ${money(h.monto_total)}`).join(' · '));
    const cubiertos = await q(`SELECT count(*)::int n FROM analytics.v_sellout_channel_coverage WHERE mapeado`);
    console.log(`  ⓘ ${cubiertos[0].n} combinaciones (source, canal) mapeadas sobre ${universo.toLocaleString('en-US')} filas de rollup`);
  }

  // ── 2. Un canal de negocio, un rótulo, un orden ───────────────────────────────────────────
  console.log('\n2 · COHERENCIA (mismo canal ⇒ mismo rótulo y mismo orden)');
  const incoh = await q(
    `SELECT canonical_channel, count(DISTINCT label) labels, count(DISTINCT orden) ordenes,
            string_agg(DISTINCT label, ' | ') detalle
       FROM analytics.sellout_channel_map GROUP BY 1
      HAVING count(DISTINCT label) > 1 OR count(DISTINCT orden) > 1`);
  check('ningún canal canónico tiene dos rótulos ni dos órdenes', incoh.length === 0,
    incoh.map((i) => `${i.canonical_channel}: ${i.detalle}`).join(' · '));

  // ── 3. El invariante del cutover: Mayoreo es UNO solo ─────────────────────────────────────
  console.log('\n3 · CUTOVER (la caja 70 de Wincaja y la U-D-8 de Kepler son el MISMO canal)');
  const par = await q(
    `SELECT source, raw_channel, canonical_channel FROM analytics.sellout_channel_map
      WHERE (source='wincaja' AND raw_channel='credito') OR (source='kepler' AND raw_channel='mayoreo')`);
  if (par.length !== 2) {
    noMedido('wincaja:credito y kepler:mayoreo comparten canal',
      `este destino sólo declara ${par.length} de las 2 filas (${par.map((p) => `${p.source}:${p.raw_channel}`).join(',') || 'ninguna'})`);
  } else {
    check('wincaja:credito y kepler:mayoreo caen en el MISMO canal de negocio',
      par[0].canonical_channel === par[1].canonical_channel,
      `${par.map((p) => `${p.source}:${p.raw_channel}→${p.canonical_channel}`).join(' vs ')} — separarlos parte la columna Mayoreo en el corte de ERP`);
  }

  // ── 4. El presupuesto cubre el universo (INNER JOIN silencioso) ───────────────────────────
  console.log('\n4 · PRESUPUESTO (v_sales_entity entra por INNER JOIN: sin entidad, el real desaparece)');
  if (!universo || !(await existe('analytics.v_sales_entity'))) {
    noMedido('v_sales_entity cubre el universo del sell-out', 'falta v_sales_entity o el rollup está vacío');
  } else {
    const sinEntidad = await q(`
      SELECT s.channel, s.warehouse_code, sum(s.monto)::numeric(16,2) monto
        FROM analytics.mv_sellout_monthly s
        LEFT JOIN analytics.v_sales_entity e
               ON e.tenant_id = s.tenant_id AND e.channel = s.channel AND e.warehouse_code = s.warehouse_code
       WHERE e.entity_key IS NULL
       GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`);
    check('todo (canal, almacén) del universo tiene entidad de presupuesto', sinEntidad.length === 0,
      sinEntidad.map((s) => `${s.channel}/${s.warehouse_code} ${money(s.monto)}`).join(' · '));
  }

  // ── 5. NEGATIVA: romperlo a propósito y ver el rojo ───────────────────────────────────────
  // Se borra UNA fila dentro de una transacción que SIEMPRE se revierte. Es la única forma de
  // probar el mecanismo real (la vista, el LEFT JOIN) y no una reimplementación de su lógica —
  // que es justo lo que un candado no debe hacer: una copia del criterio se pone verde sola.
  console.log('\n5 · PRUEBA NEGATIVA (sin esto, el bloque 1 es una intención)');
  if (!universo) {
    noMedido('borrar una fila del mapa pone el bloque 1 en rojo', 'el rollup está vacío: no hay cobertura que romper');
  } else {
    let detecto = null;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      const del = await c.query(
        `DELETE FROM analytics.sellout_channel_map WHERE source='kepler' AND raw_channel='mayoreo'`);
      if (del.rowCount === 1) {
        const r = await c.query(
          `SELECT count(*)::int n FROM analytics.v_sellout_channel_coverage
            WHERE NOT mapeado AND source='kepler' AND raw_channel='mayoreo'`);
        detecto = Number(r.rows[0].n) === 1;
      }
    } finally {
      await c.query('ROLLBACK');
    }
    if (detecto === null) noMedido('borrar una fila del mapa pone el bloque 1 en rojo', 'la fila kepler:mayoreo no estaba para borrar');
    else check('al borrar kepler:mayoreo, la cobertura lo reporta sin mapear', detecto === true,
      'la vista NO lo detectó: el bloque 1 no protege nada');
    // El rollback tiene que haber dejado la fila en su lugar.
    const vuelta = await q(`SELECT count(*)::int n FROM analytics.sellout_channel_map WHERE source='kepler' AND raw_channel='mayoreo'`);
    check('el ROLLBACK dejó el mapa intacto', Number(vuelta[0].n) === 1, 'la fila NO volvió — revisar el mapa a mano');
  }

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${fail ? '✖' : '✅'} ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
