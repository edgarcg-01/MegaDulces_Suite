#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.68]` — **¿Facturas provisionadas que se pagaron como compra directa y cuya provisión nunca se canceló?**
 * Provisión = póliza de diario con abono a 2120 del proveedor por el total de la factura (no trae UUID: se casa
 * por cuenta + importe, en el mes de la factura o después y antes del pago). Pago como compra directa = póliza
 * de egreso con cargo 501/502 y el UUID. Cancelada = algún cargo a esa cuenta 2120 por ese importe después.
 *
 * Medido 2026-10-21 (pagos desde feb-2025): 5,394 facturas pagadas como compra directa, 61 estaban provisionadas,
 * 7 se cancelaron, **54 no ($8,204,062.77)** — 33 en abril de 2026, 9 en junio de 2025. Las cuentas 2120 de esos
 * proveedores no tienen ningún cargo en diario en 2026 (no hubo reversa global). Si se confirma, la compra quedó
 * registrada dos veces y el 2120 abierto. ⛔ Es un hallazgo PARA CONTABILIDAD: lo verifica ella, no se corrige
 * desde aquí (ADR-040).
 *
 *   node database/scripts/doble-registro-provision-contpaqi.js
 *
 * Sólo lectura.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require('pg');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query('SET default_transaction_read_only = on');
  const sid = (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  const base = `FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
       AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio WHERE p.source='contpaqi'`;
  // Pagos como compra directa, por factura (UUID), con el sufijo del proveedor.
  const pagos = (await c.query(`SELECT upper(l.cfdi_uuid) u, min(p.fecha)::date::text f, min(substr(l.cuenta,5)) suf, p.ejercicio, p.periodo, p.folio
      ${base} AND p.tipo_pol='2' AND l.cargo_abono='C' AND l.cuenta ~ '^50[12]0' AND l.cfdi_uuid IS NOT NULL GROUP BY 1,4,5,6`)).rows;
  const tot = new Map((await c.query(`SELECT upper(uuid) u, total::float8 t, fecha::date::text f FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante='I'`, [MEGA])).rows.map((r) => [r.u, r]));
  // Movimientos 2120 por cuenta+importe: abonos de provisión (diario) y cualquier cargo.
  const mov = (await c.query(`SELECT l.cuenta, round(l.importe::numeric,2)::float8 imp, l.cargo_abono ca, p.tipo_pol, p.fecha::date::text f, p.ejercicio, p.periodo, p.folio
      ${base} AND l.cuenta LIKE '2120%'`)).rows;
  await c.end();
  const idx = new Map(); for (const x of mov) { const k = `${x.cuenta}|${x.imp.toFixed(2)}`; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(x); }
  const r = { pagos_directa: 0, con_provision_previa: 0, provision_cancelada: 0, sin_cancelar: 0 }; let monto = 0; const porMes = {}; const ej = [];
  for (const p of pagos) {
    const x = tot.get(p.u); if (!x) continue;
    if (p.f < '2025-02-01') continue;   // la provisión de 2024 no está en gl
    r.pagos_directa += 1;
    const ms = idx.get(`2120${p.suf}|${(Math.round(x.t * 100) / 100).toFixed(2)}`) || [];
    const prov = ms.find((z) => z.ca === 'A' && z.tipo_pol === '3' && z.f <= p.f && z.f >= x.f.slice(0, 7) + '-01');
    if (!prov) continue;
    r.con_provision_previa += 1;
    if (ms.some((z) => z.ca === 'C' && z.f >= prov.f)) { r.provision_cancelada += 1; continue; }
    r.sin_cancelar += 1; monto += x.t; const k = p.f.slice(0, 7); porMes[k] = (porMes[k] || 0) + 1;
    if (ej.length < 6) ej.push(`factura ${x.f} ${x.t.toFixed(2)} · provisión diario ${prov.ejercicio}-${prov.periodo}-${prov.folio} (${prov.f}) · pago egreso ${p.ejercicio}-${p.periodo}-${p.folio} (${p.f}) como 501/502`);
  }
  console.log(`system_identifier ${sid}`); console.table(r); console.log('monto sin cancelar', monto.toFixed(2)); console.table(porMes); console.log(ej.join('\n'));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
