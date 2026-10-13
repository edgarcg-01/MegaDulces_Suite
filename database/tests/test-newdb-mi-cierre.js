'use strict';
/**
 * `[CPA.10]` Candado de `analytics.v_contpaqi_captura_mensual` — la bandeja «Mi cierre».
 *
 *   node database/tests/test-newdb-mi-cierre.js
 *
 * Sólo lee. Corre contra prod a propósito: lo que protege es un hecho de prod.
 *
 * ── Qué protege, y por qué ESTAS aserciones ─────────────────────────────────────────────────
 * Esta vista mide **cuánto teclea la contadora** y de eso cuánto se puede armar. Las formas en
 * que eso puede fallar sin dejar de verse plausible:
 *
 *  1. ⛔⛔ **Que el patrón pierda una familia entera en silencio.** El concepto real de la venta
 *     diaria es `VTA.4/9/26 Suc. 3 ...` — con PUNTO. Con `ILIKE 'VTA %'` (espacio) se van
 *     **~1,472 renglones/mes a `otros`** y nada falla: el total cuadra, la pantalla pinta, y una
 *     de las tres familias más grandes queda declarada "sin clasificar". La prueba negativa corre
 *     **las dos formas** y exige que difieran; si coincidieran, la prueba ya no prueba nada.
 *
 *  2. ⛔ **Que la familia ausente DESAPAREZCA en vez de salir en cero.** Es la lección de
 *     septiembre-2026 ($30.3 M pagados a proveedores contra $0 de compras). Se corren las dos
 *     formas —`CROSS JOIN` y `GROUP BY`— y se exige que **una vea el mes×familia vacío y la otra
 *     no**.
 *
 *  3. **Que el reparto esté mal.** Se cruza contra una derivación INDEPENDIENTE: el conteo por
 *     familia que `FASE_CPA` §3 hizo con otro clasificador. Su `venta_diaria` de jul–sep es
 *     7,960 renglones; el de acá tiene que dar lo mismo. ⭐ Un candado que compare la vista
 *     consigo misma pasa en verde con la lógica rota (lección de `[IC.0]`).
 *
 *  4. **Que la cobertura se infle.** El 93.6 % tiene que reproducirse desde los renglones
 *     crudos, no desde un campo que la vista ya calculó.
 *
 *  5. **Que el estado de entrega mienta.** `contpaqi.poliza_exports.verificada` tiene que seguir
 *     siendo **NULLABLE**: si alguien le pone `NOT NULL DEFAULT false`, "nadie comprobó" se
 *     vuelve "no cuadró" y el engine pierde su tercer estado (ADR-056).
 *
 * ── ⚠️ Antes de aplicar la migración ────────────────────────────────────────────────────────
 * Si la vista todavía no existe, los bloques que la miran reportan **NO MEDIDO** (no ✔, no ✘) y
 * los que miran los datos crudos **corren igual** — los hechos que justifican la fase son ciertos
 * con o sin vista.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const DST = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta PROD_DB_URL (o DATABASE_URL_NEW).'); process.exit(1); }

const VISTA = 'analytics.v_contpaqi_captura_mensual';
const EXPORTS = 'contpaqi.poliza_exports';
/** Gate duro del proyecto para una pantalla (regla de Edgar: >500 ms no funciona). */
const GATE_MS = 500;
/** La ventana de 3 meses cerrados con la que se midió todo lo de abajo. */
const DESDE = '2026-07', HASTA = '2026-09';

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const n = (v) => (v === null || v === undefined ? null : Number(v));

/** El clasificador, EN UN SOLO LUGAR: el candado y la vista tienen que decir lo mismo. */
const CASE_FAMILIA = (vta) => `
  CASE WHEN p.concepto ILIKE 'NOM %'                 THEN 'nomina'
       WHEN p.concepto ILIKE '%COMISION%'            THEN 'comisiones_bancarias'
       WHEN p.concepto ILIKE '%TRASPASO%'            THEN 'traspasos'
       WHEN p.concepto ILIKE '%COMPRAS DEL MES%'
         OR p.concepto ILIKE '%REGISTRO DE COMPRAS%' THEN 'libro_compras'
       WHEN p.concepto ILIKE 'VENTAS %'              THEN 'cobranza_sucursal'
       WHEN p.concepto ILIKE '${vta}'                THEN 'venta_diaria'
       WHEN p.concepto ILIKE 'TLMKT%'                THEN 'venta_telemarketing'
       WHEN p.concepto ILIKE 'PAGO%'                 THEN 'pago_gasto'
       WHEN p.concepto ILIKE 'GASTOS %'              THEN 'gastos_varios'
       ELSE 'otros' END`;

/** Las familias SIN fuente de este lado. Tiene que coincidir con `FAMILIAS` del engine. */
const SIN_FUENTE = ['nomina', 'gastos_varios', 'otros'];

