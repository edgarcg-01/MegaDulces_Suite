'use strict';
/**
 * `[CB.54]` — **Egresos que el motor de reglas dejaba sin categoría** (`classified_by='rule'`, resultado
 * `sin_clasificar`), por tres huecos medidos. Lo encontró la búsqueda de «Oscar Hernandez» en el puente ContPAQi
 * (`[CP.8.78]`): su pago no estaba en ninguna lista porque no tenía categoría.
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-10-22, `system_identifier` 7688376744939610156) ─────────────
 *
 *  · Ene–oct 2026: **5,686 egresos sin categoría, $53.2 M** (banco 1,182 / $40.6 M · Caja General 4,504).
 *    Cada mes 12–26 %. Sólo 234 categorizaciones manuales en el año: nadie los corrige después.
 *  · Hueco 1 — **el texto viene en la columna de CÓDIGO** y el concepto vacío (BANORTE 7744, SANTANDER 2169):
 *    «Nomina 06», «Comision», «PAGO DE CAPITAL 0893…», «Seguros Banorte». Las reglas miran el concepto.
 *  · Hueco 2 — **nómina, traslado de valores y SUA con un código distinto** del que sus reglas exigen
 *    (151 sólo 613; 144 sólo 612 y «PAN AMERICANO» con espacio, cuando llega «Panamericano»).
 *  · Hueco 3 — **la línea de crédito revolvente** (tipos LC/PLEM/PL/TL) con código «/» o vacío: sólo la regla
 *    82 (código «-») los tomaba. Los 9 ya categorizados de esos tipos están TODOS en `traspaso_entre_cuentas`;
 *    se usa la misma, para que el mismo concepto no viva en dos categorías.
 *
 * ⭐ Simulado con el motor real (`classifyWith`, extraído del servicio) sobre todo 2026. CONTROL: reproduce
 *    30,915 de 30,915 movimientos clasificados por regla. Con estas reglas: **se categorizan ~200 que hoy no
 *    tienen ($19 M) y CAMBIA 0 de los ya categorizados** — van todas al final (prioridad 880+), así que sólo
 *    pueden tocar lo que ninguna regla anterior tomaba.
 *
 * ⛔ Lo que se DESCARTÓ: «usar el código como concepto cuando el concepto viene vacío». Medido: mandaba 71
 *    cargos «Comision» de BANORTE 7744 (~$77 c/u, comisión BANCARIA) a `comisiones_venta` por la regla 164
 *    (pensada para Caja General). Por eso las reglas de código son explícitas, una por texto.
 *
 * ⛔ Lo que NO resuelve: el beneficiario con nombre propio en 612/613 («Oscar Hernandez», «Valentin
 *    Oyanguren»): ninguna palabra clave lo reconoce. Eso necesita que una persona decida una vez por nombre.
 *
 * ⚠️ No crea objetos de esquema (INSERT de reglas + UPDATE de movimientos): la compuerta de despliegue la
 *    clasifica NO_MEDIDO. Aplicar a prod con `apply-one-migration-prod.js` ANTES de mergear.
 *
 * Idempotente: reglas por `ON CONFLICT (tenant_id, priority)`; el UPDATE sólo toca movimientos SIN categoría y
 * nunca lo clasificado a mano.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const NOTA = 'CB.54';

/** Las reglas nuevas. Exportadas: la prueba y la simulación usan ESTAS, no una copia. */
const REGLAS = [
  // Hueco 1 · el texto en la columna de código.
  { priority: 880, match_type: null, match_code: '^COMISI', match_concept: null, category_code: 'comision_bancaria', note: 'Comisión bancaria con el texto en el código (BANORTE)' },
  { priority: 881, match_type: null, match_code: String.raw`^(NOMINA|NÓMINA|NOM)\b|^NOM ?[0-9]`, match_concept: null, category_code: 'nomina', note: 'Nómina con el texto en el código' },
  { priority: 882, match_type: null, match_code: '^PAGO DE (CAPITAL|INTERES)', match_concept: null, category_code: 'pago_credito', note: 'Pago de capital/intereses con el texto en el código' },
  { priority: 883, match_type: null, match_code: '^SEGURO', match_concept: null, category_code: 'gasto_admin', note: 'Seguros con el texto en el código' },
  // Hueco 3 · la línea de crédito revolvente contra cheques.
  { priority: 890, match_type: '^(LC|PLEM|PL|TL)$', match_code: null, match_concept: null, category_code: 'traspaso_entre_cuentas', note: 'Línea de crédito LEM/LC contra cheques (los ya categorizados están en traspaso)' },
  // Hueco 2 · conceptos claros con un código que su regla no esperaba.
  { priority: 900, match_type: null, match_code: null, match_concept: String.raw`NOMINA|NÓMINA|\bNOM\b|\bNOM ?[0-9]`, category_code: 'nomina', note: 'Nómina con cualquier código' },
  { priority: 901, match_type: null, match_code: null, match_concept: 'PAN ?AMERICANO|ARMO?STRONG|ARMORED|TRASLADO DE VALORES', category_code: 'traslado_valores', note: 'Traslado de valores con cualquier código' },
  { priority: 902, match_type: null, match_code: null, match_concept: String.raw`\bSUA\b|\bIMSS\b`, category_code: 'imss_sua', note: 'SUA/IMSS con cualquier código' },
  { priority: 903, match_type: null, match_code: null, match_concept: 'PAGO DE (CAPITAL|INTERES)', category_code: 'pago_credito', note: 'Pago de capital/intereses con cualquier código' },
];

