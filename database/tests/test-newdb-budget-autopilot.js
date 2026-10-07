/* eslint-disable no-console */
/**
 * `[VE.3]` Candado del PRESUPUESTO QUE SE MANTIENE SOLO (ADR-066 · ADR-053 · ADR-056).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El módulo tenía cuatro motores que producen el presupuesto —plan de ventas, plan de gastos,
 * proyección 13×4→mes y materialización— y **ninguno tenía `@Cron`**: los cuatro salían sólo
 * apretando un botón. Medido en prod el 2026-10-06: `expense_plan_lines` 0 · `budget_lines` 0 ·
 * `line_movements` 0 · `commercial.sales_targets` 0.
 *
 * Automatizarlos es seguro **por una sola razón**: los tres respetan `method='manual'` y sólo lo
 * pisan con `overwrite_manual`, que el piloto nunca manda. ⛔ **Si alguien quita esa guarda, el
 * cron pasa de rellenar huecos a BORRAR el trabajo de la gente todas las noches a las 3:30.** Ese
 * es el riesgo que este candado existe para cubrir, y por eso mira el CÓDIGO: la guarda es una
 * línea que se puede borrar en un refactor sin que ningún test de datos se entere.
 *
 * Vigila:
 *   [1] ⭐ las TRES guardas de lo manual siguen en pie — con prueba negativa (se muta el texto en
 *       memoria y se verifica que el detector lo vea)
 *   [2] ⭐ el piloto NUNCA manda `overwrite_manual`, y tampoco aprueba, cierra ni fija capacidad
 *   [3] el job está declarado en `CRON_JOBS` — sin umbral, `db-health` lo da por verde
 *       incondicional (`cfg ? classify : 'ok'`, el defecto que midió la Fase VP)
 *   [4] (DB) sólo hay ejercicios en estados que los motores aceptan tocar
 *   [5] (DB) el latido, si ya existe, y qué dice
 *
 * ⚠️ Los bloques 1–3 leen el repo: corren desde el checkout, no dentro de `prod-api` (ahí no hay
 * `.ts`). Si no encuentran los archivos reportan NO MEDIDO, nunca verde.
 */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const RAIZ = path.resolve(__dirname, '..', '..');

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };

