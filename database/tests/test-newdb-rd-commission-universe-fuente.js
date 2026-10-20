/* eslint-disable no-console */
/**
 * `[RD.71]` CANDADO del ESTADO DE LA FUENTE en el universo de la comisión.
 *
 * ── Qué destapó esto ─────────────────────────────────────────────────────────────────────
 *
 * `v_rd_commission_universe` decide `veredicto` mirando la config **primero**: una fila en
 * `commission_route_config` con `activo = true` sale `comisiona` sin preguntarle nunca a la
 * venta. Medido en prod el 2026-10-19: la **321** llevaba **139 días** sin un dato y la
 * **322** **110**, las dos con `comisiona = true` y **$0** en los últimos 30 días, mientras
 * sus relevos (`2V001`, `2V003`) vendían **$751,354.38** clasificados `fuera_no_es_camion`.
 * Nadie lo vio durante meses porque **la vista no publicaba la contradicción**.
 *
 * ── Qué vigila, y por qué cada cosa ──────────────────────────────────────────────────────
 *
 * **1. La vista es ADITIVA.** `veredicto` y `comisiona` no cambian: a quién se le paga es
 * decisión de Dirección (D1 de la fase), no del código. Si alguien "arregla" el fantasma
 * moviendo el veredicto, esto se cae — y tiene que caerse, porque sería decidir un pago
 * desde una vista.
 *
 * **2. ⛔ La PODA del dato futuro, que es lo que sostiene la columna.** La ruta **22** tiene
 * una venta fechada **2026-12-06**. Sin `FILTER (business_date <= current_date)` esa ruta
 * sale con `dias_sin_dato = -48`, o sea **la más fresca de todas**: la que tiene el dato
 * corrupto es justo la que menos sospecha levanta. El candado exige que **ninguna** ruta
 * tenga `dias_sin_dato` negativo **y** que el dato futuro se denuncie por su propia columna
 * (`tiene_dato_futuro`), porque pegar los dos hechos en una sola columna hace desaparecer
 * al segundo.
 *
 * **3. La trampa EXISTE.** Antes de probar la poda se comprueba que haya algo que podar. Sin
 * eso la guarda sería un no-op y el verde se leería igual que "no hay problema" — es la
 * lección de LC.15 y de `[RD.57]`.
 *
 * **4. PRUEBA NEGATIVA de la poda**, recalculada en SQL independiente: la misma consulta
 * **sin** el `FILTER` tiene que producir el negativo. Una guarda cuyo efecto no se puede
 * medir es indistinguible de no tenerla.
 *
 * **5. `sin_fuente` NO es cero.** Una ruta sin ninguna fila en la matvista sale
 * `fuente_estado = 'sin_fuente'` con `dias_sin_dato` **NULL**, nunca 0 — un 0 ahí se lee
 * como "reportó hoy". Es ADR-056.
 *
 * **6. Los umbrales separan de verdad.** `viva` / `rezagada` / `muerta` tienen que caer en
 * más de un grupo sobre el dato real; si todas las rutas cayeran en el mismo, la columna no
 * estaría clasificando nada y se vería igual de verde.
 *
 * **7. La metadata.** `security_invoker` y el `GRANT` no se heredan de un
 * `CREATE OR REPLACE`: ADR-057 los perdió una vez y sólo lo vio una aserción como ésta.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-commission-universe-fuente.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const VIEW = 'analytics.v_rd_commission_universe';

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
  console.log(`\n=== [RD.71] el estado de la fuente en el universo · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  if (!(await db.query(`SELECT to_regclass('${VIEW}') v`)).rows[0].v) {
    noMedido('el universo', 'la vista no existe en este destino');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'analytics' AND table_name = 'v_rd_commission_universe'`)).rows.map((r) => r.column_name);
  const NUEVAS = ['ultimo_dia_con_dato', 'dias_sin_dato', 'subtotal_30d', 'fuente_estado', 'tiene_dato_futuro'];
  if (!NUEVAS.every((c) => cols.includes(c))) {
    noMedido('el estado de la fuente', `faltan columnas de RD.71 (${NUEVAS.filter((c) => !cols.includes(c)).join(', ')}): falta 20261019141120`);
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }

  // ── 7. Metadata: sin esto la vista se lee con los permisos del DUEÑO ─────────────────────
  const { rows: [meta] } = await db.query(
    `SELECT c.reloptions::text opts,
            has_table_privilege('app_runtime','${VIEW}','SELECT') grant_ok
       FROM pg_class c WHERE c.oid = '${VIEW}'::regclass`);
  check('la vista conserva security_invoker', /security_invoker=true/.test(meta.opts || ''), meta.opts);
  check('app_runtime puede leerla', meta.grant_ok === true);

  const { rows: u } = await db.query(
    `SELECT route_code, veredicto, comisiona, fuente_estado, dias_sin_dato,
            subtotal_30d, tiene_dato_futuro, ultimo_dia_con_dato
       FROM ${VIEW} WHERE tenant_id = $1`, [TENANT]);
  check('el universo devuelve rutas', u.length > 0, `${u.length} filas`);

  // ── 1. ADITIVA: el veredicto sigue saliendo SOLO de la config/identidad/tipo ─────────────
  // Se recalcula acá, sin tocar las columnas nuevas. Si alguien metiera la frescura dentro del
  // veredicto para "arreglar" el fantasma, esto se cae.
  const { rows: ver } = await db.query(
    `WITH esperado AS (
       SELECT u.route_code,
              CASE
                WHEN u.en_config AND     u.config_activa              THEN 'comisiona'
                WHEN u.en_config AND NOT u.config_activa              THEN 'config_inactiva'
                WHEN u.route_kind IS NOT NULL AND u.route_kind <> 'camion' THEN 'fuera_no_es_camion'
                WHEN u.en_identidad                                   THEN 'camion_sin_config'
                WHEN u.route_kind = 'camion'                          THEN 'camion_sin_identidad'
                ELSE 'tipo_sin_declarar'
              END AS v
         FROM ${VIEW} u WHERE u.tenant_id = $1)
     SELECT count(*)::int n FROM ${VIEW} x JOIN esperado e USING (route_code)
      WHERE x.tenant_id = $1 AND x.veredicto <> e.v`, [TENANT]);
  check('el veredicto NO mira la frescura — sigue saliendo de config/identidad/tipo',
    ver[0].n === 0, `${ver[0].n} ruta(s) con veredicto que la frescura movio`);
  check('comisiona sigue siendo exactamente (en_config AND config_activa)',
    u.every((r) => r.comisiona === (r.veredicto === 'comisiona')));

  // ── 3. La trampa EXISTE: hay una venta fechada en el futuro ──────────────────────────────
  const { rows: [futuro] } = await db.query(
    `SELECT count(*)::int n, max(business_date)::text peor
       FROM analytics.mv_rd_route_daily_200d
      WHERE tenant_id = $1 AND business_date > current_date`, [TENANT]);
  const hayFuturo = futuro.n > 0;
  if (!hayFuturo) {
    noMedido('la poda del dato futuro', 'hoy no hay ninguna venta fechada adelante: la guarda no se puede ejercer');
  } else {
    check('la trampa existe: hay venta fechada en el FUTURO', true, `${futuro.n} fila(s), la peor ${futuro.peor}`);

    // ── 2. Ninguna ruta sale con frescura negativa ─────────────────────────────────────────
    const neg = u.filter((r) => r.dias_sin_dato !== null && Number(r.dias_sin_dato) < 0);
    check('ninguna ruta publica dias_sin_dato NEGATIVO', neg.length === 0,
      neg.map((r) => `${r.route_code}=${r.dias_sin_dato}`).join(', '));

    // El dato futuro se DENUNCIA por su propia columna, no se traga en silencio.
    const denunciadas = u.filter((r) => r.tiene_dato_futuro === true);
    check('el dato futuro se denuncia en tiene_dato_futuro', denunciadas.length > 0,
      'la poda lo escondio en vez de declararlo');

    // ── 4. PRUEBA NEGATIVA: la misma cuenta SIN el FILTER tiene que dar el negativo ────────
    const { rows: [sinPoda] } = await db.query(
      `SELECT min(current_date - ultimo)::int peor FROM (
         SELECT route_code, max(business_date) ultimo
           FROM analytics.mv_rd_route_daily_200d WHERE tenant_id = $1 GROUP BY 1) s`, [TENANT]);
    check('PRUEBA NEGATIVA: sin la poda, la frescura se va a negativo',
      sinPoda.peor < 0, `sin el FILTER el minimo da ${sinPoda.peor}, deberia ser negativo`);
    const { rows: [conPoda] } = await db.query(
      `SELECT min(dias_sin_dato)::int peor FROM ${VIEW} WHERE tenant_id = $1`, [TENANT]);
    check('CONTROL: con la poda, el mismo minimo deja de ser negativo',
      conPoda.peor >= 0, `con el FILTER da ${conPoda.peor}`);
  }

  // ── 5. sin_fuente NO es cero ─────────────────────────────────────────────────────────────
  const sinF = u.filter((r) => r.fuente_estado === 'sin_fuente');
  check('sin_fuente publica dias_sin_dato NULL, nunca 0',
    sinF.every((r) => r.dias_sin_dato === null),
    sinF.filter((r) => r.dias_sin_dato !== null).map((r) => r.route_code).join(', '));
  check('toda ruta tiene un fuente_estado declarado',
    u.every((r) => ['viva', 'rezagada', 'muerta', 'sin_fuente'].includes(r.fuente_estado)));
  check('ninguna ruta publica subtotal_30d NULL (0 ahi es un hecho medido, no una ausencia)',
    u.every((r) => r.subtotal_30d !== null));

  // ── 6. Los umbrales separan de verdad ────────────────────────────────────────────────────
  const grupos = new Set(u.map((r) => r.fuente_estado));
  check('los umbrales clasifican en mas de un grupo', grupos.size > 1,
    `todas las rutas cayeron en "${[...grupos][0]}": la columna no esta separando nada`);
  // Coherencia interna: el estado tiene que ser consecuencia de dias_sin_dato, no otra cuenta.
  const incoh = u.filter((r) => {
    if (r.fuente_estado === 'sin_fuente') return r.dias_sin_dato !== null;
    const d = Number(r.dias_sin_dato);
    return r.fuente_estado === 'viva' ? !(d <= 3)
      : r.fuente_estado === 'rezagada' ? !(d > 3 && d <= 30) : !(d > 30);
  });
  check('fuente_estado es consecuencia de dias_sin_dato, no una segunda cuenta',
    incoh.length === 0, incoh.map((r) => `${r.route_code}:${r.fuente_estado}/${r.dias_sin_dato}`).join(', '));

  // ── Lo que esto DESTAPA y no arregla — se publica, no se calla ───────────────────────────
  const fantasmas = u.filter((r) => r.comisiona && r.fuente_estado === 'muerta');
  const excluidasQueVenden = u.filter((r) => !r.comisiona && Number(r.subtotal_30d) > 0);
  console.log('\n  — lo que la vista ahora DECLARA (no es una falla del candado) —');
  console.log(`    rutas que COBRAN con la fuente muerta: ${fantasmas.length}`
    + (fantasmas.length ? ` (${fantasmas.map((r) => `${r.route_code}: ${r.dias_sin_dato}d`).join(', ')})` : ''));
  console.log(`    rutas que NO cobran y SI venden en 30d: ${excluidasQueVenden.length}`
    + (excluidasQueVenden.length
      ? ` ($${excluidasQueVenden.reduce((s, r) => s + Number(r.subtotal_30d), 0).toFixed(2)})` : ''));

  // ── Lo que este candado NO cubre ─────────────────────────────────────────────────────────
  noMedido('que la PANTALLA pinte el estado de la fuente',
    'eso se comprueba en la vista desplegada, no desde SQL');
  noMedido('a quien hay que pagarle cuando una ruta se renombra',
    'es la decision D1 de la fase (chofer o tipo de ruta); esta vista la DESCRIBE, no la resuelve');

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
