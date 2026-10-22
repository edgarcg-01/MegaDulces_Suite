/* eslint-disable no-console */
/**
 * `[RD.84.0]` CANDADO de la **vigencia del padrón**: la comisión se decide con el padrón que
 * estaba vigente **en la quincena**, no con el de hoy.
 *
 * ── Qué destapó esto ─────────────────────────────────────────────────────────────────────
 *
 * El 2026-10-20 se dieron de baja las rutas **321 y 322** (pasaron de Ruta Directa a Vecinal),
 * con `activo = false` y `activo_hasta = 2026-07-15`. La baja es correcta.
 *
 * ⛔ Pero `analytics.v_rd_commission_universe` resuelve `comisiona = (en config AND activo)`
 * **sin mirar ninguna fecha**, y el motor la consumía sin pasarle el periodo. Medido contra
 * prod ese mismo día:
 *
 *     el libro le pagó a la 321 ... 5 quincenas con pago, $19,096.84 (2026-01-01 → 2026-07-15)
 *     el motor, al recalcularlas ..                   $0.00
 *
 * O sea: **una baja correcta reescribía la historia en silencio**, y por el único camino que
 * el módulo tiene para escribir (`POST /commissions/recalculate-from`).
 *
 * ── Qué vigila, y por qué cada cosa ──────────────────────────────────────────────────────
 *
 * **1. La trampa EXISTE.** Antes de probar la regla se comprueba que haya al menos una ruta
 * dada de baja **con fecha** y **con pago histórico**. Sin eso el candado sería un no-op y el
 * verde se leería igual que «no hay problema» — es la lección de `[RD.57]` y de LC.15.
 *
 * **2. La regla separa de verdad**: esa ruta tiene que salir **vigente** en una quincena que
 * cierra **antes o el día de** su `activo_hasta`, y **NO vigente** en la siguiente. Si las dos
 * dieran lo mismo, la fecha no estaría decidiendo nada.
 *
 * **3. PRUEBA NEGATIVA.** La regla **vieja** (`comisiona = activo`, sin fecha) tiene que
 * producir el resultado equivocado sobre esos mismos datos. Una guarda cuyo efecto no se puede
 * medir es indistinguible de no tenerla.
 *
 * **4. El par `activo_desde` existe.** `activo_hasta` solo cierra la vigencia; sin su par, un
 * alta hecha hoy comisionaría la quincena 1 — el mismo defecto espejado.
 *
 * **5. La baja SIN fecha no comisiona en ningún periodo** (lectura conservadora, ADR-056) y
 * **no cambió el comportamiento de nadie**: las filas con `activo = true` y `activo_desde`
 * NULL tienen que seguir vigentes en toda quincena, que es lo que pasaba antes de `[RD.84.0]`.
 *
 * **6. Ninguna corrida YA PAGADA cambia.** El padrón es una dimensión lenta y
 * `commission_run_lines` guarda su propio `route_code`: la vigencia decide qué se calcula de
 * aquí en más, nunca qué quedó escrito.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-padron-vigencia.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TABLA = 'commercial.commission_route_config';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** La regla de `[RD.84.0]`, escrita UNA vez y reusada en cada aserción. */
const VIGENTE = `(c.route_code IS NOT NULL
   AND (c.activo_desde IS NULL OR c.activo_desde <= $2::date)
   AND (c.activo OR (c.activo_hasta IS NOT NULL AND c.activo_hasta >= $1::date)))`;

const fin = async (db) => {
  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
};

