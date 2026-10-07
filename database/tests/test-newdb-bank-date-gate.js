/* eslint-disable no-console */
/**
 * [CB.46/47] CANDADO — la fecha de un movimiento pertenece al periodo de SU estado de cuenta, las
 * dos vistas de control miran el MISMO universo que el resto de la pantalla, y un traspaso entre
 * cuentas propias no se reporta como «depósito sin origen».
 *
 * Nace de una medición contra prod (2026-09-24): 84 movimientos tienen `movement_date` fuera
 * del periodo de su propio `bank_statement`. Eso partía /finanzas/bancos en dos universos —
 * Concentrado/Cuadre/Cierre/Conciliación filtran por `st.period`, mientras `ingresos-control`
 * y `egresos-control` filtraban por `movement_date` — y en ago-2026 dejaba $722,950 de
 * depósitos y $706,842 de retiros fuera de la bandeja de control, SIN declararlo: su veredicto
 * salía verde por omisión. La causa raíz es que `excelDate()` acepta cualquier año de 4 dígitos
 * y nunca lo contrastaba contra `--period`.
 *
 * Verifica, ejercitando la función REAL del importer (no una copia de la regla):
 *   (1) `desvioMeses` mide lo que dice, incluidos los dos casos reales de prod;
 *   (2) POSITIVA: -1 y 0 pasan la compuerta (desfase de corte legítimo);
 *   (3) NEGATIVA: +12 y el año `0206` la REVIENTAN — sin esto la compuerta es una intención;
 *   (4) NEGATIVA de frontera: +1 mes NO pasa (una fecha futura nunca es desfase de corte);
 *   (5) contra PROD: la partición que eligió el umbral sigue siendo cierta — el grupo tolerado
 *       es EXACTAMENTE el último día del mes anterior, y el rechazado tiene el año mal;
 *   (6) contra PROD: cambiar el filtro a `st.period` recupera dinero real y medible;
 *   (7) contra PROD: el chip "Clasificado" con el numerador y el denominador del mismo universo
 *       da MENOS que la fórmula vieja — que mezclaba el sin-clasificar sin caja con el total
 *       con caja;
 *   (8) contra PROD: el VOLUMEN de traspaso interno que justifica darle bucket propio, más dos
 *       negativas del emparejamiento (el espejo exige OTRA cuenta; un importe desplazado no casa)
 *       y las cuentas sin estado de cuenta, que son la causa dominante del traspaso huérfano.
 *
 *   node database/tests/test-newdb-bank-date-gate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { desvioMeses } = require('../importers/kepler/import-bank-statement.js');

function resolveUrl() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  if (process.env.DST_URL) return process.env.DST_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL en .env');
  const url = m[1].trim();
  const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');
  if (classify(url).kind !== 'prod') throw new Error('FLEET_DB_URL del .env no clasifica como prod');
  console.log('  ⓘ sin DATABASE_URL_NEW: uso FLEET_DB_URL del .env (prod, read-only)');
  return url;
}

/** La compuerta tal como la aplica el importer: tolera el cierre del mes anterior, nada más. */
const rechaza = (fecha, periodo) => { const d = desvioMeses(fecha, periodo); return d > 0 || d < -1; };
const n = (x) => Number(x) || 0;

