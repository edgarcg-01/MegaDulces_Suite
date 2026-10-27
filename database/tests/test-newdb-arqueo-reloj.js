/**
 * `[CG.82]` — EL CIERRE DE JORNADA VA POR EL RELOJ EN QUE SE REGISTRÓ EL EFECTIVO.
 *
 * ── Qué vigila y por qué existe ──────────────────────────────────────────────────────────────
 *
 * Lo pidió Edgar: *"verifica que el cierre de jornada sí esté mostrando los ingresos y egresos
 * que se van registrando"*. No los mostraba: `arqueoDelDia` filtraba por `cash_ledger.fecha`, que
 * es la fecha del DOCUMENTO de Kepler, no el día en que la persona registró el efectivo.
 *
 * La `fecha` nace del documento (la bandeja propone `fecha: ymd(r.fecha_valor)`), y el ERP captura
 * con una mediana de 3 días de rezago — cifra que el propio `arqueoDelDia` ya publicaba en sus
 * `limites`. O sea que lo NORMAL es registrar hoy algo fechado hace tres días, y eso caía en una
 * jornada ya cerrada.
 *
 * ⭐ Lo que lo vuelve inequívoco y no una preferencia: **el otro lado del cuadre ya está en el
 * reloj físico**. El cajero se agrupa por `caos_cash_movements.accounting_date`, y este candado
 * mide que esa columna coincide con el día en que el efectivo se movió. Un cuadre cuyos dos lados
 * usan relojes distintos no cuadra nada.
 *
 * ⚠️ Este archivo NO usa un doble de Knex: ejecuta el SQL contra la base. Un doble devuelve lo que
 * se le programó y habría pasado igual con el filtro viejo — es exactamente el defecto que
 * `feedback_doubles_never_validate_sql` nombra. Si no hay base alcanzable, se declara NO MEDIDO.
 *
 * Correr:  DATABASE_URL_NEW=<url> node database/tests/test-newdb-arqueo-reloj.js
 */
'use strict';
const { Client } = require('pg');

const DST = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✖ ' + msg); } };
const NM = (msg) => { nm++; console.log('  — NO MEDIDO: ' + msg); };

/** La jornada VIEJA: por la fecha del documento. Se conserva para poder contrastar. */
const PORFECHA = `
  SELECT count(*) FILTER (WHERE estado <> 'cancelado')::int AS n,
         coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos
    FROM finance.cash_ledger
   WHERE tenant_id = $1 AND sucursal = '00' AND fecha = $2::date AND deleted_at IS NULL`;

/**
 * La jornada NUEVA: por el día en que se registró. Rango sargable, sin cast sobre la columna.
 * `[CGP-D.1.4]` Mismo rango que `enJornadaLibro` (`caja-jornadas.query.ts`): el día pasa por
 * `::timestamp` antes del `AT TIME ZONE`, o la medianoche sale en la zona de la SESIÓN.
 */
const PORREGISTRO = `
  SELECT count(*) FILTER (WHERE estado <> 'cancelado')::int AS n,
         coalesce(sum(monto) FILTER (WHERE estado <> 'cancelado' AND tipo='gasto'),0)::numeric AS gastos,
         count(*) FILTER (WHERE estado <> 'cancelado'
                   AND fecha <> (created_at AT TIME ZONE 'America/Mexico_City')::date)::int AS otro_dia
    FROM finance.cash_ledger
   WHERE tenant_id = $1 AND sucursal = '00' AND deleted_at IS NULL
     AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Mexico_City'
     AND created_at <  (($2::date) + 1)::timestamp AT TIME ZONE 'America/Mexico_City'`;

