/* eslint-disable no-console */
/**
 * `[VE.1]` Candado del ÁRBITRO INDEPENDIENTE del egreso (ADR-059 R5/R7 · ADR-056 · ADR-040).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido el 2026-10-06 sobre `docs/VERDAD_ABSOLUTA.md`: las palabras `egreso`, `gasto`,
 * `familia 6`, `expense_entries` y `cuenta por pagar` aparecen **0 veces**. El documento tenía 18
 * dimensiones arbitradas y ninguna era de egreso — no por olvido, sino porque el egreso nunca
 * tuvo testigo.
 *
 * El único "árbitro" que existía (`BudgetResultService.arbitroGasto`) compara
 * `analytics.expense_entries` contra `analytics.ledger_monthly`, y las dos leen **la misma tabla
 * primaria** (`kepler_ods.kdc2YYMM`). *Otra implementación no es otro testigo.* El independiente
 * —los libros del contador, `analytics.contpaqi_ledger_monthly`— existía, estaba fresco y **no
 * estaba cableado a nada**.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────────────────────
 *   [1] metadata: la vista existe, con `security_invoker` y su GRANT (no se heredan al recrearla)
 *   [2] ⭐ R5 — el árbitro MUERDE: si todo cuadrara sería un espejo, no un testigo
 *   [3] ⭐ PRUEBA NEGATIVA del subnivel: `agrupador_sat IN ('601','602')` —tal como lo describe el
 *       comentario de `BudgetResultService`— devuelve **NULL**, porque el dato real trae subnivel
 *       (`601.01`). Es la trampa que se cobró primero al medir esto
 *   [4] ⭐ LA PREMISA DEL CORTE, vigilada: la frontera de nómina (601.01–601.33) sale de los
 *       NOMBRES del catálogo SAT. Si el catálogo se mueve, el corte deja de ser válido y esto se
 *       pone rojo. Un comentario no avisa cuando deja de ser cierto; un test sí (`[CDRP.2.1]`)
 *   [5] ⭐⭐ LO NO COMPARABLE NO SE RESTA: un mes con una sola pierna lleva `delta` en NULL. Es la
 *       lección que este mismo trabajo se cobró — comparando TOTALES anuales, financieros parecía
 *       invertido (+21.1 % a favor de los libros) y de ahí salía la conclusión de que la brecha no
 *       podía ser recorte de alcance; partido por mes, ese signo venía de ene–mar, **donde Kepler
 *       no tiene la pierna**. Un total que suma meses comparables con meses que no lo son se lee
 *       como un hallazgo y no lo es
 *   [6] `mapeo_firmado` sigue en false: cuando Contabilidad firme la correspondencia
 *       concepto→agrupador, lo que tiene que cambiar es el DATO, no un comentario
 *   [7] cobertura y tiempo, DECLARADOS
 *
 * Sólo lectura: no escribe una fila. Corre contra prod a propósito — el hecho que mide vive ahí.
 */
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

// `run-all-tests.js` carga el `.env`; corriendo el archivo suelto no hay quien lo haga y el
// destino llega vacío → el test reporta NO MEDIDO y se lee como "no hay nada que comprobar".
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const ANIO = Number(process.env.VE_ANIO || 2026);
const GATE_MS = Number(process.env.VE_GATE_MS || 500);

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });

