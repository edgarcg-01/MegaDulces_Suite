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

    // ⛔⛔ EL BUG QUE ESTO CAZA, y que ya ocurrió: `budget.budgets` tiene RLS FORZADO, así que
    // listarla sin contexto de tenant no falla — devuelve CERO FILAS. En la primera corrida real
    // (2026-10-07 03:30) el piloto recorrió «0/0 ejercicios» con 2 en la tabla y latió **ok**.
    // La lista TIENE que salir de `public.tenants` (que no tiene RLS) y leerse con el contexto
    // abierto.
    const codAuto = sinComentarios(auto);
    chk(/public\.tenants/.test(codAuto),
      'la lista de a-quién-mirar sale de public.tenants (sin RLS), no de una tabla con RLS forzado');
    chk(/vistos === 0/.test(codAuto) || /vistos\s*===\s*0/.test(codAuto),
      'un universo vacío se DECLARA como falla: «no vi nada» y «no hay nada» son indistinguibles con RLS');
  }

  // ── 2b. `[VE.4]` El quinto motor: obligaciones que se proponen SIN FIRMA ──────────────────
  console.log('\n[2b] Las obligaciones nacen en propuesta, no comprometidas');
  const obl = leer('libs/finance/src/lib/payment-calendar/budget-expense-obligations.service.ts');
  const oblAuto = leer('libs/finance/src/lib/payment-calendar/obligations-autopilot.service.ts');
  if (obl === null || oblAuto === null) nm('no se encontró el servicio de obligaciones o su piloto');
  else {
    const codigo = sinComentarios(obl);
    // ⛔ LO QUE NO PUEDE CAMBIAR: si el insert pasara a 'pending', el automático dejaría de
    // preparar una lista y empezaría a COMPROMETER PAGOS SOLO todas las noches. El paso
    // propuesta→pending tiene que seguir siendo un acto humano con firma (`authorized_by`).
    chk(/status:\s*'propuesta'/.test(codigo),
      "generateFromPlan inserta en estado 'propuesta' — lo generado NO entra al Calendario");
    chk(/status:\s*'pending'[\s\S]{0,200}authorized_by/.test(codigo),
      'el paso propuesta→pending escribe authorized_by: sigue siendo un acto humano con firma');
    chk(!/authorize\s*\(/.test(sinComentarios(oblAuto)),
      'el piloto NO llama a authorize — propone y se detiene antes de la firma');
    chk(/@Cron\(/.test(oblAuto) && /timeZone:\s*'America\/Mexico_City'/.test(oblAuto),
      'tiene @Cron con timeZone MX explícita');
    chk(/cron_runs/.test(oblAuto), 'deja latido en analytics.cron_runs');
  }

  // ── 2c. `[VE.9.2]` ⛔ QUIÉN EMITE la consulta ──────────────────────────────────────────────
  //
  // El bug que se cobró esta pasada DOS veces. Los dos pilotos listaban `budget.budgets` con el
  // knex CRUDO (`KNEX_NEW_DB`) desde adentro de su helper de contexto, y eso NO alcanza: abrir el
  // contexto CLS dice *qué* tenant es, pero el `set_config('app.tenant_id')` lo emite
  // `TenantKnexService.run()`. Con RLS **forzado** en `budget.*`, el crudo no falla: devuelve CERO
  // FILAS, y la pasada reporta sobre nada.
  //
  // ⚠️ Acá vivía la aserción EQUIVOCADA: pedía que la consulta estuviera «dentro de conTenant(…)»
  // — y eso era cierto mientras el bug estaba vivo. Un candado puede estar verde sobre el
  // invariante que no es. La lección no es *abrí el contexto*, es **quién emite la consulta**.
  //
  // ⭐ Y va en el bloque de CÓDIGO, no en el de resultado: mirando sólo la base, este bug se ve
  // igual que «todavía no corrió» y sale NO MEDIDO, nunca rojo.
  console.log('\n[2c] Ningún piloto lee budget.* por el knex crudo');
  /** Devuelve las lecturas crudas sobre un schema con RLS forzado. Vacío = limpio. */
  const CRUDO_SOBRE_BUDGET = (src) => {
    const hits = [];
    const re = /this\.knex(?:\.raw)?\s*\(\s*(['"`])([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(sinComentarios(src))) !== null) {
      if (/\bbudget\./.test(m[2])) hits.push(m[2].replace(/\s+/g, ' ').slice(0, 70));
    }
    return hits;
  };
  for (const [nombre, src] of [['budget-autopilot', auto], ['obligations-autopilot', oblAuto]]) {
    if (src === null) { nm(`no se encontró ${nombre}: no se puede juzgar quién emite sus consultas`); continue; }
    const hits = CRUDO_SOBRE_BUDGET(src);
    chk(hits.length === 0, hits.length === 0
      ? `${nombre}: ninguna lectura de budget.* por el knex crudo`
      : `${nombre}: lee budget.* con el knex CRUDO → ${hits.join(' | ')} (RLS forzado devuelve 0 filas SIN fallar)`);
    chk(/this\.tk\.run\(|listBudgets\(/.test(sinComentarios(src)),
      `${nombre}: la lista de ejercicios pasa por TenantKnexService`);
  }
  // Y que el intermediario no sea el mismo bug mudado de archivo.
  const gen = leer('libs/finance/src/lib/budget/budget-generation.service.ts');
  if (gen === null) nm('no se encontró budget-generation.service.ts');
  else {
    chk(/async listBudgets\([\s\S]{0,200}this\.tk\.run\(/.test(sinComentarios(gen)),
      'listBudgets() emite por this.tk.run() — es el único punto que aplica app.tenant_id');
  }
  // ⭐ PRUEBAS NEGATIVAS: un gate sin ellas es una intención (ADR-056). Y las dos direcciones,
  // porque un detector que marca todo es tan inútil como uno que no marca nada.
  chk(CRUDO_SOBRE_BUDGET("const x = this.knex('budget.budgets').select('id');").length === 1,
    'PRUEBA NEGATIVA: el detector SÍ ve una lectura cruda de budget.* cuando la hay');
  chk(CRUDO_SOBRE_BUDGET("const t = this.knex('public.tenants').select('id');").length === 0,
    'PRUEBA NEGATIVA: no marca public.tenants, que no tiene RLS y de ahí TIENE que salir la lista');

  // ── 3. Declarado en CRON_JOBS ─────────────────────────────────────────────────────────────
  console.log('\n[3] El job está declarado con umbral');
  const dh = leer('apps/api/src/modules/db-health/db-health.service.ts');
  if (dh === null) nm('no se encontró db-health.service.ts');
  else {
    chk(/key:\s*'budget_autopilot'/.test(dh),
      "budget_autopilot está en CRON_JOBS — sin esa fila db-health lo clasifica con `cfg ? classify : 'ok'`");
    chk(/key:\s*'obligations_autopilot'/.test(dh),
      'obligations_autopilot está en CRON_JOBS');
  }

  // ── [3b] [PU.V4] El piloto corre DESPUÉS del refresco, y además DEPENDE de él ─────────────
  //
  // Dos cosas distintas, y hacen falta las dos. La hora sola no alcanza: **ordenar no es
  // depender** (ADR-056). Si el refresco falla, a las 07:30 la matvista sigue ahí —vieja— y
  // proponer sobre ella escribe metas que se ven perfectas.
  //
  // Lo que lo hizo necesario está en `analytics.cron_runs` del 2026-10-08 03:30: `0/2 ejercicios`
  // y *«El histórico de ventas se está generando (primera vez)»* — el 503 del Parquet que cada
  // despliegue borraba. El plan de gastos sí se escribía; el de ventas no, y el mayoreo quedó
  // congelado sobre una base vieja.
  console.log('\n[3b] El piloto corre después del refresco, y depende de él');
  const ap = leer('libs/finance/src/lib/budget/budget-autopilot.service.ts');
  const ar = leer('libs/commercial/src/lib/commercial-analytics/analytics-refresh.service.ts');
  if (ap === null || ar === null) nm('no se encontraron el piloto y/o el refresco de analytics');
  else {
    // La hora de cada uno, leída del `@Cron` — no de un comentario, que es justo lo que mintió.
    const horaDe = (src, marca) => {
      const re = new RegExp(`@Cron\\('0 (\\d+) (\\d+) \\* \\* \\*'[^)]*\\)[\\s\\S]{0,400}?${marca}`);
      const m = src.match(re);
      return m ? Number(m[2]) * 60 + Number(m[1]) : null;
    };
    const tPiloto = horaDe(ap, 'async scheduled');
    const tRefresco = horaDe(ar, 'async refreshWincajaDaily');
    if (tPiloto === null || tRefresco === null) nm('no pude leer la hora de alguno de los dos @Cron');
    else {
      // El lote nocturno cierra ~30 min después de arrancar (medido 06:20 → 06:49 el 2026-10-07).
      chk(tPiloto > tRefresco + 30,
        `el piloto (${String(Math.floor(tPiloto / 60)).padStart(2, '0')}:${String(tPiloto % 60).padStart(2, '0')}) corre después del refresco `
        + `(${String(Math.floor(tRefresco / 60)).padStart(2, '0')}:${String(tRefresco % 60).padStart(2, '0')}) + 30 min de lote`);
    }

    // La dependencia: el piloto pregunta por la FRESCURA y no escribe si no la tiene.
    chk(/baseServible\s*\(/.test(ap), 'el piloto consulta `baseServible()` antes de proponer');
    chk(/ROLLUP_MAX_H/.test(ap) && /dataAsOf/.test(ap),
      'la guarda mide la antigüedad del rollup (`dataAsOf` contra `ROLLUP_MAX_H`), no sólo si hay filas');
    const guardados = (ap.match(/if \(base\.ok\) try \{/g) || []).length;
    chk(guardados >= 2,
      `los dos bloques que leen el rollup (supuestos y plan de ventas) están bajo la guarda — hay ${guardados}`);

    // ⭐ PRUEBA NEGATIVA: con la guarda quitada, el detector TIENE que ponerse rojo. Sin esto,
    //    estas tres aserciones de arriba son una intención, no una compuerta.
    const mutado = ap.replace(/if \(base\.ok\) try \{/g, 'try {');
    const detectaMutacion = (mutado.match(/if \(base\.ok\) try \{/g) || []).length === 0;
    chk(detectaMutacion, 'PRUEBA NEGATIVA: quitando la guarda, el detector la deja de ver (no es un regex que siempre pasa)');

    // Y que la cadencia declarada en CRON_JOBS no se quede mintiendo respecto del @Cron.
    if (dh !== null && tPiloto !== null) {
      const dec = dh.match(/key:\s*'budget_autopilot'[^}]*cadence:\s*'[^']*?(\d{2}):(\d{2})/);
      chk(!!dec && Number(dec[1]) * 60 + Number(dec[2]) === tPiloto,
        `la cadencia declarada en CRON_JOBS coincide con el @Cron (declara ${dec ? dec[1] + ':' + dec[2] : '—'})`);
    }
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
    for (const job of ['budget_autopilot', 'obligations_autopilot']) {
      const [lat] = await q(
        `SELECT status, rows_affected, note, error FROM analytics.cron_runs WHERE job_key = $1`, [job]);
      if (!lat) {
        // No es fallo: los crons corren de madrugada y pueden no haber corrido todavía. Se
        // DECLARA — «no latió» y «latió mal» se leen distinto y significan cosas distintas.
        nm(`${job} nunca latió todavía (¿está desplegado?)`);
      } else {
        chk(lat.status === 'ok',
          `${job}: ${lat.status} · ${lat.note ?? 'sin nota'}${lat.error ? ` · ${lat.error}` : ''}`);

        // ⭐⭐ LA ASERCIÓN QUE HABRÍA CAZADO EL BUG SOLA, y por la que existe este bloque: el
        // latido puede decir `ok` sobre CERO. Si el piloto no recorrió ningún ejercicio pero la
        // tabla tiene alguno que le corresponde, no terminó bien: no vio nada.
        const [u] = await q(
          `SELECT count(*) FILTER (WHERE status IN ('borrador','en_revision'))::int abiertos,
                  count(*) FILTER (WHERE status <> 'cerrado')::int no_cerrados
             FROM budget.budgets`);
        const debio = job === 'budget_autopilot' ? Number(u.abiertos) : Number(u.no_cerrados);
        const recorrio = /^(\d+)[/ ]/.exec(String(lat.note ?? ''));
        const vistos = recorrio ? Number(recorrio[1]) : null;
        if (vistos === null) nm(`${job}: la nota no dice cuántos recorrió`);
        else {
          chk(!(debio > 0 && vistos === 0),
            vistos === 0 && debio > 0
              ? `${job} recorrió 0 ejercicios y hay ${debio} que le tocan — no vio nada (¿RLS sin contexto?)`
              : `${job} recorrió ${vistos} y le tocan ${debio}`);
        }
      }
    }

    // `[VE.4]` Y lo que de verdad importa del automático de obligaciones: que lo que generó
    // siga ESPERANDO FIRMA. Una propuesta que se autoriza sola sería un pago comprometido por
    // un cron.
    const oblEst = await q(
      `SELECT status, count(*)::int n, count(*) FILTER (WHERE authorized_by IS NOT NULL)::int firmadas
         FROM budget.expense_obligations GROUP BY 1 ORDER BY 1`);
    if (!oblEst.length) nm('no hay obligaciones todavía: el automático no ha corrido o no hay plan de gastos');
    else {
      const malas = oblEst.filter((r) => r.status !== 'propuesta' && r.status !== 'cancelled' && r.firmadas < r.n);
      chk(malas.length === 0,
        malas.length === 0
          ? `${oblEst.map((r) => `${r.status}:${r.n}`).join(' · ')} — toda obligación comprometida tiene firma`
          : `obligaciones comprometidas SIN authorized_by: ${malas.map((r) => `${r.status} ${r.n - r.firmadas}`).join(', ')}`);
    }
    // ── 6. `[VE.5]` Folio, procedencia y completitud ────────────────────────────────────
    console.log('\n[6] El ejercicio tiene folio, la generación deja procedencia, y lo vacío no se firma');

    const sinFolio = await q(`SELECT count(*)::int n FROM budget.budgets WHERE folio IS NULL`);
    chk(Number(sinFolio[0].n) === 0,
      `${sinFolio[0].n} ejercicios sin folio — el folio es la identidad; el nombre es texto libre `
      + '(de ahí salió «presupesto»)');

    const dupFolio = await q(
      `SELECT count(*)::int n FROM (
         SELECT tenant_id, folio FROM budget.budgets WHERE folio IS NOT NULL
          GROUP BY 1,2 HAVING count(*) > 1) d`);
    chk(Number(dupFolio[0].n) === 0, 'ningún folio repetido (la secuencia es atómica, no max()+1)');

    const rls = await q(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE oid IN ('budget.generation_runs'::regclass, 'budget.folio_sequences'::regclass)`);
    chk(rls.length === 2 && rls.every((r) => r.relforcerowsecurity === true),
      'generation_runs y folio_sequences con RLS FORZADO');

    const runs = await q(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE assumptions IS NULL)::int sin_supuestos,
              count(*) FILTER (WHERE status = 'ok' AND output IS NULL)::int ok_sin_salida
         FROM budget.generation_runs`);
    if (!Number(runs[0].total)) {
      nm('todavía no hay corridas registradas (el piloto no ha corrido con este código)');
    } else {
      // ⭐ Una corrida que dice `ok` y no deja con QUÉ calculó ni QUÉ entregó es justo el agujero
      // que esta tabla vino a tapar: un valor derivado que nadie puede auditar.
      chk(Number(runs[0].ok_sin_salida) === 0,
        `${runs[0].total} corridas · ${runs[0].ok_sin_salida} en «ok» sin registrar qué entregaron`);
      chk(Number(runs[0].sin_supuestos) === 0,
        `${runs[0].sin_supuestos} corridas sin los supuestos con que calcularon`);
    }

    // ⛔ EL CASO VIVO: `prueba` FY2026 está en `pendiente` —esperando autorización— con 0 planes y
    // 0 partidas. La compuerta nueva impide que se repita, pero NO arregla el que ya pasó: queda
    // acá en rojo hasta que alguien lo cancele o lo devuelva a borrador. Un ejercicio vacío
    // esperando firma es alguien a punto de aprobar nada.
    const vacios = await q(
      `SELECT b.folio, b.name, b.fiscal_year, b.status
         FROM budget.budgets b
        WHERE b.status IN ('pendiente', 'aprobado')
          AND NOT EXISTS (SELECT 1 FROM budget.sales_plan_lines s WHERE s.budget_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM budget.expense_plan_lines e WHERE e.budget_id = b.id)`);
    chk(vacios.length === 0,
      vacios.length === 0
        ? 'ningún ejercicio vacío esperando o con firma'
        : `${vacios.length} ejercicio(s) VACÍOS fuera de borrador: `
          + `${vacios.map((v) => `${v.folio ?? v.name} FY${v.fiscal_year} (${v.status})`).join(', ')}`
          + ' — aprobarlos es aprobar nada, y salen del alcance del piloto para siempre');
    // ── 7. `[VE.9]` LA CADENA COMPLETA, de punta a punta ────────────────────────────────
    //
    // Los bloques de arriba miran el código y la forma; éste mira el RESULTADO: que una pasada
    // real haya producido un presupuesto armado. Es la prueba e2e — si nunca corrió, se DECLARA
    // (no hay nada que juzgar), pero si corrió y dejó la cadena a medias, falla.
    console.log('\n[7] Una pasada real arma la cadena entera');
    const [pasada] = await q(
      `SELECT folio, status, output, assumptions, started_at
         FROM budget.generation_runs ORDER BY started_at DESC LIMIT 1`);

    // ⛔ `[VE.9.2]` «No hay pasada registrada» tiene DOS causas y no son la misma: o nunca corrió
    // —y entonces no hay nada que juzgar— o corrió y se cayó ANTES de abrir el registro, que es
    // exactamente lo que pasó el 2026-10-07 (el piloto creó el ejercicio, no vio ninguno, y no
    // abrió ni un `generation_runs`). El latido distingue las dos, así que lo medible se mide.
    const [latido] = await q(
      `SELECT status, note, error, last_finish FROM analytics.cron_runs
        WHERE job_key = 'budget_autopilot' LIMIT 1`);

    if (!pasada && latido && String(latido.status) === 'error') {
      fail++;
      console.log(`  ✖ el piloto corrió y NO dejó registro de generación: ${latido.error || latido.note}`);
    } else if (!pasada) {
      nm('ninguna pasada registrada y el latido no declara error: la cadena no se puede juzgar todavía');
    } else {
      console.log(`    · última pasada ${pasada.folio} (${pasada.status})`);
      chk(pasada.status === 'ok', `la pasada ${pasada.folio} terminó en «${pasada.status}»`);

      // 7.1 — el ejercicio existe y lo creó el sistema
      const [ej] = await q(
        `SELECT folio, name, fiscal_year, status, created_by FROM budget.budgets
          ORDER BY created_at DESC LIMIT 1`);
      if (!ej) { fail++; console.log('  ✖ hubo pasada y NO hay ejercicio'); }
      else {
        chk(/^PRE-\d{4}-\d{3}$/.test(String(ej.folio)),
          `ejercicio ${ej.folio} «${ej.name}» FY${ej.fiscal_year} (${ej.status}), creado por ${ej.created_by}`);
      }

      // 7.2 — los supuestos se derivaron sobre el canal CANÓNICO
      const [sup] = await q(
        `SELECT growth_by_channel gbc,
                (SELECT count(*) FROM jsonb_object_keys(growth_by_channel))::int n
           FROM budget.sales_plan_settings ORDER BY updated_at DESC LIMIT 1`);
      if (!sup) nm('sin supuestos guardados: la pasada no llegó a derivarlos');
      else {
        const alias = await q(
          `SELECT DISTINCT raw_channel FROM analytics.sellout_channel_map
            WHERE raw_channel <> canonical_channel`);
        const muertos = alias.map((r) => r.raw_channel);
        const claves = Object.keys(sup.gbc || {});
        const colados = claves.filter((k) => muertos.includes(k));
        chk(colados.length === 0,
          colados.length === 0
            ? `${sup.n} supuestos derivados, ninguno sobre un canal alias (${claves.join(', ')})`
            : `supuestos sobre canal ALIAS: ${colados.join(', ')} — el derivador leyó el vocabulario crudo`);
      }

      // 7.3 — el plan, las partidas y las obligaciones
      const [cad] = await q(
        `SELECT (SELECT count(*) FROM budget.sales_plan_lines)::int plan,
                (SELECT count(DISTINCT period_no) FROM budget.sales_plan_lines)::int periodos,
                (SELECT count(*) FROM budget.expense_plan_lines)::int gastos,
                (SELECT count(*) FROM budget.budget_lines)::int partidas,
                (SELECT count(*) FROM budget.expense_obligations)::int oblig,
                (SELECT count(*) FROM budget.expense_obligations WHERE status <> 'propuesta')::int oblig_firmadas`);
      chk(cad.plan > 0, `plan de ventas: ${cad.plan} celdas en ${cad.periodos} de 13 periodos`);
      console.log(`    · gastos ${cad.gastos} · partidas ${cad.partidas} · obligaciones ${cad.oblig}`);
      // ⛔ Lo único inadmisible de este bloque: que el automático haya FIRMADO algo.
      chk(Number(cad.oblig_firmadas) === 0,
        `${cad.oblig_firmadas} obligaciones fuera de «propuesta» — el piloto no autoriza, eso lo firma una persona`);
      if (!cad.gastos) nm('plan de gastos en 0: o no hay histórico de egresos, o ese paso falló');
      if (!cad.partidas) nm('partidas en 0: la materialización no llegó a correr');
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