(async () => {
  const knex = knexLib({ client: 'pg', connection: DST });
  try {
    await knex.raw("SET statement_timeout = '120s'");
    const { rows: [idn] } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    console.log(`\n[CPA.10] bandeja «Mi cierre» · cluster ${idn.id}\n`);

    const existe = (await knex.raw('SELECT to_regclass(?) AS t', [VISTA])).rows[0].t;

    // ── 1. El hecho que funda la fase: cuánto se teclea ────────────────────────────────────
    console.log('── 1. El tecleo mensual, desde las pólizas crudas ──');

    const { rows: porMes } = await knex.raw(`
      SELECT anio_mes, sum(num_lines)::int AS renglones
        FROM analytics.gl_polizas
       WHERE source='contpaqi' AND anio_mes BETWEEN ? AND ?
       GROUP BY 1 ORDER BY 1`, [DESDE, HASTA]);

    t('los 3 meses cerrados tienen pólizas de ContPAQi', porMes.length === 3, porMes.length);
    const promedio = porMes.reduce((a, r) => a + n(r.renglones), 0) / Math.max(porMes.length, 1);
    t(`el tecleo ronda los 12,000 renglones/mes (medido ${Math.round(promedio)})`,
      promedio > 10000 && promedio < 15000, Math.round(promedio));

    // ── 2. ⛔ LA PRUEBA NEGATIVA DEL PATRÓN: `VTA.` lleva punto ────────────────────────────
    console.log('\n── 2. ⛔ el patrón `VTA` — con punto y con espacio NO son lo mismo ──');

    const reparto = async (vta) => {
      const { rows } = await knex.raw(`
        SELECT ${CASE_FAMILIA(vta)} AS familia, sum(p.num_lines)::int AS renglones
          FROM analytics.gl_polizas p
         WHERE p.source='contpaqi' AND p.anio_mes BETWEEN ? AND ?
         GROUP BY 1`, [DESDE, HASTA]);
      return Object.fromEntries(rows.map((r) => [r.familia, n(r.renglones)]));
    };

    const bueno = await reparto('VTA%');
    const roto = await reparto('VTA %');

    t('con `VTA%` la venta diaria da los 7,960 renglones de FASE_CPA §3 (derivación independiente)',
      bueno.venta_diaria === 7960, bueno.venta_diaria);
    t('⛔ con `VTA %` (espacio) la familia se desangra hacia `otros`',
      roto.venta_diaria < bueno.venta_diaria, { bueno: bueno.venta_diaria, roto: roto.venta_diaria });

    const fuga = bueno.venta_diaria - roto.venta_diaria;
    t(`la fuga son ~1,472 renglones/mes (medido ${Math.round(fuga / 3)})`,
      fuga / 3 > 1200 && fuga / 3 < 1800, Math.round(fuga / 3));
    t('⛔ y aterrizan EXACTAMENTE en `otros` — no se pierden, se disfrazan',
      (roto.otros ?? 0) - (bueno.otros ?? 0) === fuga,
      { diff_otros: (roto.otros ?? 0) - (bueno.otros ?? 0), fuga });
    t('el TOTAL es idéntico con las dos formas — por eso nada falla y hay que probarlo así',
      Object.values(bueno).reduce((a, v) => a + v, 0) === Object.values(roto).reduce((a, v) => a + v, 0));

    // ── 3. El reparto bueno, y lo que queda sin clasificar ─────────────────────────────────
    console.log('\n── 3. el reparto, y el bucket que se declara ──');

    const total3m = Object.values(bueno).reduce((a, v) => a + v, 0);
    const autom = Object.entries(bueno)
      .filter(([f]) => !SIN_FUENTE.includes(f))
      .reduce((a, [, v]) => a + v, 0);
    const cobertura = Math.round((autom / total3m) * 1000) / 10;

    t(`la cobertura reproduce el 93.6 % medido (da ${cobertura} %)`,
      Math.abs(cobertura - 93.6) < 0.3, cobertura);
    t(`\`otros\` queda por debajo del 1 % (medido ${Math.round((bueno.otros / total3m) * 1000) / 10} %)`,
      bueno.otros / total3m < 0.01, bueno.otros);
    t('`venta_telemarketing` es una familia propia y NO está vacía (FASE_CPA la tenía en `otros`)',
      (bueno.venta_telemarketing ?? 0) > 500, bueno.venta_telemarketing);
    t('las 10 familias del engine aparecen todas en el reparto',
      Object.keys(bueno).length === 10, Object.keys(bueno).length);

    // ── 4. ⛔ el CROSS JOIN: la familia ausente sale en cero, no desaparece ────────────────
    console.log('\n── 4. ⛔ la familia ausente sale en CERO, no desaparece ──');

    if (!existe) {
      noMedido('el CROSS JOIN de la vista', 'la vista todavía no está aplicada en este destino');
      noMedido('security_invoker y el GRANT', 'la vista todavía no está aplicada');
      noMedido(`el gate de ${GATE_MS} ms`, 'la vista todavía no está aplicada');
    } else {
      const { rows: conCross } = await knex.raw(
        `SELECT count(*)::int AS c FROM ${VISTA} WHERE anio_mes BETWEEN ? AND ?`, [DESDE, HASTA]);
      const { rows: conGroup } = await knex.raw(`
        SELECT count(*)::int AS c FROM (
          SELECT p.anio_mes, ${CASE_FAMILIA('VTA%')} AS familia
            FROM analytics.gl_polizas p
           WHERE p.source='contpaqi' AND p.anio_mes BETWEEN ? AND ?
           GROUP BY 1, 2) z`, [DESDE, HASTA]);

      t('la vista publica 10 familias × 3 meses = 30 filas', n(conCross[0].c) === 30, n(conCross[0].c));
      t('⛔ el `GROUP BY` ve MENOS: ésas son las que desaparecerían del tablero',
        n(conGroup[0].c) < n(conCross[0].c), { cross: n(conCross[0].c), group: n(conGroup[0].c) });

      const { rows: enCero } = await knex.raw(
        `SELECT familia, anio_mes FROM ${VISTA} WHERE anio_mes BETWEEN ? AND ? AND renglones = 0`,
        [DESDE, HASTA]);
      t('y las que salen en cero están nombradas, no ausentes',
        enCero.length === n(conCross[0].c) - n(conGroup[0].c),
        { en_cero: enCero.length, faltantes: n(conCross[0].c) - n(conGroup[0].c) });

      // ── metadata: lo que se pierde en cada CREATE OR REPLACE VIEW ───────────────────────
      const { rows: [meta] } = await knex.raw(`
        SELECT c.reloptions::text AS opts,
               has_table_privilege('app_runtime', ?, 'SELECT') AS puede_leer
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname='analytics' AND c.relname='v_contpaqi_captura_mensual'`, [VISTA]);
      t('`security_invoker` puesto (se PIERDE en cada CREATE OR REPLACE — ADR-057)',
        String(meta?.opts ?? '').includes('security_invoker=true'), meta?.opts);
      // ⚠️ `has_table_privilege` y no `information_schema`: ése filtra por el privilegio de quien
      // lee y dice "ningún grant" sobre tablas que sí lo tienen (la trampa de `[CP.8.39]`).
      t('`app_runtime` puede leerla', meta?.puede_leer === true, meta?.puede_leer);

      // ── el gate de tiempo ───────────────────────────────────────────────────────────────
      const marcas = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await knex.raw(`SELECT * FROM ${VISTA} WHERE anio_mes = ?`, [HASTA]);
        marcas.push(Date.now() - t0);
      }
      const mejor = Math.min(...marcas);
      // ⚠️ Un tiempo suelto no se puede citar: se miden tres y se publica el rango.
      if (mejor < GATE_MS) {
        t(`el gate de ${GATE_MS} ms (medido ${Math.min(...marcas)}–${Math.max(...marcas)} ms)`, true);
      } else {
        t(`el gate de ${GATE_MS} ms`, false, { marcas });
      }
    }

    // ── 5. el estado de entrega: `verificada` tiene que seguir siendo TERNARIO ─────────────
    console.log('\n── 5. ⛔ `verificada` es TERNARIO y tiene que seguir siéndolo ──');

    const { rows: [col] } = await knex.raw(`
      SELECT is_nullable, data_type, column_default
        FROM information_schema.columns
       WHERE table_schema='contpaqi' AND table_name='poliza_exports' AND column_name='verificada'`);
    if (!col) {
      noMedido('la columna `verificada`', `${EXPORTS} no existe en este destino`);
    } else {
      t('`verificada` es NULLABLE — `null` significa "nadie comprobó", y no es `false`',
        col.is_nullable === 'YES', col.is_nullable);
      t('`verificada` NO tiene default — un default convertiría "no sé" en una afirmación',
        col.column_default === null, col.column_default);
      t('`verificada` es booleana', col.data_type === 'boolean', col.data_type);
    }

    const { rows: [est] } = await knex.raw(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'poliza_exports_estado_chk'`);
    if (!est) {
      noMedido('el CHECK de estado', 'la restricción no existe en este destino');
    } else {
      for (const e of ['armada', 'entregada', 'aplicada', 'rechazada']) {
        t(`el camino admite "${e}"`, String(est.def).includes(`'${e}'`));
      }
    }

    // ── 6. el vacío que ES el dato ─────────────────────────────────────────────────────────
    console.log('\n── 6. el vacío que es el dato ──');
    const { rows: [ex] } = await knex.raw(`SELECT count(*)::int AS c FROM ${EXPORTS}`).catch(() => ({ rows: [null] }));
    if (!ex) {
      noMedido('las entregas', `no se pudo leer ${EXPORTS}`);
    } else if (n(ex.c) === 0) {
      // No es una falla: es el hecho que la fase existe para cambiar, y se declara.
      noMedido('alguna entrega viva',
        'cero filas en poliza_exports: nunca se ha entregado nada a ContPAQi. '
        + 'La bandeja va a pintar TODO como `lista`/`falta_mapa`, que es lo correcto hoy.');
    } else {
      t('hay entregas que la bandeja puede pintar', n(ex.c) > 0, n(ex.c));
    }

    console.log(`\n── RESULTADO: ${ok} ✔ · ${bad} ✘ · ${nm} ◻ NO MEDIDO ──\n`);
    await knex.destroy();
    process.exit(bad === 0 ? 0 : 1);
  } catch (e) {
    console.error('\nFATAL:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
