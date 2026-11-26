#!/usr/bin/env node
/**
 * [PQ.157] C1 — la decisión de Compras sobre cada renglón aplicado a otro costo que el de su OC, contra base REAL.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * `commercial.application_cost_decisions` (mig 20261126001925) guarda accept / claim / promotion por renglón de
 * aplicación (anexo R §3d–§3e). Antes de que exista la API, lo que tiene que ser verdad en la base:
 *
 *  1. **Las listas del código = los CHECK.** `DECISIONES_COSTO` y `ESTADOS_COSTO_DECIDIBLES` de
 *     `libs/contracts/src/http/application-cost.contract.ts` son EXACTAMENTE lo que aceptan los CHECK.
 *  2. **El corte de «igual» es uno solo:** `CENTAVO_COSTO` y `TOL_COSTO` del dominio son los `CENTAVO` y `TOL` de la
 *     vista de C0 (mig 20261125214023). Si se separan, la pantalla diría «ya se aceptó» con otro corte que la vista.
 *  3. **Los casos de la maqueta entran:** aceptar lo que sube y lo que baja, reclamar la diferencia completa y una
 *     parte (con el centavo de holgura), una promoción con fecha de fin.
 *  4. **Negativas, una por regla del CHECK**, y las dos columnas obligatorias que más importan (motivo y estado).
 *  5. **Una decisión viva por renglón;** reemplazarla (`superseded_*`) libera el renglón para la nueva.
 *  6. **Como `app_runtime`** (el rol de prod): reemplaza con UPDATE, NO puede borrar; con otro tenant (RLS) no ve nada
 *     ni puede escribir.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin la tabla (migración 20261126001925 sin aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const RAIZ = path.join(__dirname, '..', '..');
const CONTRATO = path.join(RAIZ, 'libs', 'contracts', 'src', 'http', 'application-cost.contract.ts');
// Las reglas puras viven en el contrato (las comparten la API y la pantalla); application-cost.domain.ts sólo las reexporta.
const DOMINIO = CONTRATO;
const VISTA_C0 = path.join(RAIZ, 'database', 'migrations-newdb', '20261125214023_pq157_costo_de_la_aplicacion_contra_la_oc.js');
const T = 'commercial.application_cost_decisions';

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

/** Las listas del contrato, leídas del CÓDIGO (una copia aquí se quedaría vieja). */
function listaDelContrato(nombre) {
  const src = fs.readFileSync(CONTRATO, 'utf8');
  const m = src.match(new RegExp(`export const ${nombre}: readonly \\w+\\[\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`no encontré ${nombre} en ${CONTRATO}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}
const constanteDe = (archivo, nombre) => {
  const m = fs.readFileSync(archivo, 'utf8').match(new RegExp(`const ${nombre}\\s*=\\s*([0-9.]+)`));
  return m ? Number(m[1]) : null;
};

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq157-decisions', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  let dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[PQ.157] C1 la decisión de costo por renglón  —  ${dest.u}@${dest.d}\n`);

  if (!(await c.query(`SELECT to_regclass($1) IS NOT NULL ok`, [T])).rows[0].ok) {
    NM(`${T} no existe (migración 20261126001925 sin aplicar)`);
    await c.end();
    process.exit(2);
  }

  // 1. Las listas del código = los CHECK.
  const defs = (await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                                WHERE conrelid = $1::regclass AND contype = 'c'`, [T])).rows;
  const valoresDe = (col) => [...new Set(defs.flatMap(({ def }) => {
    const out = [];
    for (const m of def.matchAll(new RegExp(`\\(?\\b${col} = '([^']+)'::text\\)?`, 'g'))) out.push(m[1]);
    for (const m of def.matchAll(new RegExp(`\\b${col} = ANY \\(ARRAY\\[([^\\]]+)\\]\\)`, 'g'))) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    return out;
  }))].sort();
  // La lista de decisiones se lee de SU CHECK: los demás CHECK mencionan 'claim' y 'promotion' sueltos.
  const defDecision = defs.find((d) => d.conname === 'application_cost_decisions_decision_chk')?.def ?? '';
  const decisionesCheck = [...defDecision.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  const contratoDecisiones = listaDelContrato('DECISIONES_COSTO');
  if (JSON.stringify(decisionesCheck) === JSON.stringify(contratoDecisiones)) P(`decision: el contrato y el CHECK aceptan lo mismo (${contratoDecisiones.join(', ')})`);
  else F(`decision: el contrato dice [${contratoDecisiones}] y el CHECK acepta [${decisionesCheck}]`);
  const estadosCheck = valoresDe('cost_state');
  const contratoEstados = listaDelContrato('ESTADOS_COSTO_DECIDIBLES');
  if (JSON.stringify(estadosCheck) === JSON.stringify(contratoEstados)) P(`cost_state: el contrato y el CHECK aceptan lo mismo (${contratoEstados.join(', ')})`);
  else F(`cost_state: el contrato dice [${contratoEstados}] y el CHECK acepta [${estadosCheck}]`);

  // 2. Un solo corte de «igual».
  const [cenDom, tolDom, cenVista, tolVista] = [constanteDe(DOMINIO, 'CENTAVO_COSTO'), constanteDe(DOMINIO, 'TOL_COSTO'),
    constanteDe(VISTA_C0, 'CENTAVO'), constanteDe(VISTA_C0, 'TOL')];
  if (cenDom != null && cenDom === cenVista && tolDom != null && tolDom === tolVista) P(`el corte de «igual» es el mismo en el dominio y en la vista C0 (${cenDom} · ${tolDom})`);
  else F(`el dominio dice ${cenDom}/${tolDom} y la vista C0 ${cenVista}/${tolVista}`);

  // Probar como el rol de prod.
  if (dest.u !== 'app_runtime') {
    try { await c.query('SET ROLE app_runtime'); dest = { ...dest, u: (await c.query('SELECT current_user u')).rows[0].u }; console.log('  ⓘ SET ROLE app_runtime (la conexión entró como otro usuario)'); }
    catch { /* se declara abajo */ }
  }
  const comoRuntime = dest.u === 'app_runtime';

  await c.query('BEGIN');
  const sp = async (nombre, fn) => {
    await c.query(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  // Un renglón que SUBE: OC a 21.60, aplicado a 23.00, 24 piezas → 33.60 de diferencia.
  const BASE = { sucursal: '03', subtipo: '1', folio: 'PQ157-T1', renglon: 1, supplier: 'PQ157-PRV', sku: 'PQ157-SKU', unit: 'PAQ',
    qty: 24, applied: 23, oc: 21.6, state: 'sube', decision: 'accept', reason: 'El proveedor subió su lista el 1-nov', claim: null, until: null };
  const decidir = (o) => {
    const r = { ...BASE, ...o };
    return c.query(`
      INSERT INTO ${T} (tenant_id, sucursal, subtipo, folio, renglon, supplier_code, sku, unit, quantity, applied_price, oc_price,
                        cost_state, decision, reason, claim_amount, valid_until, created_by, updated_by, superseded_by, superseded_at)
      VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'prueba', 'prueba', $16, $17)
      RETURNING id`, [r.sucursal, r.subtipo, r.folio, r.renglon, r.supplier, r.sku, r.unit, r.qty, r.applied, r.oc, r.state,
      r.decision, r.reason, r.claim, r.until, r.supBy ?? null, r.supAt ?? null]).then((x) => x.rows[0].id);
  };
  const rebota = async (nombre, codigo, fn, que) => sp(nombre, async () => {
    try { await fn(); F(`entró: ${que}`); }
    catch (e) { if (e.code === codigo) P(`negativa: ${que} → ${codigo}`); else F(`${que} falló por otra cosa: ${e.code} ${e.message}`); }
  });

  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    // 3. Los casos de la maqueta entran (cada uno en su renglón).
    const ids = [
      await decidir({ renglon: 1 }),
      await decidir({ renglon: 2, applied: 20, state: 'baja', reason: 'Bajó su precio de lista este mes' }),
      await decidir({ renglon: 3, decision: 'claim', claim: 33.6, reason: 'Facturó arriba de lo pactado en la OC' }),
      await decidir({ renglon: 4, decision: 'claim', claim: 10, reason: 'Reclamo parcial: acordamos la mitad' }),
      await decidir({ renglon: 5, decision: 'claim', claim: 33.61, reason: 'La diferencia más el centavo de redondeo' }),
      await decidir({ renglon: 6, applied: 20, state: 'baja', decision: 'promotion', until: '2026-12-31', reason: 'Promoción de fin de año' }),
    ];
    if (ids.every(Boolean)) P('entran: aceptar lo que sube y lo que baja · reclamar completo, en parte y con el centavo de holgura · promoción con fecha de fin');

    // 4. Negativas, una por regla.
    const R = (n) => ({ renglon: 100 + n });
    await rebota('n1', '23514', () => decidir({ ...R(1), sucursal: ' ' }), 'sucursal vacía');
    await rebota('n2', '23514', () => decidir({ ...R(2), renglon: 0 }), 'renglón 0');
    await rebota('n3', '23514', () => decidir({ ...R(3), folio: '' }), 'folio vacío');
    await rebota('n4', '23514', () => decidir({ ...R(4), supplier: '  ' }), 'proveedor vacío');
    await rebota('n5', '23514', () => decidir({ ...R(5), sku: '' }), 'producto vacío');
    await rebota('n6', '23514', () => decidir({ ...R(6), qty: 0 }), 'cantidad 0');
    await rebota('n7', '23514', () => decidir({ ...R(7), applied: 0, state: 'baja' }), 'precio aplicado 0');
    await rebota('n8', '23514', () => decidir({ ...R(8), oc: 0 }), 'precio de OC 0');
    await rebota('n9', '23514', () => decidir({ ...R(9), state: 'igual' }), 'se decide sobre un renglón «igual»');
    await rebota('n10', '23514', () => decidir({ ...R(10), state: 'sube', applied: 20 }), 'dice «sube» pero el precio aplicado está abajo de la OC');
    await rebota('n11', '23514', () => decidir({ ...R(11), state: 'baja' }), 'dice «baja» pero el precio aplicado está arriba de la OC');
    await rebota('n12', '23514', () => decidir({ ...R(12), decision: 'delete' }), 'decisión fuera de la lista');
    await rebota('n13', '23514', () => decidir({ ...R(13), reason: '  corto   ' }), 'motivo de menos de 10 letras');
    await rebota('n14', '23514', () => decidir({ ...R(14), decision: 'claim', claim: null }), 'reclamo sin monto');
    await rebota('n15', '23514', () => decidir({ ...R(15), decision: 'claim', claim: 5, applied: 20, state: 'baja' }), 'reclamo sobre un costo que bajó');
    // Con una baja de menos de un centavo el tope redondea a 0.00 + la holgura: sólo «cost_state = 'sube'» la frena.
    await rebota('n15b', '23514', () => decidir({ ...R(24), decision: 'claim', claim: 0.01, applied: 20, oc: 20.0001, qty: 1, state: 'baja' }),
      'reclamo de un centavo sobre una baja de menos de un centavo');
    await rebota('n16', '23514', () => decidir({ ...R(16), decision: 'claim', claim: 33.62 }), 'reclamo de más que la diferencia (33.62 contra 33.60)');
    await rebota('n17', '23514', () => decidir({ ...R(17), decision: 'claim', claim: 0 }), 'reclamo en cero');
    await rebota('n18', '23514', () => decidir({ ...R(18), claim: 5 }), 'monto de nota en una aceptación');
    await rebota('n19', '23514', () => decidir({ ...R(19), decision: 'promotion' }), 'promoción sin fecha de fin');
    await rebota('n20', '23514', () => decidir({ ...R(20), until: '2026-12-31' }), 'fecha de fin en una aceptación');
    await rebota('n21', '23514', () => decidir({ ...R(21), supAt: '2026-11-26T00:00:00Z' }), 'reemplazada sin quién');
    await rebota('n22', '23502', () => decidir({ ...R(22), reason: null }), 'sin motivo (NULL)');
    await rebota('n23', '23502', () => decidir({ ...R(23), state: null }), 'sin estado (NULL)');

    // 5. Una decisión viva por renglón; reemplazarla libera el renglón.
    await rebota('u1', '23505', () => decidir({ renglon: 1, reason: 'Otra vez el mismo renglón vivo' }), 'segunda decisión viva sobre el mismo renglón');
    await sp('u2', async () => {
      try {
        const upd = await c.query(`UPDATE ${T} SET superseded_by = 'prueba', superseded_at = now(), updated_by = 'prueba', updated_at = now()
                                    WHERE id = $1`, [ids[0]]);
        const nueva = await decidir({ renglon: 1, decision: 'claim', claim: 33.6, reason: 'Cambié de opinión: se reclama la diferencia' });
        const vivas = (await c.query(`SELECT count(*)::int n FROM ${T} WHERE folio = 'PQ157-T1' AND renglon = 1 AND superseded_at IS NULL`)).rows[0].n;
        const todas = (await c.query(`SELECT count(*)::int n FROM ${T} WHERE folio = 'PQ157-T1' AND renglon = 1`)).rows[0].n;
        if (upd.rowCount === 1 && nueva && vivas === 1 && todas === 2) P('reemplazar con UPDATE libera el renglón: 1 viva y la anterior como historia');
        else F(`reemplazo: actualizó ${upd.rowCount}, vivas ${vivas}, total ${todas}`);
      } catch (e) { F(`reemplazar no liberó el renglón: ${e.code} ${e.message}`); }
    });

    // 6. Como app_runtime: no borra; RLS por tenant.
    if (!comoRuntime) {
      NM(`la conexión es ${dest.u} y no pudo volverse app_runtime: DELETE y RLS sin medir con el rol de prod`);
    } else {
      const puedeBorrar = (await c.query(`SELECT has_table_privilege('app_runtime', $1, 'DELETE') AS p`, [T])).rows[0].p;
      if (!puedeBorrar) P('app_runtime no tiene DELETE sobre la tabla (REVOKE aplicado)');
      else F('app_runtime TIENE DELETE: «nada se borra» sería una intención');
      await rebota('d1', '42501', () => c.query(`DELETE FROM ${T} WHERE id = $1`, [ids[1]]), 'app_runtime borra una decisión');

      await sp('rls', async () => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
        const ve = (await c.query(`SELECT count(*)::int n FROM ${T} WHERE folio = 'PQ157-T1'`)).rows[0].n;
        if (ve === 0) P('con otro tenant no ve las decisiones (RLS)');
        else F(`con otro tenant ve ${ve} decisiones`);
        try {
          await c.query('SAVEPOINT rls_w');
          await c.query(`INSERT INTO ${T} (tenant_id, sucursal, subtipo, folio, renglon, supplier_code, sku, quantity, applied_price, oc_price,
                           cost_state, decision, reason, created_by)
                         VALUES ($1, '03', '1', 'PQ157-T9', 1, 'X', 'Y', 1, 2, 1, 'sube', 'accept', 'Escribe en el tenant ajeno', 'prueba')`, [TENANT]);
          F('con otro tenant escribió en el tenant ajeno (WITH CHECK)');
        } catch (e) {
          if (e.code === '42501') P('con otro tenant no escribe en el ajeno (WITH CHECK) → 42501');
          else F(`WITH CHECK falló por otra cosa: ${e.code} ${e.message}`);
        } finally { await c.query('ROLLBACK TO SAVEPOINT rls_w'); }
      });
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }

  console.log(`\n  ${ok} ✔ · ${fail} ✘ · ${nm} no medido\n`);
  process.exit(fail ? 1 : nm ? 2 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
