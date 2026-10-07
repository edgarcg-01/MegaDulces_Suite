/* eslint-disable no-console */
/**
 * `[VSO.8]` CANDADO — ninguna META capturada apunta a una entidad que ya no existe.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────
 * El presupuesto de ventas guarda sus metas contra un `entity_key` = `canal:almacén`
 * (`mostrador:01`), y las entidades las DERIVA `analytics.v_sales_entity` del universo del
 * sell-out. O sea que el catálogo de entidades **se mueve solo** cuando se mueve el universo — y
 * las metas guardadas NO. Cuando Morelia Abastos pasó de `MD-30` a `08` (`[RL.10]`), las metas
 * capturadas con la llave vieja se quedaron apuntando a una entidad que dejó de existir.
 *
 * Medido en prod el 2026-09-28, sobre 428 renglones de plan:
 *
 *   se ve ......................  29 entidades ·  $312,870,188
 *   la pantalla NO la recorría ..  12 entidades ·   $21,754,366   ← arreglado en [VSO.8]
 *   HUÉRFANA (entidad inexistente)  3 entidades ·  $134,911,911   ← esto es lo que vigila este candado
 *
 * Las tres son `credito:MD-30`, `mostrador:MD-30` y `preventa:MD-30`. No es un error de captura:
 * es el precio de que la llave PERSISTIDA contenga un código que otro proceso puede renombrar.
 *
 * ── ⚠️ POR QUÉ UN BORRADOR NO PONE ESTO EN ROJO ──────────────────────────────────────────────
 * Un presupuesto en `borrador` o `en_revision` se está editando: su dueño va a mover llaves, y un
 * candado que grita mientras alguien trabaja enseña a ignorar el tablero — la lección que esta
 * misma tanda se cobró en `test-newdb-branch-cutover.js`. Los huérfanos de un borrador se
 * REPORTAN con su monto; los de un presupuesto `pendiente`, `aprobado` o `cerrado` FALLAN, porque
 * ahí ya nadie los va a tocar y la cifra autorizada estaría incompleta en silencio.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-budget-entity-sync.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL || process.env.FLEET_DB_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW o FLEET_DB_URL'); })();

/** Estados en los que el presupuesto ya no se edita: ahí un huérfano es una cifra mal publicada. */
const ESTADOS_FIRMES = ['pendiente', 'aprobado', 'cerrado'];

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const SQL_HUERFANAS = `
  SELECT b.status, b.name, b.fiscal_year, l.entity_key,
         count(*)::int AS renglones, sum(l.meta_amount)::numeric AS meta
    FROM budget.sales_plan_lines l
    JOIN budget.budgets b ON b.id = l.budget_id AND b.tenant_id = l.tenant_id
    LEFT JOIN analytics.v_sales_entity e
           ON e.tenant_id = l.tenant_id AND e.entity_key = l.entity_key
   WHERE e.entity_key IS NULL
   GROUP BY 1,2,3,4
   ORDER BY sum(l.meta_amount) DESC`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  const dest = (await q(`SELECT current_database() d, (SELECT system_identifier FROM pg_control_system()) sid`))[0];
  console.log(`\n=== PRESUPUESTO · la meta capturada apunta a una entidad que existe (base "${dest.d}" · sysid ${dest.sid}) ===\n`);

  const hay = async (rel) => (await q(`SELECT to_regclass($1) r`, [rel]))[0].r !== null;
  console.log('0 · HAY CON QUÉ MEDIR');
  const listo = (await hay('budget.sales_plan_lines')) && (await hay('analytics.v_sales_entity')) && (await hay('budget.budgets'));
  check('existen budget.sales_plan_lines, budget.budgets y analytics.v_sales_entity', listo);
  if (!listo) { noMedido('metas contra entidades', 'falta alguno de los tres objetos'); await c.end(); process.exit(fail ? 1 : 0); }

  const [{ n: lineas }] = await q(`SELECT count(*)::int n FROM budget.sales_plan_lines`);
  console.log(`  ⓘ ${lineas} renglón(es) de plan de ventas capturado(s)`);

  // ── 1. Huérfanas ─────────────────────────────────────────────────────────────────────────
  console.log('\n1 · ENTIDADES HUÉRFANAS (la llave guardada ya no existe en el catálogo)');
  if (!lineas) {
    noMedido('ninguna meta apunta a una entidad inexistente',
      'no hay metas capturadas en este destino: "cero huérfanas" sería cierto y no probaría nada');
  } else {
    const huerfanas = await q(SQL_HUERFANAS);
    const firmes = huerfanas.filter((h) => ESTADOS_FIRMES.includes(h.status));
    const borradores = huerfanas.filter((h) => !ESTADOS_FIRMES.includes(h.status));

    check('ningún presupuesto FIRME tiene metas en entidades inexistentes', firmes.length === 0,
      firmes.map((h) => `«${h.name}» ${h.fiscal_year} [${h.status}] ${h.entity_key} ${money(h.meta)}`).join(' · '));

    for (const h of borradores) {
      console.log(`  ⓘ borrador · «${h.name}» ${h.fiscal_year} [${h.status}] · ${h.entity_key}`
        + ` · ${h.renglones} renglón(es) · ${money(h.meta)} — la llave apunta a una entidad que ya no existe;`
        + ' se reporta y NO falla porque el presupuesto todavía se edita');
    }
    if (borradores.length) {
      const tot = borradores.reduce((a, h) => a + Number(h.meta), 0);
      console.log(`  ⓘ total huérfano en borradores: ${money(tot)} en ${borradores.length} entidad(es)`);
    }
  }

  // ── 2. NEGATIVA: el detector tiene dientes ───────────────────────────────────────────────
  // Se inventa una llave imposible dentro de una transacción que SIEMPRE se revierte, sobre un
  // presupuesto FIRME si lo hay. Sin esto, "cero huérfanas" no distingue "está bien" de "no miré".
  console.log('\n2 · PRUEBA NEGATIVA (el detector tiene dientes)');
  if (!lineas) {
    noMedido('una llave inventada dispara el bloque 1', 'no hay renglones que clonar');
  } else {
    // Hoy TODOS los renglones viven en un borrador, así que probar sólo sobre un presupuesto firme
    // dejaría la negativa en NO MEDIDO para siempre — y una negativa que nunca corre no protege
    // nada. Dentro de la transacción revertida se firma el presupuesto ADEMÁS de romper la llave:
    // así se ejercita la regla completa (llave inexistente + estado firme ⇒ falla).
    const [semilla] = await q(
      `SELECT l.id, l.budget_id, l.entity_key, b.status FROM budget.sales_plan_lines l
         JOIN budget.budgets b ON b.id = l.budget_id ORDER BY (b.status = ANY($1)) DESC LIMIT 1`, [ESTADOS_FIRMES]);
    if (!semilla) {
      noMedido('una llave inventada dispara el bloque 1', 'no hay ningún renglón de plan sobre el que probarlo');
    } else {
      const yaFirme = ESTADOS_FIRMES.includes(semilla.status);
      let detecto = null;
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '5s'`);
        if (!yaFirme) await c.query(`UPDATE budget.budgets SET status = 'pendiente' WHERE id = $1`, [semilla.budget_id]);
        await c.query(
          `UPDATE budget.sales_plan_lines SET entity_key = 'canal-inventado:ALMACEN-QUE-NO-EXISTE' WHERE id = $1`,
          [semilla.id]);
        const otra = await c.query(SQL_HUERFANAS);
        detecto = otra.rows.some((h) => h.entity_key === 'canal-inventado:ALMACEN-QUE-NO-EXISTE'
          && ESTADOS_FIRMES.includes(h.status));
      } finally {
        await c.query('ROLLBACK');
      }
      check(`una llave inventada en un presupuesto firme dispara el bloque 1${yaFirme ? '' : ' (el presupuesto se firmó dentro de la transacción revertida)'}`,
        detecto === true, 'el detector NO la vio: el bloque 1 no protege nada');
      const [vuelta] = await q(
        `SELECT l.entity_key k, b.status s FROM budget.sales_plan_lines l
           JOIN budget.budgets b ON b.id = l.budget_id WHERE l.id = $1`, [semilla.id]);
      check('el ROLLBACK dejó la meta Y el estado del presupuesto intactos',
        !!vuelta && vuelta.k === semilla.entity_key && vuelta.s === semilla.status,
        `quedó llave=${vuelta ? vuelta.k : '(sin fila)'} estado=${vuelta ? vuelta.s : '—'} — revisar a mano`);
    }
  }

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${fail ? '✖' : '✅'} ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