(async () => {
  console.log('\n=== [CG.82] el cierre de jornada y su reloj ===\n');
  if (!DST) { NM('sin PROD_DB_URL ni DATABASE_URL_NEW: no hay base contra la cual ejecutar el SQL'); return fin(); }

  const pg = new Client({ connectionString: DST });
  try { await pg.connect(); } catch (e) { NM('no conecta a la base: ' + e.message); return fin(); }

  try {
    console.log('0) la premisa: el OTRO lado del cuadre ya está en el reloj físico');
    const caos = await pg.query(`
      SELECT count(*)::int AS movs,
             count(*) FILTER (WHERE accounting_date = (occurred_at AT TIME ZONE 'America/Mexico_City')::date)::int AS fisico
        FROM analytics.caos_cash_movements WHERE occurred_at > now() - interval '60 days'`)
      .catch(() => ({ rows: [{ movs: 0, fisico: 0 }] }));
    const { movs, fisico } = caos.rows[0];
    if (!movs) NM('el feed del cajero no tiene movimientos en 60 días: no se puede comprobar su reloj');
    else A(fisico / movs > 0.95,
      `el cajero va por el día FÍSICO en ${fisico} de ${movs} movimientos (${(100 * fisico / movs).toFixed(1)}%)`);

    console.log('\n1) una jornada con movimientos fechados OTRO día los INCLUYE');
    // Se busca un día que de verdad tenga ese caso, en vez de clavar una fecha: una fecha fija
    // caduca, y un candado que caduca se pone verde por vacío.
    const cand = await pg.query(`
      SELECT (created_at AT TIME ZONE 'America/Mexico_City')::date::text AS dia, count(*)::int AS n
        FROM finance.cash_ledger
       WHERE tenant_id = $1 AND sucursal = '00' AND deleted_at IS NULL AND estado <> 'cancelado'
         AND fecha <> (created_at AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [TENANT]);

    if (!cand.rows.length) {
      NM('hoy NINGÚN movimiento vivo tiene el documento fechado otro día: el caso no se puede ejercer con datos reales');
    } else {
      const dia = cand.rows[0].dia;
      const [vieja] = (await pg.query(PORFECHA, [TENANT, dia])).rows;
      const [nueva] = (await pg.query(PORREGISTRO, [TENANT, dia])).rows;
      A(Number(nueva.n) >= Number(cand.rows[0].n),
        `la jornada ${dia} incluye los ${cand.rows[0].n} registrados ese día (trae ${nueva.n})`);
      A(Number(nueva.otro_dia) > 0,
        `y DECLARA cuántos traen el papel de otra fecha (${nueva.otro_dia}) — el número viaja, no sólo la frase`);
      A(Number(nueva.n) > Number(vieja.n),
        `el filtro viejo por fecha de documento mostraba ${vieja.n} y el nuevo ${nueva.n}: la diferencia es lo que se perdía`);
    }

    console.log('\n2) ⛔ [negativa] una jornada SIN registros no inventa movimientos');
    const vacio = await pg.query(PORREGISTRO, [TENANT, '1999-01-04']);
    A(Number(vacio.rows[0].n) === 0 && Number(vacio.rows[0].gastos) === 0,
      'un día sin capturas da 0 movimientos y 0 pesos, no un total de otro día');

    console.log('\n3) ⛔ [negativa] el rango NO se come el día de al lado (la frontera de medianoche MX)');
    const borde = await pg.query(`
      SELECT count(*)::int AS fuera
        FROM finance.cash_ledger
       WHERE tenant_id = $1 AND sucursal = '00' AND deleted_at IS NULL
         AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Mexico_City'
         AND created_at <  (($2::date) + 1)::timestamp AT TIME ZONE 'America/Mexico_City'
         AND (created_at AT TIME ZONE 'America/Mexico_City')::date <> $2::date`, [TENANT, '2026-09-28']);
    A(Number(borde.rows[0].fuera) === 0,
      'todo lo que cae en el rango pertenece a ese día en hora de México (si esto falla, el huso está mal)');
  } finally {
    await pg.end().catch(() => {});
  }
  fin();
})().catch((e) => { console.error(e); process.exit(1); });

function fin() {
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} no medido ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}
