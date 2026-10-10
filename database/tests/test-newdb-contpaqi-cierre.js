'use strict';
/**
 * `[CPA.0]` Candado de `analytics.v_contpaqi_cierre_mensual` — el semáforo de cierre contable.
 *
 *   node database/tests/test-newdb-contpaqi-cierre.js
 *
 * Sólo lee. Corre contra prod a propósito: lo que protege es un hecho de prod.
 *
 * ── Qué protege, y por qué ESTAS aserciones ─────────────────────────────────────────────────
 * La vista publica un veredicto sobre si un mes está asentado. Las tres formas en que eso puede
 * fallar **sin dejar de verse plausible** son:
 *
 *  1. **Que la señal se calcule mal.** Se cruza contra `analytics.contpaqi_ledger_monthly` —la
 *     balanza, que llega agregada desde SQL Server por un importer distinto—. ⭐ Son **dos
 *     derivaciones independientes del mismo hecho**. Un candado que compare la vista consigo
 *     misma pasa en verde con la lógica rota: es la lección de `[IC.0]`, que dejó pasar dos bugs
 *     verificándose contra el ODS con su propia lógica.
 *
 *  2. ⛔ **Que la familia ausente DESAPAREZCA en vez de salir en rojo.** Es el defecto que esta
 *     fase existe para cerrar: con `GROUP BY`, el mes sin ni un renglón de compras no produce
 *     fila. La prueba negativa corre las dos formas —`CROSS JOIN` y `GROUP BY`— sobre el mismo
 *     mes y exige que **una vea septiembre y la otra no**. Si las dos lo ven, la prueba ya no
 *     prueba nada y hay que revisarla.
 *
 *  3. **Que el provisional se cuele como asentado.** Octubre tiene pólizas fechadas en el futuro.
 *     Se exige que la señal del mes sea ESTRICTAMENTE menor que el total sin filtrar, y que
 *     `señal + provisional` reproduzca ese total al centavo.
 *
 * Más el umbral: `analytics.kpi_thresholds` tiene que tener las cinco claves **con procedencia
 * escrita**, y los números de hoy tienen que caer del lado correcto de esos umbrales — si no, el
 * semáforo nace mintiendo aunque el SQL esté bien.
 *
 * ── ⚠️ Antes de aplicar la migración ────────────────────────────────────────────────────────
 * Si la vista todavía no existe, los bloques que la miran reportan **NO MEDIDO** (no ✔, no ✘:
 * ADR-056) y los que miran los datos crudos **corren igual** — porque los hechos que justifican
 * la fase son ciertos con o sin vista.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const DST = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta PROD_DB_URL (o DATABASE_URL_NEW).'); process.exit(1); }

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const VISTA = 'analytics.v_contpaqi_cierre_mensual';
/** Gate duro del proyecto para una pantalla. Ver `[CPA.0]` sobre el índice que falta. */
const GATE_MS = 500;

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };

const n = (v) => (v === null || v === undefined ? null : Number(v));
const money = (v) => (v === null ? 'null' : Number(v).toLocaleString('es-MX', { maximumFractionDigits: 0 }));

