'use strict';
/**
 * `[ID.8b]` — Normalización de usuarios POR SUCURSAL: propuesta basada en datos,
 * no en el organigrama (Fase ID / ADR-050).
 *
 * El problema: 83 de 117 usuarios no tienen `warehouse_code`. Con el default de
 * alcance en `own` desde `[ID.3]`, "sin sucursal" ya no es un hueco cosmético.
 *
 * POR QUÉ NO SE DERIVA DE LA ZONA. Era la vía obvia y **está mal**: la zona
 * contradice la realidad operativa. Verificado contra `analytics.sales_by_vendor_monthly`:
 *
 *   `jose_herrera`       zona = MORELIA ABASTOS  → vende desde MD-32 (Madero)
 *   `joseph_guerrero`    zona = MORELIA ABASTOS  → vende desde MD-32 (Madero)
 *   `humberto_placencia` zona = MORELIA MADERO   → vende desde MD-30 (Abastos)
 *
 * Están cruzados. Y `LA PIEDAD RD` abarca tres sucursales (01/02/03) a la vez,
 * así que la zona no alcanza ni cuando no se contradice.
 *
 * Entonces la fuente es **dónde vende cada uno**: `sales_by_vendor_monthly`
 * (canales `ruta_venta` / `preventa_vecinal`), cruzando por nombre. Eso es
 * evidencia, no criterio.
 *
 * Y hay una distinción que el modelo viejo no podía expresar y ésta sí
 * (ADR-050): **`warehouse_code` es DÓNDE ESTÁS BASADO, `user_scopes` es QUÉ VES**.
 * Por eso a un usuario corporativo se le puede poner base `00` sin restringirlo:
 * su fila de `user_scopes` dice `all` y el override de usuario gana sobre el
 * default del rol. Antes, con un solo campo, poner sucursal = perder la red.
 *
 * Uso:
 *   node database/scripts/propose-user-warehouse.js                 # propuesta (dry-run)
 *   node database/scripts/propose-user-warehouse.js --apply         # escribe lo SEGURO
 *   DATABASE_URL_NEW=<prod> node ... --apply
 *
 * `--apply` escribe SÓLO los grupos marcados como seguros; lo ambiguo se lista
 * y no se toca. Idempotente: nunca pisa un `warehouse_code` ya puesto.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

/** Roles corporativos: su base es CEDIS/Oficinas y su alcance es la red. */
const ROLES_CORPORATIVOS = new Set([
  'superadmin', 'admin', 'finanzas', 'gerente_finanzas', 'auxiliar_finanzas',
  'coordinadora_contabilidad', 'coordinador_presupuestos', 'credito_cobranza',
  'analista_credito_cobranza', 'control_depositos_pagos', 'gestor_egresos',
  'gestor_tesoreria', 'compras', 'auxiliar_compras', 'gerente_compras',
  'encargada_operaciones_compras', 'encargada_prevencion', 'auxiliar_prevencion',
  'almacenista', 'etiquetas_tienda', 'jefe_marketing', 'coordinadora_marketing',
  'auxiliar_mercadotecnia', 'supervisor', 'telemarketing', 'captura_gastos',
]);

/** Portal B2B: NO son empleados, no tienen sucursal base. */
const ROLES_EXTERNOS = new Set(['customer_b2b']);

const CEDIS = '00';

const norm = (s) => (s || '')
  .toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 3);
const unicos = (a) => a.filter((x, i, arr) => arr.indexOf(x) === i);

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