(async () => {
  const db = new Client({
    connectionString: URL, statement_timeout: 120000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  console.log(`\n=== [RD.84.0] la vigencia del padrón · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  // ── 4. El par existe ─────────────────────────────────────────────────────────────────────
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'commission_route_config'`))
    .rows.map((r) => r.column_name);
  for (const c of ['activo_desde', 'activo_hasta']) {
    check(`el padrón tiene ${c}`, cols.includes(c), 'falta 20261020140919');
  }
  if (!cols.includes('activo_desde')) {
    noMedido('la regla de vigencia', 'sin activo_desde la mitad del par no existe');
    return fin(db);
  }

  // ── 1. La trampa EXISTE: una baja CON fecha y CON pago histórico ─────────────────────────
  const { rows: trampas } = await db.query(
    // ⚠️ `to_char`, NO `::date`: node-pg devuelve un `date` como OBJETO Date, y `String(d)`
    // da "Wed Jul 15 2026 …", que comparado contra "YYYY-MM-DD" nunca ordena bien. El
    // candado se declaraba NO MEDIDO por eso -- el instrumento roto, no el dato. Es el mismo
    // defecto que `[LC.16]`, en la otra dirección.
    `SELECT c.route_code, to_char(c.activo_hasta, 'YYYY-MM-DD') AS hasta,
            COALESCE(sum(l.a_pagar), 0)::numeric(14,2) AS pagado,
            count(DISTINCT r.period_id) AS quincenas
       FROM ${TABLA} c
       LEFT JOIN commercial.commission_run_lines l
              ON l.route_code = c.route_code AND l.deleted_at IS NULL
       LEFT JOIN commercial.commission_runs r ON r.id = l.run_id
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
        AND c.activo = false AND c.activo_hasta IS NOT NULL
      GROUP BY 1, 2 HAVING count(DISTINCT r.period_id) > 0
      ORDER BY 3 DESC`, [TENANT]);

  if (!trampas.length) {
    // ⛔ No es un ✔. Si nadie está dado de baja con fecha, esta regla no se está ejerciendo
    // contra nada y decirlo verde sería dibujar un cero (ADR-056).
    noMedido('la regla de vigencia',
      'ninguna ruta está de baja CON fecha y CON pago histórico: no hay trampa que probar');
    return fin(db);
  }
  const t = trampas[0];
  check('existe la trampa: una ruta de baja con fecha y con pago histórico',
    true, `ruta ${t.route_code} · hasta ${t.hasta} · $${t.pagado} en ${t.quincenas} quincena(s)`);

  // ── 2. La regla separa: vigente en su última quincena, no vigente en la siguiente ────────
  const { rows: per } = await db.query(
    `SELECT to_char(date_from,'YYYY-MM-DD') f, to_char(date_to,'YYYY-MM-DD') t, anio, period_no
       FROM commercial.commission_periods
      WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY date_from`, [TENANT]);
  const ultima = per.filter((p) => p.t <= String(t.hasta)).pop();
  const siguiente = per.find((p) => p.f > String(t.hasta));
  if (!ultima || !siguiente) {
    noMedido('la separación por fecha',
      `no hay quincena antes y después de ${t.hasta} para contrastar`);
    return fin(db);
  }

  const vigenteEn = async (p) => (await db.query(
    `SELECT ${VIGENTE} AS vigente FROM ${TABLA} c
      WHERE c.tenant_id = $3 AND c.route_code = $4 AND c.deleted_at IS NULL`,
    [p.f, p.t, TENANT, t.route_code])).rows[0]?.vigente;

  const enUltima = await vigenteEn(ultima);
  const enSiguiente = await vigenteEn(siguiente);
  check(`la ruta ${t.route_code} SÍ comisiona en Q${ultima.period_no} (cierra ${ultima.t})`,
    enUltima === true, `dio ${enUltima}`);
  check(`la ruta ${t.route_code} NO comisiona en Q${siguiente.period_no} (abre ${siguiente.f})`,
    enSiguiente === false, `dio ${enSiguiente}`);

  // ── 3. PRUEBA NEGATIVA: la regla VIEJA se equivoca sobre estos mismos datos ──────────────
  const { rows: [viejo] } = await db.query(
    `SELECT (c.route_code IS NOT NULL AND c.activo) AS vigente FROM ${TABLA} c
      WHERE c.tenant_id = $1 AND c.route_code = $2 AND c.deleted_at IS NULL`,
    [TENANT, t.route_code]);
  check('la regla VIEJA (sin fecha) da el resultado equivocado en su última quincena',
    viejo.vigente === false && enUltima === true,
    `vieja=${viejo.vigente} nueva=${enUltima} — si coincidieran, el arreglo no cambia nada`);

  // ── 5. Lo que estaba vigente sigue vigente: la migración no mueve a nadie más ────────────
  const { rows: [sin] } = await db.query(
    `SELECT count(*)::int AS n
       FROM ${TABLA} c
      WHERE c.tenant_id = $3 AND c.deleted_at IS NULL AND c.activo
        AND NOT ${VIGENTE}`, [ultima.f, ultima.t, TENANT]);
  check('ninguna ruta activa pierde la vigencia por la regla nueva', sin.n === 0,
    `${sin.n} ruta(s) activas quedaron fuera`);

  const { rows: [baja] } = await db.query(
    `SELECT count(*)::int AS n FROM ${TABLA} c
      WHERE c.tenant_id = $3 AND c.deleted_at IS NULL
        AND c.activo = false AND c.activo_hasta IS NULL AND ${VIGENTE}`,
    [ultima.f, ultima.t, TENANT]);
  check('una baja SIN fecha no comisiona en ningún periodo', baja.n === 0,
    `${baja.n} fila(s) de baja sin fecha salieron vigentes`);

  // ── 6. Lo ya escrito no se toca ──────────────────────────────────────────────────────────
  const { rows: [pagadas] } = await db.query(
    `SELECT count(*)::int AS n FROM commercial.commission_runs
      WHERE tenant_id = $1 AND status = 'pagado' AND deleted_at IS NULL`, [TENANT]);
  const { rows: [huerfanas] } = await db.query(
    `SELECT count(*)::int AS n
       FROM commercial.commission_run_lines l
       JOIN commercial.commission_runs r ON r.id = l.run_id
      WHERE r.tenant_id = $1 AND r.status = 'pagado' AND l.deleted_at IS NULL
        AND l.route_code IS NULL`, [TENANT]);
  check('las corridas pagadas conservan su propio route_code por línea',
    pagadas.n > 0 && huerfanas.n === 0,
    `${pagadas.n} pagada(s) · ${huerfanas.n} línea(s) sin ruta`);

  // ── 7. `[RD.84]` El AVISO de quincenas pagadas usa la regla NEGADA, y acierta ────────────
  //
  // ⛔ Es la consulta que decide si `PATCH /commissions/routes/:id` pide `confirmar`. Si se
  // equivoca en un sentido, el aviso no sale nunca y la confirmación es decorativa; si se
  // equivoca en el otro, sale siempre y se aprende a apretar «sí» sin leer. Acá se le pide que
  // reproduzca un número que ya conocemos por otro camino: lo que el libro le pagó a la ruta de
  // la trampa. Es el CONTROL del instrumento.
  const { rows: [esperado] } = await db.query(
    `SELECT count(DISTINCT r.period_id)::int AS quincenas,
            COALESCE(sum(l.a_pagar), 0)::numeric(14,2) AS pagado
       FROM commercial.commission_run_lines l
       JOIN commercial.commission_runs r ON r.id = l.run_id
      WHERE r.tenant_id = $1 AND r.status = 'pagado'
        AND r.deleted_at IS NULL AND l.deleted_at IS NULL
        AND l.route_code = $2 AND l.a_pagar > 0`, [TENANT, t.route_code]);

  // La misma ruta, pero apagada SIN fecha: la vigencia nueva la saca de TODAS las quincenas, así
  // que el aviso tiene que nombrarlas todas.
  const { rows: avisadas } = await db.query(
    `SELECT p.period_no, sum(l.a_pagar)::numeric(14,2) AS pagado
       FROM commercial.commission_run_lines l
       JOIN commercial.commission_runs r    ON r.id = l.run_id
       JOIN commercial.commission_periods p ON p.id = r.period_id
      WHERE r.tenant_id = $1 AND r.status = 'pagado'
        AND r.deleted_at IS NULL AND l.deleted_at IS NULL
        AND l.route_code = $2 AND l.a_pagar > 0
        AND NOT (
              (NULL::date IS NULL OR NULL::date <= p.date_to)
          AND (false OR (NULL::date IS NOT NULL AND NULL::date >= p.date_from))
        )
      GROUP BY 1`, [TENANT, t.route_code]);
  const sumaAviso = avisadas.reduce((s, r) => s + Number(r.pagado), 0).toFixed(2);
  check('el aviso de quincenas pagadas reproduce lo que el libro pagó (control)',
    avisadas.length === esperado.quincenas && sumaAviso === String(esperado.pagado),
    `aviso ${avisadas.length}q/$${sumaAviso} vs libro ${esperado.quincenas}q/$${esperado.pagado}`);

  // Y con la vigencia REAL de la fila (que respeta su historia), el aviso NO debe disparar: si
  // disparara igual, la confirmación saldría en cada edición y dejaría de significar algo.
  const { rows: sinAviso } = await db.query(
    `SELECT p.period_no
       FROM commercial.commission_run_lines l
       JOIN commercial.commission_runs r    ON r.id = l.run_id
       JOIN commercial.commission_periods p ON p.id = r.period_id
       JOIN ${TABLA} c ON c.route_code = l.route_code AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.status = 'pagado'
        AND r.deleted_at IS NULL AND l.deleted_at IS NULL AND c.deleted_at IS NULL
        AND l.route_code = $2 AND l.a_pagar > 0
        AND NOT (
              (c.activo_desde IS NULL OR c.activo_desde <= p.date_to)
          AND (c.activo OR (c.activo_hasta IS NOT NULL AND c.activo_hasta >= p.date_from))
        )`, [TENANT, t.route_code]);
  check('con la vigencia real de la fila, el aviso NO dispara', sinAviso.length === 0,
    `disparó en ${sinAviso.length} quincena(s): la confirmación saldría siempre`);

  // ⛔ Lo que esto NO prueba, y se declara en vez de darse por verde.
  noMedido('los tres endpoints de /commissions/routes',
    'GET/POST/PATCH no se ejercieron: escribir exige API arriba, y este repo prohíbe levantar '
    + 'backend local. Van al job `pruebas-db` del CI (deuda VP.5, 65 suites HTTP fuera)');

  return fin(db);
})().catch((e) => { console.error('\n✖ error:', e.message); process.exit(1); });
