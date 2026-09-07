'use strict';
/**
 * `[ID.8b]` — Separar el padrón en POBLACIONES y darle a cada una su propio eje
 * de control (Fase ID / ADR-050).
 *
 * ── La corrección que motivó este script ────────────────────────────────────
 * El primer intento fue "asignarle una sucursal a los 83 que no tienen", y para
 * los corporativos puso base `00` (Cedis Oficinas). **Estaba mal de raíz**, y
 * Edgar lo señaló: *"una cosa son las rutas, otra cosa es administrativo o
 * tienda; es por eso que te pedí separar esto, para llevar un control"*.
 *
 * Meter a los 43 corporativos en la sucursal `00` los vuelve indistinguibles del
 * personal real de CEDIS — o sea, destruye exactamente el control que se quería.
 * Y a la gente de ruta no se le puede dar una sucursal porque **no trabajan en
 * una**: trabajan en un camión.
 *
 * ── El modelo correcto: cada población se controla por SU eje ────────────────
 *
 *   POBLACIÓN        DEPARTAMENTOS                        EJE DE CONTROL
 *   ───────────────  ───────────────────────────────────  ──────────────────────
 *   Tienda           tienda · cajas                       SUCURSAL (warehouse)
 *   Rutas            ruta_directa · ruta_vecinal          RUTA / camión (route)
 *   Administrativo   administracion · operaciones ·       RED COMPLETA
 *                    almacen · logistica · sistemas       (warehouse = all)
 *   Televenta        telemarketing                        cartera de clientes
 *   Externo          externo (portal B2B)                 su propio cliente
 *
 * Por eso este script NO inventa sucursales: **completa `department_code`**, que
 * es el eje que faltaba y el que permite el control. Los 26 de tienda/cajas ya
 * tienen su sucursal (26/26); los de ruta se controlan por ruta cuando se defina
 * la topología de camiones; los administrativos se controlan por red.
 *
 * El departamento se deduce del ROL, que es autodescriptivo en este padrón
 * (`auxiliar_finanzas`, `encargado_sucursal`, `almacenista`, `repartidor`…). No
 * de la zona: la zona **contradice la realidad** — verificado contra
 * `analytics.sales_by_vendor_monthly`, `jose_herrera` tiene zona MORELIA ABASTOS
 * y vende desde MD-32 (Madero), y `humberto_placencia` al revés.
 *
 * Uso:
 *   node database/scripts/normalize-user-population.js            # dry-run
 *   node database/scripts/normalize-user-population.js --apply
 *   DATABASE_URL_NEW=<prod> node ... --apply
 *
 * Idempotente: nunca pisa un `department_code` ya puesto.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
const APPLY = process.argv.includes('--apply');

/**
 * rol → departamento. Basado en los 33 roles reales del padrón; el nombre del
 * rol dice el área en todos los casos menos los que quedan en `null`.
 */
const ROL_A_DEPT = {
  // ── Tienda / piso de venta ──
  encargado_sucursal: 'tienda',
  auxiliar_sucursal: 'tienda',
  etiquetas_tienda: 'tienda',
  cajera: 'cajas',
  // ── Rutas ──
  vendedor: 'ruta_directa',
  colaborador: 'ruta_directa',
  supervisor_ventas: 'ruta_directa',
  // ── Televenta ──
  telemarketing: 'telemarketing',
  tele_operator: 'telemarketing',
  // ── Almacén y logística ──
  almacenista: 'almacen',
  repartidor: 'logistica',
  // ── Operaciones (compras + prevención) ──
  compras: 'operaciones',
  auxiliar_compras: 'operaciones',
  gerente_compras: 'operaciones',
  encargada_operaciones_compras: 'operaciones',
  encargada_prevencion: 'operaciones',
  auxiliar_prevencion: 'operaciones',
  // ── Administración (finanzas, contabilidad, cobranza, marketing) ──
  finanzas: 'administracion',
  gerente_finanzas: 'administracion',
  auxiliar_finanzas: 'administracion',
  coordinadora_contabilidad: 'administracion',
  coordinador_presupuestos: 'administracion',
  credito_cobranza: 'administracion',
  analista_credito_cobranza: 'administracion',
  control_depositos_pagos: 'administracion',
  gestor_egresos: 'administracion',
  gestor_tesoreria: 'administracion',
  captura_gastos: 'administracion',
  jefe_marketing: 'administracion',
  coordinadora_marketing: 'administracion',
  auxiliar_mercadotecnia: 'administracion',
  // ── Sistemas / plataforma ──
  superadmin: 'sistemas',
  admin: 'sistemas',
  // ── Externo ──
  customer_b2b: 'externo',
  // ── Sin deducción posible: el nombre del rol no dice el área ──
  supervisor: null, // ¿supervisor de qué? Edgar decide
};