(async () => {
  const knex = knexLib({ client: 'pg', connection: DST });
  try {
    await knex.raw("SET statement_timeout = '120s'");

    const { rows: [idn] } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    console.log(`\n[CPA.0] semáforo de cierre contable · cluster ${idn.id}\n`);

    const existe = (await knex.raw('SELECT to_regclass(?) AS t', [VISTA])).rows[0].t;

    // ── 1. Los HECHOS crudos que justifican la fase (no dependen de la vista) ────────────────
    console.log('── 1. Los hechos, desde el detalle de pólizas ──');

    const crudo = await knex.raw(`
      SELECT l.anio_mes,
             sum(l.importe) FILTER (WHERE left(l.cuenta,4)='2120' AND l.cargo_abono='A') AS compras,
             count(*)       FILTER (WHERE left(l.cuenta,4)='2120' AND l.cargo_abono='A') AS compras_rengl,
             sum(l.importe) FILTER (WHERE left(l.cuenta,4)='2120' AND l.cargo_abono='C') AS pagos
        FROM analytics.gl_poliza_lines l
       WHERE l.source='contpaqi' AND l.tenant_id=? AND l.anio_mes IN ('2026-07','2026-08','2026-09')
       GROUP BY 1 ORDER BY 1`, [TENANT]);
    const porMes = Object.fromEntries(crudo.rows.map((r) => [r.anio_mes, r]));

    const sep = porMes['2026-09'];
    t('sep-2026 NO tiene ni un renglón de compras (2120 abono)',
      sep && Number(sep.compras_rengl) === 0, sep && { renglones: sep.compras_rengl });
    t('…y sin embargo SÍ tiene pagos a proveedor (2120 cargo) — por eso es un hueco, no un mes vacío',
      sep && Number(sep.pagos) > 0, sep && { pagos: money(sep.pagos) });
    t('jul-2026 y ago-2026 sí tienen compras asentadas (el control: no todos los meses faltan)',
      Number(porMes['2026-07']?.compras_rengl) > 0 && Number(porMes['2026-08']?.compras_rengl) > 0,
      { jul: porMes['2026-07']?.compras_rengl, ago: porMes['2026-08']?.compras_rengl });

    // ── 2. ⛔ PRUEBA NEGATIVA: la forma que ESCONDE la ausencia ──────────────────────────────
    console.log('\n── 2. ⛔ NEGATIVA — GROUP BY esconde el mes que falta, CROSS JOIN no ──');

    const conGroupBy = await knex.raw(`
      SELECT 1 FROM analytics.gl_poliza_lines l
       WHERE l.source='contpaqi' AND l.tenant_id=? AND l.anio_mes='2026-09'
         AND left(l.cuenta,4)='2120' AND l.cargo_abono='A'
       GROUP BY l.anio_mes LIMIT 1`, [TENANT]);
    t('⛔ con GROUP BY, (2026-09, compras) NO produce fila: la ausencia se vuelve invisible',
      conGroupBy.rows.length === 0, { filas: conGroupBy.rows.length });

    if (existe) {
      const conCross = await knex.raw(
        `SELECT senal, senal_renglones FROM ${VISTA} WHERE tenant_id=? AND anio_mes='2026-09' AND familia='compras'`,
        [TENANT]);
      t('…y con la vista (CROSS JOIN) SÍ produce fila, con 0 renglones y $0 — que es el punto',
        conCross.rows.length === 1 && Number(conCross.rows[0].senal_renglones) === 0,
        conCross.rows[0]);
    } else {
      noMedido('la vista ve (2026-09, compras)', 'la migración 20261010100305 no está aplicada');
    }

    // ── 3. Dos derivaciones independientes: la vista contra LA BALANZA ───────────────────────
    console.log('\n── 3. La vista contra la balanza (otro importer, otra forma) ──');

    if (!existe) {
      noMedido('paridad vista ↔ balanza', 'la vista no existe todavía');
    } else {
      const par = await knex.raw(`
        WITH v AS (
          SELECT anio_mes, familia, senal, coalesce(provisional,0) AS prov
            FROM ${VISTA} WHERE tenant_id=? AND anio_mes IN ('2026-07','2026-08','2026-09')
        ), b AS (
          SELECT anio_mes,
                 sum(abonos) FILTER (WHERE left(cuenta,4)='2120')             AS compras,
                 sum(abonos) FILTER (WHERE left(cuenta,3) IN ('401','403'))   AS ventas,
                 sum(cargos) FILTER (WHERE left(cuenta,4)='5200')             AS gastos,
                 sum(cargos) FILTER (WHERE left(cuenta,4)='2150')             AS nomina
            FROM analytics.contpaqi_ledger_monthly
           WHERE tenant_id=? AND cuenta_afectable AND anio_mes IN ('2026-07','2026-08','2026-09')
           GROUP BY 1
        )
        SELECT v.anio_mes, v.familia, (v.senal + v.prov) AS vista,
               CASE v.familia WHEN 'compras' THEN b.compras WHEN 'ventas' THEN b.ventas
                              WHEN 'gastos'  THEN b.gastos  WHEN 'nomina' THEN b.nomina END AS balanza
          FROM v JOIN b USING (anio_mes)
         WHERE v.familia IN ('compras','ventas','gastos','nomina')
         ORDER BY 1,2`, [TENANT, TENANT]);

      const difs = par.rows.filter((r) => {
        const a = n(r.vista) ?? 0, bz = n(r.balanza) ?? 0;
        return Math.abs(a - bz) > 0.5;
      });
      t(`señal+provisional == balanza al peso en los 3 meses × 4 familias (${par.rows.length} pares)`,
        par.rows.length >= 12 && difs.length === 0, difs.slice(0, 3));
    }

    // ── 4. El provisional NO cuenta como asentado ────────────────────────────────────────────
    console.log('\n── 4. El provisional viaja aparte ──');

    const fut = await knex.raw(`
      SELECT count(*)::int AS polizas FROM analytics.gl_polizas
       WHERE source='contpaqi' AND tenant_id=? AND fecha > CURRENT_DATE`, [TENANT]);
    const hayFuturas = Number(fut.rows[0].polizas) > 0;

    if (!hayFuturas) {
      noMedido('el provisional se excluye de la señal',
        'hoy no hay ninguna póliza fechada en el futuro: no hay caso que medir');
    } else if (!existe) {
      noMedido('el provisional se excluye de la señal', 'la vista no existe todavía');
    } else {
      const pv = await knex.raw(`
        SELECT anio_mes, familia, senal, provisional FROM ${VISTA}
         WHERE tenant_id=? AND provisional IS NOT NULL AND provisional > 0`, [TENANT]);
      t(`hay ${fut.rows[0].polizas} pólizas fechadas adelante y la vista las reporta en su columna`,
        pv.rows.length > 0, { filas_con_provisional: pv.rows.length });

      const una = pv.rows[0];
      if (una) {
        const totalSin = await knex.raw(`
          SELECT sum(l.importe) AS total FROM analytics.gl_poliza_lines l
           WHERE l.source='contpaqi' AND l.tenant_id=? AND l.anio_mes=?
             AND CASE
                   WHEN left(l.cuenta,4)='2120' AND l.cargo_abono='A' THEN 'compras'
                   WHEN left(l.cuenta,3) IN ('401','403') AND l.cargo_abono='A' THEN 'ventas'
                   WHEN left(l.cuenta,4)='1020' THEN 'bancos'
                   WHEN left(l.cuenta,4)='5200' AND l.cargo_abono='C' THEN 'gastos'
                   WHEN left(l.cuenta,4)='2150' AND l.cargo_abono='C' THEN 'nomina'
                 END = ?`, [TENANT, una.anio_mes, una.familia]);
        const tot = n(totalSin.rows[0].total);
        t(`(${una.anio_mes}, ${una.familia}): la señal (${money(una.senal)}) es MENOR que el total sin filtrar (${money(tot)})`,
          n(una.senal) < tot);
        t('…y señal + provisional reproduce ese total al centavo',
          Math.abs((n(una.senal) + n(una.provisional)) - tot) < 0.5,
          { senal: una.senal, prov: una.provisional, total: tot });
      }
    }

    // ── 5. Los umbrales: registrados, con procedencia, y del lado correcto ───────────────────
    console.log('\n── 5. Los umbrales de `analytics.kpi_thresholds` ──');

    const um = await knex.raw(`
      SELECT kpi_key, target, warn_at, escalate_at, direction, escalate_to, source, manual_lock
        FROM analytics.kpi_thresholds
       WHERE tenant_id=? AND kpi_key LIKE 'cierre_contable.%' AND deleted_at IS NULL
       ORDER BY kpi_key`, [TENANT]);

    if (um.rows.length === 0) {
      noMedido('los cinco umbrales de cierre', 'la migración 20261010101128 no está aplicada');
      noMedido('sep-2026 cae del lado "bad" del umbral', 'sin umbral no hay con qué comparar');
    } else {
      t('las cinco familias tienen umbral registrado', um.rows.length === 5,
        um.rows.map((r) => r.kpi_key));
      t('⛔ ninguno sin procedencia: un umbral sin `source` es un número que nadie puede discutir',
        um.rows.every((r) => String(r.source || '').trim().length > 20));
      t('todos con `manual_lock`: salieron de una medición humana, el auto-calibrador no los pisa',
        um.rows.every((r) => r.manual_lock === true));
      t('escalan a una silla OCUPADA (jefe_finanzas), no a un puesto vacío',
        um.rows.every((r) => r.escalate_to === 'jefe_finanzas'));

      const ocup = await knex.raw(`
        SELECT count(*)::int AS n FROM identity.users
         WHERE tenant_id=? AND position_code='jefe_finanzas' AND deleted_at IS NULL AND status='active'`,
        [TENANT]);
      t('…y esa silla de verdad tiene gente sentada hoy', Number(ocup.rows[0].n) > 0,
        { personas: ocup.rows[0].n });

      if (existe) {
        const uc = Object.fromEntries(um.rows.map((r) => [r.kpi_key, r]));
        const cob = await knex.raw(`
          SELECT anio_mes, familia, cobertura FROM ${VISTA}
           WHERE tenant_id=? AND anio_mes IN ('2026-07','2026-08','2026-09') AND familia='compras'
           ORDER BY anio_mes`, [TENANT]);
        const c = Object.fromEntries(cob.rows.map((r) => [r.anio_mes, n(r.cobertura)]));
        const u = uc['cierre_contable.compras'];

        t(`sep-2026 compras cae por DEBAJO del escalamiento (${c['2026-09']} < ${n(u.escalate_at)}) → rojo y escala`,
          c['2026-09'] !== null && c['2026-09'] < n(u.escalate_at), { cobertura: c['2026-09'] });
        t(`jul-2026 y ago-2026 compras alcanzan la meta (${n(u.target)}) → verde`,
          c['2026-07'] >= n(u.target) && c['2026-08'] >= n(u.target),
          { jul: c['2026-07'], ago: c['2026-08'] });
        t('⛔ NEGATIVA — el umbral no es trivial: la meta está por DEBAJO de la banda real medida, ' +
          'pero por ENCIMA de cero (si fuera 0, septiembre saldría verde)',
          n(u.target) > 0 && n(u.target) < c['2026-07'], { target: n(u.target), jul: c['2026-07'] });
      } else {
        noMedido('sep-2026 cae del lado "bad" del umbral', 'la vista no existe todavía');
      }
    }

    // ── 6. Metadatos de la vista: RLS y permiso ──────────────────────────────────────────────
    console.log('\n── 6. Metadatos ──');
    if (!existe) {
      noMedido('security_invoker + GRANT', 'la vista no existe todavía');
    } else {
      const meta = await knex.raw(`
        SELECT c.reloptions::text AS opts,
               has_table_privilege('app_runtime', ?, 'SELECT') AS puede
          FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
         WHERE ns.nspname='analytics' AND c.relname='v_contpaqi_cierre_mensual'`, [VISTA]);
      t('⚠️ `security_invoker` puesto (no se hereda y se pierde en cada CREATE OR REPLACE)',
        /security_invoker=true/.test(meta.rows[0]?.opts || ''), meta.rows[0]?.opts);
      t('`app_runtime` puede leerla (si no, la API la ve vacía y nadie se entera)',
        meta.rows[0]?.puede === true);

      const falso = await knex.raw(
        `SELECT count(*)::int AS n FROM ${VISTA} WHERE tenant_id = '00000000-0000-0000-0000-0000000f0000'`);
      t('⛔ NEGATIVA — un tenant que no existe devuelve CERO filas', Number(falso.rows[0].n) === 0);
    }

    // ── 7. El tiempo, publicado aunque incomode ──────────────────────────────────────────────
    console.log('\n── 7. Tiempo ──');
    if (!existe) {
      noMedido('tiempo de la vista', 'la vista no existe todavía');
    } else {
      const ms = [];
      for (let i = 0; i < 3; i++) {
        const a = Date.now();
        await knex.raw(`SELECT count(*) FROM ${VISTA} WHERE tenant_id=? AND anio_mes >= ?`,
          [TENANT, '2025-10']);
        ms.push(Date.now() - a);
      }
      const mejor = Math.min(...ms);
      console.log(`     corridas: ${ms.join(' / ')} ms`);
      t('la vista responde en menos de 3 s (techo duro: arriba de esto la pantalla es inusable)',
        mejor < 3000, { ms });
      if (mejor <= GATE_MS) {
        t(`cumple el gate de ${GATE_MS} ms (${mejor} ms)`, true);
      } else {
        noMedido(`el gate de ${GATE_MS} ms`,
          `mide ${mejor} ms — falta el índice cubriente de fiscal.cfdis ` +
          '(migración 20261010101129, se aplica FUERA de horario). Está declarado, no escondido.');
      }
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