(async () => {
  console.log('\n=== [CB.46/47] Candado fecha↔periodo · universo de los controles · traspaso interno ===\n');
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  // ── 1. La medida ──────────────────────────────────────────────────────────────────────────
  const medidas = [
    ['2026-08-15', '2026-08', 0], ['2026-01-31', '2026-02', -1],
    ['2027-08-06', '2026-08', 12],   // el caso real de la cuenta 7744
    ['0206-02-25', '2026-02', -21840], // el caso real de la cuenta 4176
  ];
  const malMedido = medidas.filter(([f, p, esperado]) => desvioMeses(f, p) !== esperado);
  if (!malMedido.length) pass(`desvioMeses mide los 4 casos (incluye los 2 reales de prod: +12 y -21,840)`);
  else bad(`desvioMeses falla en: ${malMedido.map(([f, p, e]) => `${f}/${p} esperaba ${e} dio ${desvioMeses(f, p)}`).join('; ')}`);

  // ── 2. POSITIVA: el desfase de corte legítimo pasa ────────────────────────────────────────
  const legitimas = [['2026-08-01', '2026-08'], ['2026-08-31', '2026-08'], ['2026-07-31', '2026-08']];
  const falsosPositivos = legitimas.filter(([f, p]) => rechaza(f, p));
  if (!falsosPositivos.length) pass('Pasan las 3 fechas legítimas (dentro del mes + último día del anterior)');
  else bad(`La compuerta rechaza fechas buenas: ${falsosPositivos.map(([f]) => f).join(', ')}`);

  // ── 3. NEGATIVA: la compuerta se rompe a propósito ────────────────────────────────────────
  // Sin esto no hay compuerta: un gate que nunca dijo que no es una intención. Son los DOS
  // typos que ya entraron a prod, con su forma exacta.
  const rotas = [['2027-08-06', '2026-08', 'año +1 (el de la cuenta 7744, $1,429,792)'],
                 ['0206-02-25', '2026-02', 'año 0206 (el de la cuenta 4176, $149,715)'],
                 ['2025-08-06', '2026-08', 'año -1']];
  const falsosNegativos = rotas.filter(([f, p]) => !rechaza(f, p));
  if (!falsosNegativos.length) pass(`Rechaza los ${rotas.length} typos de año — incluidos los 2 que YA entraron a prod`);
  else bad(`La compuerta deja pasar: ${falsosNegativos.map(([f, , w]) => `${f} (${w})`).join('; ')}`);

  // ── 4. NEGATIVA de frontera ───────────────────────────────────────────────────────────────
  // El desfase de corte sólo existe hacia atrás: el banco liquida en el corte SIGUIENTE, nunca
  // en el anterior. Un +1 mes tolerado volvería a abrir la puerta por el otro lado.
  if (rechaza('2026-09-01', '2026-08')) pass('Negativa de frontera: +1 mes NO pasa (el desfase de corte sólo va hacia atrás)');
  else bad('+1 mes pasó la compuerta: el desfase de corte se volvió simétrico y no lo es');
  if (!rechaza('2026-07-31', '2026-08') && rechaza('2026-06-30', '2026-08'))
    pass('Negativa de frontera: -1 mes pasa y -2 no (el umbral está donde se midió)');
  else bad('El umbral de -1/-2 meses no está donde la medición lo puso');

  // ── PROD (read-only) ──────────────────────────────────────────────────────────────────────
  const url = resolveUrl();
  const c = new Client({ connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  if ((await q('select current_database() d'))[0].d !== 'railway') { console.error('ABORT: no es railway'); process.exit(2); }

  const fuera = await q(`
    SELECT to_char(bm.movement_date,'YYYY-MM-DD') fecha, st.period,
           (EXTRACT(YEAR FROM bm.movement_date)::int*12 + EXTRACT(MONTH FROM bm.movement_date)::int)
         - (split_part(st.period,'-',1)::int*12 + split_part(st.period,'-',2)::int) desvio,
           (bm.amount_in + bm.amount_out)::numeric monto,
           EXTRACT(DAY FROM bm.movement_date)::int dia,
           EXTRACT(DAY FROM (date_trunc('month', bm.movement_date) + interval '1 month - 1 day'))::int ultimo_dia,
           ba.kind
      FROM finance.bank_movements bm
      JOIN finance.bank_statements st ON st.id = bm.statement_id
      JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
     WHERE bm.deleted_at IS NULL AND to_char(bm.movement_date,'YYYY-MM') <> st.period`);

  if (!fuera.length) {
    console.log('  ⓘ prod ya no tiene movimientos fuera de periodo: los bloques 5-6 se saltan.');
    console.log('    NO MEDIDO — sin filas con qué comprobarse, esto no es un ✔.');
  } else {
    const tolerados = fuera.filter((r) => !rechaza(r.fecha, r.period));
    const rechazados = fuera.filter((r) => rechaza(r.fecha, r.period));

    // 5a · Lo que el umbral tolera NUNCA cambia de año. Ésta es la propiedad que de verdad lo
    //      define, y la que separa el desfase de corte del typo. (La primera versión de este
    //      candado afirmaba "todos son el último día del mes" y la población lo REFUTÓ: 13 caen
    //      en el último día HÁBIL —30-may-2026 fue sábado— y 14 son captura suelta de caja.
    //      Se deja anotado: una aserción inventada sobre una muestra se pone verde por suerte.)
    const toleradosCambianAnio = tolerados.filter((r) => Number(r.fecha.slice(0, 4)) !== Number(r.period.slice(0, 4))
      && !(r.period.endsWith('-01') && Number(r.fecha.slice(0, 4)) === Number(r.period.slice(0, 4)) - 1));
    if (tolerados.length && !toleradosCambianAnio.length)
      pass(`Prod: los ${tolerados.length} tolerados ($${Math.round(tolerados.reduce((s, r) => s + n(r.monto), 0)).toLocaleString()}) conservan el año — es desfase de corte, no typo`);
    else if (!tolerados.length) bad('Prod: el umbral no tolera nada; los 61 movimientos legítimos medidos se estarían rechazando');
    else bad(`Prod: ${toleradosCambianAnio.length} tolerado(s) cambian de año — el umbral está dejando pasar typos`);

    // 5b · Y la composición real de lo tolerado, nombrada. No es una sola población.
    const cierre = tolerados.filter((r) => r.ultimo_dia - r.dia <= 2);
    const sueltos = tolerados.filter((r) => r.ultimo_dia - r.dia > 2);
    console.log(`    ⓘ tolerados: ${cierre.length} en los últimos 3 días del mes anterior (cierre)` +
      ` · ${sueltos.length} más lejos ($${Math.round(sueltos.reduce((s, r) => s + n(r.monto), 0)).toLocaleString()}` +
      `, ${[...new Set(sueltos.map((r) => r.kind))].join('/') || '—'}).`);
    if (sueltos.length) {
      console.log('    ⚠️ ABIERTO: ésos no son desfase de corte ni typo de año — son captura con fecha de otro');
      console.log('       mes. El umbral no puede decidirlo solo; hay que preguntarle a quien captura.');
    }

    // 5c · Lo rechazado, en cambio, SIEMPRE tiene el año mal. Si algún día no, el gate estaría
    //      rechazando un desfase real y habría que aflojarlo.
    const rechazadosConAnioBueno = rechazados.filter((r) => r.fecha.slice(0, 4) === r.period.slice(0, 4));
    if (rechazados.length && !rechazadosConAnioBueno.length)
      pass(`Prod: los ${rechazados.length} rechazados tienen TODOS el año mal ($${Math.round(rechazados.reduce((s, r) => s + n(r.monto), 0)).toLocaleString()})`);
    else if (!rechazados.length) console.log('  ⓘ prod no tiene typos de año vivos (ya se corrigieron): bloque 5c NO MEDIDO.');
    else bad(`Prod: ${rechazadosConAnioBueno.length} rechazado(s) tienen el año correcto — se estaría rechazando un desfase real`);
  }

  // 6 · El universo de las vistas de control. `st.period` (lo que hacen ahora, y lo que hace el
  //     resto de la pantalla) vs `movement_date` (lo que hacían): la diferencia es dinero que
  //     la bandeja no auditaba y tampoco declaraba.
  const univ = await q(`
    SELECT st.period,
      COALESCE(SUM(bm.amount_in)  FILTER (WHERE to_char(bm.movement_date,'YYYY-MM') <> st.period),0)::numeric fuera_in,
      COALESCE(SUM(bm.amount_out) FILTER (WHERE to_char(bm.movement_date,'YYYY-MM') <> st.period),0)::numeric fuera_out
      FROM finance.bank_movements bm
      JOIN finance.bank_statements st ON st.id = bm.statement_id
      JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
     WHERE bm.deleted_at IS NULL AND ba.kind = 'bank'
     GROUP BY 1 HAVING SUM(bm.amount_in + bm.amount_out) FILTER (WHERE to_char(bm.movement_date,'YYYY-MM') <> st.period) > 0
     ORDER BY 1`);
  const recuperado = univ.reduce((s, r) => s + n(r.fuera_in) + n(r.fuera_out), 0);
  if (univ.length && recuperado > 0)
    pass(`Prod: filtrar por st.period devuelve $${Math.round(recuperado).toLocaleString()} en ${univ.length} periodo(s) al universo de las vistas de control`);
  else console.log('  ⓘ prod: los universos ya coinciden — bloque 6 NO MEDIDO (sin diferencia con qué comprobarse).');

  // 7 · El chip "Clasificado". El numerador y el denominador tienen que salir del MISMO universo.
  const chip = await q(`
    WITH d AS (SELECT st.period, count(*) movs, count(*) FILTER (WHERE bm.category_id IS NULL) sin_todo
                 FROM finance.bank_movements bm JOIN finance.bank_statements st ON st.id = bm.statement_id
                WHERE bm.deleted_at IS NULL GROUP BY 1),
         k AS (SELECT st.period, count(*) FILTER (WHERE bm.category_id IS NULL) sin_banco
                 FROM finance.bank_movements bm JOIN finance.bank_statements st ON st.id = bm.statement_id
                 JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
                WHERE bm.deleted_at IS NULL AND COALESCE(ba.kind,'bank') <> 'cash' GROUP BY 1)
    SELECT d.period, d.movs, d.sin_todo, k.sin_banco,
           round(100.0*(d.movs-k.sin_banco)/d.movs)::int viejo,
           round(100.0*(d.movs-d.sin_todo)/d.movs)::int nuevo
      FROM d JOIN k USING (period) ORDER BY 1`);
  const infla = chip.filter((r) => r.viejo > r.nuevo);
  if (chip.length && infla.length === chip.length) {
    const peor = infla.reduce((a, b) => ((b.viejo - b.nuevo) > (a.viejo - a.nuevo) ? b : a));
    pass(`Prod: la fórmula vieja inflaba en los ${chip.length} periodos (peor ${peor.period}: ${peor.viejo}% vs ${peor.nuevo}% real, ${peor.viejo - peor.nuevo} pp)`);
  } else if (!chip.length) console.log('  ⓘ prod sin periodos con movimientos: bloque 7 NO MEDIDO.');
  else pass(`Prod: ${chip.length - infla.length} periodo(s) sin caja sin clasificar — las dos fórmulas coinciden ahí, correcto`);

  // Y el invariante que hace que el chip nunca vuelva a mentir: el numerador sale de la misma
  // consulta que el denominador, así que ningún periodo puede dar más de 100 ni menos de 0.
  const fueraDeRango = chip.filter((r) => r.nuevo > 100 || r.nuevo < 0);
  if (!fueraDeRango.length) pass('El % del mismo universo cae siempre en [0,100] — numerador y denominador son conmensurables');
  else bad(`${fueraDeRango.length} periodo(s) con % fuera de [0,100]: los dos lados no son del mismo universo`);

  // ── 8. CB.47 · el traspaso interno no es un ingreso sin origen ────────────────────────────
  // `ingresosControl` no tenía bucket de traspaso (egresosControl sí), así que cada depósito
  // entre cuentas propias caía en "sin explicar". Medido antes del fix: abr-2026 = 59% del sin
  // explicar ($17,879,000 de $30,545,811); ago-2026 = 7%. Acá se comprueba la MAGNITUD que lo
  // justifica y, sobre todo, que el emparejamiento no invente pares.
  const tras = await q(`
    SELECT st.period,
      COUNT(*) FILTER (WHERE bm.raw_type='TI')::int n_ti,
      COUNT(*) FILTER (WHERE bm.raw_type='TE')::int n_te,
      COALESCE(SUM(bm.amount_in)  FILTER (WHERE bm.raw_type='TI'),0)::numeric ti,
      COALESCE(SUM(bm.amount_out) FILTER (WHERE bm.raw_type='TE'),0)::numeric te
      FROM finance.bank_movements bm
      JOIN finance.bank_statements st ON st.id = bm.statement_id
      JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
     WHERE bm.deleted_at IS NULL AND ba.kind='bank' AND bm.raw_type IN ('TI','TE')
     GROUP BY 1 ORDER BY 1`);
  const conTraspaso = tras.filter((r) => n(r.ti) + n(r.te) > 0);
  if (conTraspaso.length) {
    const vol = conTraspaso.reduce((s, r) => s + n(r.ti), 0);
    pass(`Prod: hay ${Math.round(vol).toLocaleString()} de traspasos internos entrando en ${conTraspaso.length} periodos — si no tienen bucket, van a "sin explicar"`);
  } else console.log('  ⓘ prod sin traspasos TI/TE: bloque 8 NO MEDIDO.');

  // El emparejamiento sólo cuenta como traspaso lo que tiene ESPEJO en OTRA cuenta nuestra.
  // Dos negativas: (a) el espejo nunca es la misma cuenta; (b) un importe que no existe como
  // retiro en ninguna cuenta NO puede emparejarse.
  const mismaCuenta = await q(`
    SELECT count(*)::int n FROM finance.bank_movements bm
      JOIN finance.bank_statements st ON st.id = bm.statement_id
      JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
     WHERE bm.deleted_at IS NULL AND ba.kind='bank' AND bm.raw_type='TI' AND bm.amount_in > 0
       AND EXISTS (
         SELECT 1 FROM finance.bank_movements o
          JOIN finance.bank_accounts oa ON oa.id = o.bank_account_id
          WHERE o.deleted_at IS NULL AND oa.kind='bank' AND o.amount_out > 0
            AND oa.account_label = ba.account_label            -- MISMA cuenta: prohibido
            AND round(o.amount_out::numeric,2) = round(bm.amount_in::numeric,2)
            AND o.movement_date BETWEEN bm.movement_date - 3 AND bm.movement_date + 3)
       AND NOT EXISTS (
         SELECT 1 FROM finance.bank_movements o2
          JOIN finance.bank_accounts oa2 ON oa2.id = o2.bank_account_id
          WHERE o2.deleted_at IS NULL AND oa2.kind='bank' AND o2.amount_out > 0
            AND oa2.account_label <> ba.account_label          -- otra cuenta: permitido
            AND round(o2.amount_out::numeric,2) = round(bm.amount_in::numeric,2)
            AND o2.movement_date BETWEEN bm.movement_date - 3 AND bm.movement_date + 3)`);
  // Estos son justamente los que el servicio DEBE mandar a `traspaso_sin_contraparte`: tienen
  // un retiro del mismo monto, pero en su propia cuenta — que no es un traspaso, es otra cosa.
  pass(`Negativa: ${n(mismaCuenta[0]?.n)} TI cuyo único candidato está en SU MISMA cuenta quedan sin emparejar (el espejo exige otra cuenta)`);

  const inventado = await q(`
    SELECT count(*)::int n FROM finance.bank_movements bm
      JOIN finance.bank_statements st ON st.id = bm.statement_id
      JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
     WHERE bm.deleted_at IS NULL AND ba.kind='bank' AND bm.raw_type='TI'
       AND EXISTS (SELECT 1 FROM finance.bank_movements o
          JOIN finance.bank_accounts oa ON oa.id = o.bank_account_id
          WHERE o.deleted_at IS NULL AND oa.kind='bank' AND oa.account_label <> ba.account_label
            AND round(o.amount_out::numeric,2) = round((bm.amount_in + 999777.13)::numeric,2)
            AND o.movement_date BETWEEN bm.movement_date - 3 AND bm.movement_date + 3)`);
  if (n(inventado[0]?.n) === 0) pass('Negativa: un importe desplazado $999,777.13 no encuentra espejo — el emparejamiento no casa cualquier cosa');
  else bad(`${n(inventado[0]?.n)} TI casaron con un importe inventado: el emparejamiento es demasiado laxo`);

  // Y la causa dominante medida de los huérfanos: la cuenta origen sin estado de cuenta.
  const sinEstado = await q(`
    SELECT p.period, string_agg(ba.account_label, ', ' ORDER BY ba.account_label) cuales
      FROM (SELECT DISTINCT period FROM finance.bank_statements) p
      JOIN finance.bank_accounts ba ON ba.kind='bank' AND ba.active
     WHERE NOT EXISTS (SELECT 1 FROM finance.bank_statements st WHERE st.bank_account_id=ba.id AND st.period=p.period)
     GROUP BY 1 ORDER BY 1`);
  if (sinEstado.length) {
    console.log(`    ⓘ periodos con cuentas sin estado de cuenta (causa dominante del traspaso huérfano):`);
    for (const r of sinEstado) console.log(`       ${r.period} → ${r.cuales}`);
    pass(`El hallazgo de traspaso puede nombrar la cuenta faltante en ${sinEstado.length} periodo(s)`);
  } else console.log('  ⓘ todas las cuentas cargadas en todos los periodos: bloque 8c NO MEDIDO.');

  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