/** Población y eje de control de cada departamento. */
const POBLACION = {
  tienda: ['Tienda', 'sucursal'],
  cajas: ['Tienda', 'sucursal'],
  ruta_directa: ['Rutas', 'ruta / camión'],
  ruta_vecinal: ['Rutas', 'ruta / camión'],
  telemarketing: ['Televenta', 'cartera de clientes'],
  almacen: ['Administrativo', 'red completa'],
  logistica: ['Administrativo', 'red completa'],
  operaciones: ['Administrativo', 'red completa'],
  administracion: ['Administrativo', 'red completa'],
  sistemas: ['Administrativo', 'red completa'],
  direccion_zona: ['Administrativo', 'red completa'],
  mayoreo: ['Tienda', 'sucursal'],
  externo: ['Externo', 'su propio cliente'],
};

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

(async () => {
  try {
    const validos = new Set(
      (await knex('identity.departments').whereNull('deleted_at').select('code')).map((r) => r.code),
    );
    const users = (await knex.raw(`
      SELECT u.id, u.username, lower(u.role_name) rol, u.department_code, u.warehouse_code
        FROM identity.users u WHERE u.deleted_at IS NULL ORDER BY u.username`)).rows;

    const asignar = [];
    const sinRegla = [];
    for (const u of users) {
      if (u.department_code) continue;
      const dep = ROL_A_DEPT[u.rol];
      if (dep && validos.has(dep)) asignar.push({ ...u, dep });
      else sinRegla.push(u);
    }

    console.log(`Padrón: ${users.length} · ya con departamento: ${users.filter((u) => u.department_code).length} · sin departamento: ${users.length - users.filter((u) => u.department_code).length}\n`);

    console.log(`── A ASIGNAR por rol (${asignar.length}) ──`);
    const porDep = {};
    asignar.forEach((u) => (porDep[u.dep] = porDep[u.dep] || []).push(u));
    for (const [dep, list] of Object.entries(porDep).sort()) {
      const [pob, eje] = POBLACION[dep] || ['?', '?'];
      console.log(`\n  ${dep}  →  población ${pob} · control por ${eje}`);
      list.forEach((u) => console.log(`     ${u.username.padEnd(20)} rol=${u.rol.padEnd(30)} suc=${u.warehouse_code || '-'}`));
    }

    if (sinRegla.length) {
      console.log(`\n── SIN REGLA: el nombre del rol no dice el área (${sinRegla.length}) ──`);
      sinRegla.forEach((u) => console.log(`  ${u.username.padEnd(20)} rol=${u.rol}`));
    }

    if (APPLY && asignar.length) {
      await knex.transaction(async (trx) => {
        for (const u of asignar) {
          await trx.raw(
            `UPDATE identity.users SET department_code = ?, updated_at = now()
              WHERE id = ? AND department_code IS NULL`,
            [u.dep, u.id],
          );
        }
      });
      console.log(`\nAPLICADO: ${asignar.length} departamentos asignados.`);
    } else if (!APPLY) {
      console.log('\n(dry-run: no se escribió nada. Volvé a correr con --apply)');
    }

    // ── Cuadro de control final: cada población y si su eje está cubierto ────
    console.log('\n══════ CONTROL POR POBLACIÓN ══════');
    const fin = (await knex.raw(`
      SELECT COALESCE(u.department_code, '(sin dept)') dep, count(*) tot,
             count(*) FILTER (WHERE u.warehouse_code IS NOT NULL) con_suc
        FROM identity.users u WHERE u.deleted_at IS NULL
       GROUP BY 1`)).rows;
    const agg = {};
    for (const r of fin) {
      const [pob, eje] = POBLACION[r.dep] || ['(sin clasificar)', '—'];
      const a = (agg[pob] = agg[pob] || { tot: 0, con_suc: 0, eje, deps: [] });
      a.tot += Number(r.tot); a.con_suc += Number(r.con_suc); a.deps.push(`${r.dep}(${r.tot})`);
    }
    for (const [pob, a] of Object.entries(agg)) {
      const cobertura =
        a.eje === 'sucursal'
          ? `${a.con_suc}/${a.tot} con sucursal${a.con_suc === a.tot ? ' ✓' : ' ← faltan'}`
          : a.eje === 'red completa'
            ? 'no llevan sucursal (ven la red)'
            : a.eje === 'ruta / camión'
              ? 'pendiente: falta la topología de camiones (warehouses.source_warehouse_id)'
              : '—';
      console.log(`  ${pob.padEnd(16)} ${String(a.tot).padStart(3)} usuarios · control por ${a.eje.padEnd(22)} · ${cobertura}`);
      console.log(`  ${''.padEnd(16)}     ${a.deps.sort().join(' ')}`);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