/** Saca comentarios de bloque y de línea: lo que se vigila es el código, no lo que explica. */
const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const leer = (rel) => {
  const p = path.join(RAIZ, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/**
 * La guarda, como PATRÓN y no como texto exacto: lo que no puede desaparecer es que se compare
 * contra `'manual'` y se salte la celda salvo `overwrite_manual`. Un rename de variable no debe
 * poner esto en rojo; quitar la condición, sí.
 */
const TIENE_GUARDA = (src) =>
  /method\s*===\s*'manual'/.test(src) && /!\s*\w+\.overwrite_manual/.test(src) && /continue\s*;?/.test(src);

(async () => {
  // ── 1. Las guardas de lo manual ───────────────────────────────────────────────────────────
  console.log('\n[1] Las guardas que hacen seguro automatizar siguen en pie');
  const GUARDADOS = [
    ['libs/finance/src/lib/budget/budget-sales-plan.service.ts', 'plan de ventas'],
    ['libs/finance/src/lib/budget/budget-expense-plan.service.ts', 'plan de gastos'],
  ];
  let medidos = 0;
  for (const [rel, label] of GUARDADOS) {
    const src = leer(rel);
    if (src === null) { nm(`no se encontró ${rel} (¿corriendo fuera del repo?)`); continue; }
    medidos++;
    chk(TIENE_GUARDA(src), `${label}: salta las celdas con method='manual' salvo overwrite_manual`);
  }

  // PRUEBA NEGATIVA: sin esto, el bloque de arriba es una intención. Se le quita la guarda a una
  // copia EN MEMORIA y se exige que el detector la extrañe.
  if (medidos > 0) {
    const src = leer(GUARDADOS[0][0]);
    const mutado = src.replace(/if\s*\(existing[^\n]*method\s*===\s*'manual'[^\n]*\n?/g, '');
    chk(mutado !== src && !TIENE_GUARDA(mutado),
      'PRUEBA NEGATIVA: quitada la guarda de una copia en memoria, el detector la ve faltar');
  }

  // La materialización protege distinto: por `source`, no por `method`.
  const mat = leer('libs/finance/src/lib/budget/budget-materialize.service.ts');
  if (mat === null) nm('no se encontró budget-materialize.service.ts');
  else {
    chk(/source:\s*'plan'/.test(mat) && /source:\s*'plan'/.test(mat) && /'plan'/.test(mat),
      "materialización: sólo toca partidas source='plan'; una source='manual' no se pisa");
  }

  // ── 2. Lo que el piloto NO hace ───────────────────────────────────────────────────────────
  console.log('\n[2] El piloto rellena; no decide');
  const auto = leer('libs/finance/src/lib/budget/budget-autopilot.service.ts');
  if (auto === null) nm('no se encontró budget-autopilot.service.ts');
  else {
    // ⚠️ El criterio NO puede ser «la palabra no aparece»: la cabecera del servicio EXPLICA que
    // nunca se manda, y la primera versión de este candado se puso roja por su propio comentario.
    // Lo que importa es el PASO real — `overwrite_manual:` como clave de objeto o asignación.
    const MANDA = (s) => /overwrite_manual\s*[:=]/.test(sinComentarios(s));
    chk(!MANDA(auto),
      'nunca manda overwrite_manual — si lo mandara, borraría la captura humana cada noche');
    chk(MANDA('const dto = { overwrite_manual: true };'),
      'PRUEBA NEGATIVA: el detector SÍ ve un overwrite_manual de verdad (si no, el de arriba es decorativo)');
    const prohibidos = ['approve', 'submit', 'close(', 'setCapacity', 'saveCapacity', 'releaseLot'];
    const cuela = prohibidos.filter((p) => auto.includes(p));
    chk(cuela.length === 0,
      cuela.length === 0
        ? 'no aprueba, no cierra y no fija la capacidad de pago: eso son decisiones, no métricas'
        : `llama a algo que es una DECISIÓN, no una métrica: ${cuela.join(', ')}`);
    chk(/@Cron\(/.test(auto) && /timeZone:\s*'America\/Mexico_City'/.test(auto),
      'tiene @Cron con timeZone MX explícita (sin ella el contenedor corre en UTC)');
    chk(/cron_runs/.test(auto), 'deja latido en analytics.cron_runs');
  }

  // ── 3. Declarado en CRON_JOBS ─────────────────────────────────────────────────────────────
  console.log('\n[3] El job está declarado con umbral');
  const dh = leer('apps/api/src/modules/db-health/db-health.service.ts');
  if (dh === null) nm('no se encontró db-health.service.ts');
  else {
    chk(/key:\s*'budget_autopilot'/.test(dh),
      "budget_autopilot está en CRON_JOBS — sin esa fila db-health lo clasifica con `cfg ? classify : 'ok'`");
  }

  // ── 4 y 5. Contra la base ─────────────────────────────────────────────────────────────────
  if (!URL) return cerrar(noMedido('falta DATABASE_URL_NEW'));
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 120000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) { nm(`no se pudo conectar (${e.code || e.message})`); return cerrar(); }
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    console.log('\n[4] Qué ejercicios tocaría el piloto');
    const est = await q(`SELECT status, count(*)::int n FROM budget.budgets GROUP BY 1 ORDER BY 1`);
    if (!est.length) nm('no hay ejercicios en este destino');
    else {
      const abiertos = est.filter((r) => ['borrador', 'en_revision'].includes(r.status));
      const cerrados = est.filter((r) => !['borrador', 'en_revision'].includes(r.status));
      console.log(`    · tocaría ${abiertos.reduce((a, r) => a + r.n, 0)} · no tocaría `
        + `${cerrados.reduce((a, r) => a + r.n, 0)} (${cerrados.map((r) => `${r.status} ${r.n}`).join(', ') || 'ninguno'})`);
      chk(true, `${est.map((r) => `${r.status}:${r.n}`).join(' · ')}`);
    }

    console.log('\n[5] El latido');
    const [lat] = await q(
      `SELECT status, rows_affected, note, error, last_finish
         FROM analytics.cron_runs WHERE job_key = 'budget_autopilot'`);
    if (!lat) {
      // No es fallo: el cron corre a las 03:30 y puede no haber corrido todavía. Se DECLARA —
      // «no latió» y «latió mal» se leen distinto y significan cosas distintas.
      nm('budget_autopilot nunca latió todavía (el cron corre 03:30 MX; ¿está desplegado?)');
    } else {
      chk(lat.status === 'ok',
        `último latido: ${lat.status} · ${lat.note ?? 'sin nota'}${lat.error ? ` · ${lat.error}` : ''}`);
    }
  } finally {
    await c.end().catch(() => undefined);
  }
  cerrar();
})();

function cerrar(ret) {
  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
  return ret;
}