(async () => {
  try {
    const sucursales = (await knex.raw(
      `SELECT code FROM commercial.warehouses WHERE deleted_at IS NULL AND code ~ '^[0-9]{2}$' ORDER BY code`,
    )).rows.map((r) => r.code);

    const users = (await knex.raw(`
      SELECT u.id, u.username, COALESCE(u.nombre, u.username) nombre, lower(u.role_name) rol,
             COALESCE(z.name, '') zona, u.warehouse_code,
             (SELECT us.mode FROM identity.user_scopes us
               WHERE us.user_id = u.id AND us.dimension = 'warehouse') scope_mode
        FROM identity.users u
        LEFT JOIN trade.zones z ON z.id = u.zona_id
       WHERE u.deleted_at IS NULL
       ORDER BY u.username`)).rows;

    // Evidencia: dónde vende cada vendedor, por facturación (el almacén con más
    // venta gana si aparece en varios).
    const ventas = (await knex.raw(`
      SELECT w.code AS wh, v.vendor_name, sum(v.revenue) rev
        FROM analytics.sales_by_vendor_monthly v
        JOIN commercial.warehouses w ON w.id = v.warehouse_id
       WHERE v.sale_channel IN ('ruta_venta', 'preventa_vecinal')
         AND v.vendor_name IS NOT NULL AND v.revenue > 0
       GROUP BY 1, 2 HAVING sum(v.revenue) > 5000`)).rows;

    const evidencia = (nombre) => {
      const t = tokens(nombre);
      if (t.length < 1) return null;
      const hits = ventas
        .map((v) => ({ ...v, score: t.filter((x) => norm(v.vendor_name).includes(x)).length }))
        .filter((v) => v.score >= Math.min(2, t.length))
        .sort((a, b) => b.score - a.score || Number(b.rev) - Number(a.rev));
      return hits.length ? hits[0] : null;
    };

    const yaTiene = users.filter((u) => u.warehouse_code);
    const pend = users.filter((u) => !u.warehouse_code);

    const grupos = { corporativo: [], externo: [], evidencia_sucursal: [], evidencia_camion: [], sin_evidencia: [] };

    for (const u of pend) {
      if (ROLES_EXTERNOS.has(u.rol)) { grupos.externo.push({ u }); continue; }
      const ev = evidencia(u.nombre);
      if (ev && sucursales.includes(ev.wh)) { grupos.evidencia_sucursal.push({ u, ev }); continue; }
      if (ev) { grupos.evidencia_camion.push({ u, ev }); continue; }
      if (ROLES_CORPORATIVOS.has(u.rol)) { grupos.corporativo.push({ u }); continue; }
      grupos.sin_evidencia.push({ u });
    }

    console.log(`Padrón: ${users.length} · con sucursal: ${yaTiene.length} · sin sucursal: ${pend.length}`);
    console.log(`Sucursales reales (2 díg): ${sucursales.join(', ')}\n`);

    console.log(`── SEGURO 1: evidencia directa de venta en una SUCURSAL (${grupos.evidencia_sucursal.length}) ──`);
    grupos.evidencia_sucursal.forEach(({ u, ev }) =>
      console.log(`  ${u.username.padEnd(20)} → ${ev.wh}   (vende como "${ev.vendor_name}")`));

    console.log(`\n── SEGURO 2: corporativo → base ${CEDIS} Cedis Oficinas (${grupos.corporativo.length}) ──`);
    console.log('   No los restringe: su user_scopes dice `all` y el override de usuario gana.');
    grupos.corporativo.forEach(({ u }) =>
      console.log(`  ${u.username.padEnd(20)} rol=${u.rol.padEnd(28)} scope=${u.scope_mode || '(sin regla)'}`));

    console.log(`\n── SEGURO 3: portal B2B, NO llevan sucursal (${grupos.externo.length}) ──`);
    grupos.externo.forEach(({ u }) => console.log(`  ${u.username.padEnd(20)} rol=${u.rol}`));

    console.log(`\n── DECISIÓN DE EDGAR: venden desde un CAMIÓN, no desde una sucursal (${grupos.evidencia_camion.length}) ──`);
    console.log('   `warehouse_code` sólo admite códigos de 2 dígitos, y el universo de la');
    console.log('   dimensión de alcance también. Hay que elegir: (a) asignarles la sucursal');
    console.log('   MADRE del camión — pero `warehouses.source_warehouse_id` está SIN DEFINIR');
    console.log('   en los 13 camiones — o (b) ampliar la dimensión para incluir camiones.');
    grupos.evidencia_camion.forEach(({ u, ev }) =>
      console.log(`  ${u.username.padEnd(20)} zona=${u.zona.padEnd(18)} → vende desde ${ev.wh}  ("${ev.vendor_name}")`));

    console.log(`\n── DECISIÓN DE EDGAR: sin evidencia de venta ni rol corporativo (${grupos.sin_evidencia.length}) ──`);
    grupos.sin_evidencia.forEach(({ u }) =>
      console.log(`  ${u.username.padEnd(20)} rol=${u.rol.padEnd(24)} zona=${u.zona || '(sin zona)'}`));

    // ── contradicciones zona vs realidad ─────────────────────────────────────
    const cruzados = grupos.evidencia_camion.concat(grupos.evidencia_sucursal).filter(({ u, ev }) => {
      const z = norm(u.zona);
      if (!z) return false;
      if (ev.wh === 'MD-30' && z.includes('MADERO')) return true;
      if (ev.wh === 'MD-32' && z.includes('ABASTOS')) return true;
      return false;
    });
    if (cruzados.length) {
      console.log(`\n⚠ ZONA CONTRADICE LA REALIDAD (${cruzados.length}) — por esto la sucursal NO se deriva de la zona:`);
      cruzados.forEach(({ u, ev }) => console.log(`  ${u.username.padEnd(20)} zona dice ${u.zona} · vende desde ${ev.wh}`));
    }

    const aEscribir = grupos.evidencia_sucursal
      .map(({ u, ev }) => ({ id: u.id, username: u.username, code: ev.wh, motivo: `venta real en ${ev.wh}` }))
      .concat(grupos.corporativo.map(({ u }) => ({ id: u.id, username: u.username, code: CEDIS, motivo: 'rol corporativo' })));

    console.log(`\n${APPLY ? 'APLICANDO' : 'DRY-RUN'}: ${aEscribir.length} asignaciones seguras · ${grupos.evidencia_camion.length + grupos.sin_evidencia.length} pendientes de decisión · ${grupos.externo.length} sin sucursal a propósito`);

    if (APPLY && aEscribir.length) {
      await knex.transaction(async (trx) => {
        for (const a of aEscribir) {
          // Idempotente y no destructivo: sólo si sigue vacío.
          await trx.raw(
            `UPDATE identity.users SET warehouse_code = ?, updated_at = now()
              WHERE id = ? AND warehouse_code IS NULL`,
            [a.code, a.id],
          );
        }
      });
      const ahora = await knex.raw(
        `SELECT count(*) FILTER (WHERE warehouse_code IS NOT NULL) con, count(*) tot
           FROM identity.users WHERE deleted_at IS NULL`);
      console.log(`  → con sucursal: ${ahora.rows[0].con}/${ahora.rows[0].tot}`);
      console.log('  Nota: NO se tocó `user_scopes`. Quien tenía `all` explícito lo conserva —');
      console.log('  la base es dónde estás, el alcance es qué ves (ADR-050).');
    } else if (!APPLY) {
      console.log('  (dry-run: no se escribió nada. Volvé a correr con --apply)');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
