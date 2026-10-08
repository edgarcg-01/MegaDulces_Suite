/* eslint-disable no-console */
/**
 * `[RD.52]` CANDADO del contraste libro↔motor.
 *
 * ── Lo que vigila, y por qué cada cosa ───────────────────────────────────────────────────
 *
 * **1. Lo que no se midió se DECLARA.** Con `commission_engine_lines` vacía para un periodo,
 * sus filas tienen que salir `sin_corrida_del_motor` — **nunca** `cuadra`. Es el defecto que
 * la Fase VP midió una y otra vez: `cfg ? classify : 'ok'` pinta de verde lo que nadie juzgó.
 *
 * **2. El veredicto vive en UN solo lugar.** Se recalcula acá, en SQL independiente, y tiene
 * que coincidir fila por fila con el que publica la vista. Si alguien mete una segunda copia
 * de la regla en el servicio o en la pantalla, esto se cae.
 *
 * **3. `el_motor_no_paga` NO es `difiere`.** El acantilado del tramo (la venta no llega a
 * $189,999.99 y la comisión cae a CERO, no "a menos") se arregla distinto que una diferencia
 * de monto, y promediarlos lo esconde. Medido: **9 ruta-periodo, $26,932.74**.
 *
 * **4. La unión de claves conserva los dos lados.** La primera versión de la vista hacía
 * `p LEFT JOIN lib FULL OUTER JOIN mot` y perdía las filas que sólo existen del lado del
 * motor. Se prueba con una fila sintética, en transacción revertida.
 *
 * **5. PRUEBA NEGATIVA.** Se inyecta una corrida del motor que difiere a propósito y se exige
 * que la vista la marque. Un detector que nunca marca nada se lee igual que "no hay nada".
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-commission-contrast.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 120000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  console.log(`\n=== [RD.52] el contraste libro vs motor · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  if (!(await db.query(`SELECT to_regclass('analytics.v_rd_commission_contrast') v`)).rows[0].v) {
    noMedido('la vista del contraste', 'no existe en este destino (falta 20261008130558)');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  // ── 1. Metadata: sin esto la vista se lee con los permisos del DUEÑO, no del que consulta ──
  const { rows: [meta] } = await db.query(
    `SELECT c.reloptions::text opts,
            has_table_privilege('app_runtime','analytics.v_rd_commission_contrast','SELECT') grant_ok
       FROM pg_class c WHERE c.oid = 'analytics.v_rd_commission_contrast'::regclass`);
  check('la vista conserva security_invoker', /security_invoker=true/.test(meta.opts || ''), meta.opts);
  check('app_runtime puede leerla', meta.grant_ok === true);
  const { rows: [rls] } = await db.query(
    `SELECT relrowsecurity r, relforcerowsecurity f
       FROM pg_class WHERE oid = 'commercial.commission_engine_lines'::regclass`);
  check('commission_engine_lines tiene RLS FORZADO', rls.r === true && rls.f === true);

  // ── 2. Lo que no se midió se declara ──────────────────────────────────────────────────────
  const { rows: sinMedir } = await db.query(
    `SELECT count(*)::int n FROM analytics.v_rd_commission_contrast v
      WHERE v.tenant_id = $1 AND v.motor_a_pagar IS NULL AND v.veredicto <> 'sin_corrida_del_motor'`,
    [TENANT]);
  check('ninguna fila sin corrida del motor dice otra cosa que "sin medir"',
    sinMedir[0].n === 0, `${sinMedir[0].n} fila(s) juzgadas sin tener contra qué`);

  const { rows: [universo] } = await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE veredicto = 'sin_corrida_del_motor')::int sin_medir,
            count(*) FILTER (WHERE veredicto = 'cuadra')::int cuadran
       FROM analytics.v_rd_commission_contrast WHERE tenant_id = $1 AND anio = 2026`, [TENANT]);
  check('la vista ve el espejo del libro', universo.total > 0, `${universo.total} fila(s)`);
  console.log(`      ${universo.total} fila(s) · ${universo.sin_medir} sin medir · ${universo.cuadran} cuadran`);

  // ── 3. El veredicto, recalculado APARTE, tiene que coincidir fila por fila ─────────────────
  // ⚠️ Esto SÍ es una copia de la regla, y es a propósito: un candado que llame a la misma
  // función que vigila no vigila nada. Lo que no puede haber es una segunda copia en el
  // CÓDIGO DE PRODUCCIÓN — eso es lo que la aserción de abajo detecta si aparece.
  const { rows: [dis] } = await db.query(
    `SELECT count(*)::int n FROM analytics.v_rd_commission_contrast v
      WHERE v.tenant_id = $1 AND v.veredicto <> (
        CASE
          WHEN v.motor_a_pagar IS NULL                              THEN 'sin_corrida_del_motor'
          WHEN v.libro_a_pagar IS NULL                              THEN 'solo_el_motor'
          WHEN v.libro_motivo IS NOT NULL AND v.motor_motivo IS NOT NULL THEN 'ninguno_paga'
          WHEN v.libro_motivo IS NOT NULL                           THEN 'solo_el_motor_paga'
          WHEN v.motor_motivo IS NOT NULL                           THEN 'el_motor_no_paga'
          WHEN abs(v.motor_a_pagar - v.libro_a_pagar) <= 1.00       THEN 'cuadra'
          WHEN abs(v.motor_a_pagar - v.libro_a_pagar)
               <= abs(NULLIF(v.libro_a_pagar, 0)) * 0.05            THEN 'difiere_poco'
          ELSE 'difiere' END)`, [TENANT]);
  check('el veredicto de la vista coincide con la regla recalculada aparte', dis.n === 0,
    `${dis.n} fila(s) discrepan`);

  // ── 4. PRUEBA NEGATIVA, con rollback ──────────────────────────────────────────────────────
  // Se inyectan DOS filas del motor sobre una quincena real: una que cuadra y una que difiere.
  // Sin el caso que cuadra, un detector que marcara TODO se vería igual de verde.
  const { rows: muestra } = await db.query(
    `SELECT v.period_id, v.route_code, v.libro_a_pagar, v.anio, v.period_no
       FROM analytics.v_rd_commission_contrast v
      WHERE v.tenant_id = $1 AND v.libro_a_pagar > 1000 AND v.libro_motivo IS NULL
      ORDER BY v.period_no, v.route_code LIMIT 2`, [TENANT]);

  // ⚠️ Desde una maquina de dev el rol trae `default_transaction_read_only = on` a nivel de ROL
  // (asi se lee prod sin poder escribirlo), y la prueba negativa NO puede correr. Se DECLARA en
  // vez de caerse: un candado que falla por el entorno enseña a ignorarlo, y uno que se saltea
  // en silencio se lee como verde. Corriendolo dentro del pod sí se ejerce.
  const { rows: [ro] } = await db.query('SHOW default_transaction_read_only');
  const soloLectura = ro.default_transaction_read_only === 'on';

  if (soloLectura) {
    noMedido('prueba negativa (control positivo, mutacion, causa y union de claves)',
      'la sesion es de SOLO LECTURA por configuracion del rol: hay que correrlo dentro del pod');
  } else if (muestra.length < 2) {
    noMedido('prueba negativa', 'no hay dos filas del libro con pago para inyectar el contraste');
  } else {
    const [a, b] = muestra;
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
      const ins = `INSERT INTO commercial.commission_engine_lines
        (tenant_id, period_id, scale_id, route_code, beneficiario, a_pagar, comision, dias_con_venta, dias_esperados)
        VALUES ($1,$2,(SELECT id FROM commercial.commission_scales WHERE tenant_id=$1 AND deleted_at IS NULL LIMIT 1),
                $3,'chofer',$4,$4,$5,$6)`;
      // (a) cuadra al centavo · (b) difiere por la mitad
      await db.query(ins, [TENANT, a.period_id, a.route_code, a.libro_a_pagar, 12, 12]);
      await db.query(ins, [TENANT, b.period_id, b.route_code, Number(b.libro_a_pagar) / 2, 6, 12]);

      const { rows: ver } = await db.query(
        `SELECT route_code, period_no, veredicto, causa FROM analytics.v_rd_commission_contrast
          WHERE tenant_id = $1 AND ((period_id = $2 AND route_code = $3) OR (period_id = $4 AND route_code = $5))`,
        [TENANT, a.period_id, a.route_code, b.period_id, b.route_code]);
      const vA = ver.find((r) => r.route_code === a.route_code && r.period_no === a.period_no);
      const vB = ver.find((r) => r.route_code === b.route_code && r.period_no === b.period_no);

      check('CONTROL POSITIVO: una corrida igual al libro sale "cuadra"', vA?.veredicto === 'cuadra',
        `salio ${vA?.veredicto}`);
      check('MUTACION: una corrida a la mitad sale "difiere"', vB?.veredicto === 'difiere',
        `salio ${vB?.veredicto}`);
      check('la causa declara los dias que faltan', vB?.causa === 'faltan_dias_en_la_fuente',
        `salio ${vB?.causa}`);
      check('con los dias completos la causa NO se inventa', vA?.causa === 'sin_explicar',
        `salio ${vA?.causa}`);

      // ── 5. La unión de claves conserva lo que sólo existe del lado del motor ───────────────
      await db.query(ins, [TENANT, a.period_id, 'ZZ-SOLO-MOTOR', 999, 1, 1]);
      const { rows: [solo] } = await db.query(
        `SELECT veredicto FROM analytics.v_rd_commission_contrast
          WHERE tenant_id = $1 AND period_id = $2 AND route_code = 'ZZ-SOLO-MOTOR'`,
        [TENANT, a.period_id]);
      check('una fila que SOLO existe en el motor no se pierde', solo?.veredicto === 'solo_el_motor',
        solo ? `salio ${solo.veredicto}` : 'la vista la descarto (el outer join no conserva)');
    } finally {
      await db.query('ROLLBACK');
    }
    const { rows: [limpio] } = await db.query(
      `SELECT count(*)::int n FROM commercial.commission_engine_lines WHERE tenant_id = $1`, [TENANT]);
    check('el rollback no dejo nada', limpio.n === 0, `quedaron ${limpio.n} fila(s)`);
  }

  // ── Lo que este candado NO cubre ───────────────────────────────────────────────────────────
  noMedido('que el servicio llame al MOTOR REAL y no a una copia',
    'eso se comprueba corriendo /contrast/run contra la API desplegada, no desde SQL');

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