(async () => {
  if (!URL) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 300000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    // ── 1. Metadata ───────────────────────────────────────────────────────────────────────
    console.log('\n[1] La vista existe, con security_invoker y su GRANT');
    const [meta] = await q(`
      SELECT c.relname,
             coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                        WHERE option_name = 'security_invoker'), 'false') AS sec_inv,
             has_table_privilege('app_runtime', 'analytics.v_expense_arbiter', 'SELECT') AS grant_ok
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'analytics' AND c.relname = 'v_expense_arbiter'`);
    if (!meta) { nm('la vista analytics.v_expense_arbiter no existe en este destino'); }
    else {
      chk(String(meta.sec_inv) === 'true', 'security_invoker = true (no se hereda al recrear la vista)');
      chk(meta.grant_ok === true, 'app_runtime puede leerla');
    }

    if (meta) {
      // ── 2. R5: el árbitro muerde ─────────────────────────────────────────────────────────
      console.log(`\n[2] R5 — el árbitro CONTRADICE (si nunca lo hiciera, sería un espejo)`);
      const t0 = Date.now();
      const filas = await q(
        `SELECT bloque, anio_mes, veredicto, kepler, contpaqi, delta, mes_en_curso
           FROM analytics.v_expense_arbiter
          WHERE anio_mes BETWEEN $1 AND $2
          ORDER BY bloque_orden, anio_mes`,
        [`${ANIO}-01`, `${ANIO}-12`]);
      const ms = Date.now() - t0;

      // ⭐ PRUEBA NEGATIVA ejercible: `VE_MUTAR` inyecta —sólo en memoria, sin tocar la base— el
      // defecto que cada bloque dice vigilar, para comprobar que el candado se pone ROJO y no es
      // una intención. Se corre a mano:
      //   VE_MUTAR=delta_cero   → una celda con una sola pierna pasa a tener delta dibujado  → [5]
      //   VE_MUTAR=espejo       → todo cuadra, o sea el árbitro deja de contradecir           → [2]
      //   VE_MUTAR=mes_abierto  → el mes en curso deja de estar marcado                       → [7b]
      const MUTAR = process.env.VE_MUTAR;
      if (MUTAR) {
        console.log(`  ⚠️ MUTACIÓN ACTIVA (${MUTAR}) — se espera que este candado FALLE`);
        if (MUTAR === 'delta_cero') {
          const v = filas.find((f) => f.veredicto === 'solo_libros' || f.veredicto === 'solo_operacion');
          if (v) v.delta = 0; else console.log('    (no hay celda de una sola pierna que mutar)');
        }
        if (MUTAR === 'espejo') for (const f of filas) f.veredicto = 'cuadra';
        if (MUTAR === 'mes_abierto') for (const f of filas) f.mes_en_curso = false;
      }

      if (!filas.length) {
        nm(`la vista no devuelve filas de ${ANIO} — sin esto no se puede juzgar al árbitro`);
      } else {
        const difiere = filas.filter((f) => f.veredicto === 'difiere').length;
        chk(difiere > 0,
          `${difiere} de ${filas.length} celdas (bloque × mes) difieren — el testigo muerde`);

        // Un árbitro que SIEMPRE contradice tampoco informa: se declara la proporción.
        const cuadra = filas.filter((f) => f.veredicto === 'cuadra').length;
        console.log(`    · reparto: ${cuadra} cuadra · ${difiere} difiere · `
          + `${filas.length - cuadra - difiere} con una sola pierna`);

        // ── 5. Lo no comparable no se resta ───────────────────────────────────────────────
        console.log('\n[5] Un mes con una sola pierna lleva delta en NULL, nunca en 0');
        const solos = filas.filter((f) => f.veredicto === 'solo_libros' || f.veredicto === 'solo_operacion');
        const soloConDelta = solos.filter((f) => f.delta !== null);
        chk(soloConDelta.length === 0,
          `${solos.length} celdas con una sola pierna, ${soloConDelta.length} con delta dibujado`);
        if (solos.length) {
          const porBloque = {};
          for (const s of solos) porBloque[s.bloque] = (porBloque[s.bloque] || 0) + 1;
          console.log('    · dónde falta la contraparte: '
            + Object.entries(porBloque).map(([b, k]) => `${b} ${k}`).join(' · '));
          console.log('    ⚠️ un total ANUAL que sume estas celdas con las comparables cambia el '
            + 'signo de la conclusión — medido en financieros 2026');
        } else {
          nm('no hay celdas con una sola pierna en este año: el caso no se ejerció');
        }

        // ── 7b. El mes EN CURSO está marcado, y no entra al acumulado ────────────────────
        console.log('\n[7b] El mes en curso se DECLARA y queda fuera del acumulado');
        const mesHoy = new Date().toISOString().slice(0, 7);
        const enCurso = filas.filter((f) => f.mes_en_curso === true);
        const malMarcadas = filas.filter((f) => (f.anio_mes >= mesHoy) !== (f.mes_en_curso === true));
        chk(malMarcadas.length === 0,
          `${enCurso.length} celdas del mes en curso marcadas, 0 mal clasificadas (hoy ${mesHoy})`);
        if (!enCurso.length) {
          nm(`no hay celdas de ${mesHoy} todavía: el caso no se ejerció este año`);
        } else {
          const dc = enCurso.filter((f) => f.delta !== null).reduce((a, x) => a + Number(x.delta), 0);
          console.log(`    ⚠️ esas celdas mueven el acumulado en ${n(dc)} y cambian todos los días: `
            + 'los dos lados llenan el mes a ritmos distintos');
        }

        // ── 7. Cobertura y tiempo ─────────────────────────────────────────────────────────
        console.log('\n[7] Cobertura y tiempo, declarados (sólo meses terminados)');
        chk(ms <= GATE_MS, `la vista responde en ${ms} ms (gate ${GATE_MS} ms)`);
        for (const b of ['compra', 'gasto_resto', 'nomina', 'financieros']) {
          const f = filas.filter((x) => x.bloque === b && x.mes_en_curso !== true);
          const comp = f.filter((x) => x.delta !== null);
          const kMayor = comp.filter((x) => Number(x.delta) < 0).length;
          console.log(`    · ${b.padEnd(12)} ${String(comp.length).padStart(2)} meses comparables · `
            + `Kepler mayor en ${kMayor} · delta ${n(comp.reduce((a, x) => a + Number(x.delta), 0))}`);
        }
      }

      // ── 6. La premisa del mapeo sigue sin firmar ─────────────────────────────────────────
      console.log('\n[6] La correspondencia concepto→agrupador NO está firmada por Contabilidad');
      const [firma] = await q(
        `SELECT count(*) FILTER (WHERE mapeo_firmado) AS firmadas, count(*) AS total
           FROM analytics.v_expense_arbiter`);
      chk(Number(firma.firmadas) === 0,
        `${firma.total} celdas, ${firma.firmadas} con mapeo firmado — mientras sea 0, «difiere» `
        + 'declara una brecha y NO imputa un error a nadie');
    }

    // ── 3. Prueba negativa: el agrupador trae SUBNIVEL ─────────────────────────────────────
    console.log('\n[3] PRUEBA NEGATIVA — el filtro sin subnivel no encuentra nada');
    const [sinSub] = await q(
      `SELECT count(*) AS filas, coalesce(sum(cargos - abonos), 0) AS monto
         FROM analytics.contpaqi_ledger_monthly
        WHERE anio_mes BETWEEN $1 AND $2 AND agrupador_sat IN ('601', '602')`,
      [`${ANIO}-01`, `${ANIO}-12`]);
    const [conSub] = await q(
      `SELECT count(*) AS filas FROM analytics.contpaqi_ledger_monthly
        WHERE anio_mes BETWEEN $1 AND $2
          AND (agrupador_sat LIKE '601%' OR agrupador_sat LIKE '602%')`,
      [`${ANIO}-01`, `${ANIO}-12`]);
    if (Number(conSub.filas) === 0) {
      nm('ContPAQi no trae agrupadores 601/602 en este año: la negativa no se puede ejercer');
    } else {
      chk(Number(sinSub.filas) === 0,
        `IN ('601','602') devuelve ${sinSub.filas} filas contra ${conSub.filas} con LIKE — `
        + 'el subnivel es parte del dato, y ese filtro da NULL, no cero');
    }

    // ── 4. La frontera de nómina sale del catálogo, no de una opinión ──────────────────────
    console.log('\n[4] La premisa del corte de nómina (601.01–601.33), contra el catálogo SAT');
    const nombres = await q(
      `SELECT agrupador_sat, max(agrupador_sat_nombre) AS nombre
         FROM analytics.contpaqi_ledger_monthly
        WHERE agrupador_sat IN ('601.01', '601.26', '601.28', '601.29', '601.34', '601.45')
        GROUP BY 1 ORDER BY 1`);
    const mapa = Object.fromEntries(nombres.map((r) => [r.agrupador_sat, String(r.nombre || '')]));
    const dentro = [
      ['601.01', /sueldo/i], ['601.26', /imss/i], ['601.28', /sar/i], ['601.29', /n[oó]mina/i],
    ];
    const fuera = [['601.34', /honorario/i], ['601.45', /arrendamiento/i]];
    let premisaOk = true, vistos = 0;
    for (const [ag, re] of [...dentro, ...fuera]) {
      if (!mapa[ag]) continue;
      vistos++;
      if (!re.test(mapa[ag])) { premisaOk = false; console.log(`    ✖ ${ag} = "${mapa[ag]}"`); }
    }
    if (vistos === 0) nm('ninguno de los agrupadores de referencia está presente');
    else {
      chk(premisaOk,
        `${vistos} agrupadores de referencia conservan su concepto — 601.26/28/29 son nómina y `
        + '601.34 (honorarios) / 601.45 (arrendamiento) NO lo son: la frontera es del catálogo');
    }
  } finally {
    await c.end().catch(() => undefined);
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