/**
 * El mismo motor que `classifyWith` (`libs/finance/src/lib/bank/finance-bank.service.ts`): `normKey` + regex
 * con `i`, por prioridad, gana la primera. ⚠️ Duplicado a propósito: una migración no importa TypeScript. La
 * prueba `bank-rules-cb54.spec.ts` corre ESTA función y la del servicio sobre los mismos casos y exige que den igual.
 */
function clasificar(reglas, M, C, concepto) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const seguro = (p) => { if (!p) return null; try { return new RegExp(p, 'i'); } catch { return null; } };
  const m = norm(M), c = norm(C), t = norm(concepto);
  for (const r of [...reglas].sort((a, b) => a.priority - b.priority)) {
    const rt = seguro(r.match_type), rc = seguro(r.match_code), rx = seguro(r.match_concept);
    if (rt && !rt.test(m)) continue;
    if (rc && !rc.test(c)) continue;
    if (rx && !rx.test(t)) continue;
    return r.category_code;
  }
  return 'sin_clasificar';
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const r of REGLAS) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, true)
       ON CONFLICT (tenant_id, priority) DO UPDATE
         SET match_type = EXCLUDED.match_type, match_code = EXCLUDED.match_code,
             match_concept = EXCLUDED.match_concept, category_code = EXCLUDED.category_code,
             note = EXCLUDED.note, active = true, updated_at = now()`,
      [TENANT, r.priority, r.match_type, r.match_code, r.match_concept, r.category_code, `${r.note} (${NOTA})`],
    );
  }

  // Reclasificar SÓLO lo que hoy no tiene categoría, con el catálogo completo ya con las reglas nuevas.
  const reglas = (await knex.raw(
    `SELECT priority, match_type, match_code, match_concept, category_code
       FROM finance.bank_classify_rules WHERE tenant_id = ? AND active`, [TENANT])).rows;
  const sin = (await knex.raw(
    `SELECT id, raw_type, raw_code, concept FROM finance.bank_movements
      WHERE tenant_id = ? AND deleted_at IS NULL AND category_id IS NULL
        AND COALESCE(classified_by, '') <> 'manual'`, [TENANT])).rows;
  const porCategoria = new Map();
  for (const m of sin) {
    const cat = clasificar(reglas, m.raw_type, m.raw_code, m.concept);
    if (cat === 'sin_clasificar') continue;
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(m.id);
  }
  const resumen = [];
  for (const [cat, ids] of porCategoria) {
    const r = await knex.raw(
      `UPDATE finance.bank_movements m
          SET category_id = c.id, classified_by = 'rule', updated_at = now()
         FROM finance.movement_categories c
        WHERE c.tenant_id = m.tenant_id AND c.code = ?
          AND m.tenant_id = ? AND m.id = ANY(?::uuid[])
          AND m.category_id IS NULL AND COALESCE(m.classified_by, '') <> 'manual'`,
      [cat, TENANT, ids],
    );
    resumen.push(`${cat} ${r.rowCount}`);
  }
  console.log(`[${NOTA}] ${REGLAS.length} reglas en su lugar · de ${sin.length} sin categoría se categorizan: ${resumen.join(', ') || 'ninguno'}`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up` en el catálogo: retira las reglas. ⛔ NO vuelve los movimientos a
 * «sin categoría»: sería reponer el defecto. Si hiciera falta, `reclassifyAll` con las reglas ya retiradas.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `DELETE FROM finance.bank_classify_rules
      WHERE tenant_id = ? AND priority = ANY(?) AND note LIKE ?`,
    [TENANT, REGLAS.map((r) => r.priority), `%(${NOTA})%`],
  );
};

exports.REGLAS = REGLAS;
exports.clasificar = clasificar;
