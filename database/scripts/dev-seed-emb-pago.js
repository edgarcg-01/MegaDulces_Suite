'use strict';
/**
 * `[EMB.24]`–`[EMB.29]` — Datos de PRUEBA para ver «Pago por viaje cerrado» en local (ADR-091).
 *
 * Usa la API real, como lo haría Logística: toma guías reales de Kepler de la copia local,
 * completa cada guía (chofer, ayudante, horario), registra cargadores y cierra paradas de cliente
 * (sin foto: es opcional desde 2026-10-12). Así la demo ejercita el mismo código que producción.
 *
 * Deja estas situaciones (corte del 24-sep al 7-oct; el faltante cae en el anterior y el viaje abierto en el actual):
 *  · TRASPASOS recibidos     → viaje cerrado: comisión y viáticos liberados.
 *  · CLIENTES entregados      → viaje cerrado (las 5 paradas registradas).
 *  · CLIENTES a medias        → viaje abierto: falta registrar una entrega, el pago queda retenido.
 *  · TRASPASO con FALTANTE    → cerrado con diferencia (corte anterior): se paga, la parada queda marcada.
 *
 * ⚠️ Sólo contra una base LOCAL (`assertSafeTarget`). Las tarifas de rutas que hoy están en $0
 *    también en producción (EMB.17) se ponen aquí con valores de DEMO, marcados en `notes`.
 *
 * Uso:  node database/scripts/dev-seed-emb-pago.js --api http://127.0.0.1:3341 [--user superoot --password superoot]
 */
require('dotenv').config();
const { assertSafeTarget } = require('../tests/_lib/assert-safe-target');
const { Client } = require('pg');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('--api', 'http://127.0.0.1:3341').replace(/\/+$/, '') + '/api';
const USER = arg('--user', 'superoot');
const PASS = arg('--password', 'superoot');
const URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');

/** Las guías de la demo: reales en la copia local de Kepler. */
const GUIAS = [
  { suc: '01', guia: '0001586', que: 'traspasos recibidos', salida: '07:30', llegada: '13:10', ayudante: true, cargadores: 2 },
  { suc: '01', guia: '0001597', que: 'clientes, todos entregados', salida: '05:40', llegada: '16:20', ayudante: true, cargadores: 3, cerrar: 'todas' },
  { suc: '01', guia: '0001571', que: 'clientes y traspaso', salida: '06:20', llegada: '15:30', ayudante: false, cargadores: 2, cerrar: 'todas_entregadas' },
  { suc: '01', guia: '0001683', que: 'clientes, falta registrar una (corte en curso)', salida: '06:50', llegada: '14:10', ayudante: true, cargadores: 2, cerrar: 'menos_una' },
  { suc: '01', guia: '0001338', que: 'traspaso con faltante', salida: '08:00', llegada: '12:40', ayudante: true, cargadores: 0 },
];

/** Tarifas de DEMO para rutas que tampoco tienen en producción (EMB.17). */
const TARIFAS_DEMO = [
  { name: 'LA PIEDAD', driver: 61.92, helper: 36.48 },
  { name: 'TANUHATO', driver: 77.4, helper: 51.68 },
];

async function http(method, path, token, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch { json = txt; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${typeof json === 'string' ? json : json.message || txt}`);
  return json;
}

(async () => {
  assertSafeTarget('dev-seed-emb-pago', { url: URL });
  const db = new Client({ connectionString: URL });
  await db.connect();
  const T = '00000000-0000-0000-0000-00000000d01c';

  // 1. Tarifas: viáticos y carga (las de la beta, comida a $100 por decisión del 2026-10-12).
  const conf = [
    ['viatico_cafe', 'viatico', 50, 'Café (sale antes de las 6:00)'],
    ['viatico_desayuno', 'viatico', 100, 'Desayuno (sale antes de las 7:00)'],
    ['viatico_comida', 'viatico', 100, 'Comida (llega después de las 15:00)'],
    ['viatico_cena', 'viatico', 100, 'Cena (duerme fuera o llega después de las 20:00)'],
    ['tarifa_maniobra_carga', 'tarifa_maniobra', 30, 'Carga por persona'],
  ];
  for (const [key, category, value, description] of conf) {
    await db.query(
      `INSERT INTO logistics.config_finance (tenant_id, key, category, value, unit, description, active)
       VALUES ($1,$2,$3,$4,'mxn',$5,true)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, active = true, category = EXCLUDED.category`,
      [T, key, category, value, description]);
  }
  for (const t of TARIFAS_DEMO) {
    await db.query(
      `UPDATE logistics.routes SET driver_commission=$2, helper_commission=$3,
              notes = COALESCE(notes,'') || ' [DEMO LOCAL EMB.29: en prod sigue en 0]'
        WHERE tenant_id=$1 AND upper(name)=$4 AND deleted_at IS NULL
          AND COALESCE(driver_commission,0)=0 AND COALESCE(helper_commission,0)=0`,
      [T, t.driver, t.helper, t.name]);
  }

  // Cargadores de PRUEBA (el padrón local trae muy pocos). Nombres inventados a propósito.
  for (const n of ['CARGADOR PRUEBA UNO', 'CARGADOR PRUEBA DOS', 'CARGADOR PRUEBA TRES']) {
    await db.query(
      `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active, notes)
       SELECT $1, $2::varchar, ARRAY['cargador'], 'interno', 'activo', true, 'DEMO LOCAL EMB.29'
        WHERE NOT EXISTS (SELECT 1 FROM logistics.drivers WHERE tenant_id=$1 AND full_name=$2::varchar AND deleted_at IS NULL)`,
      [T, n]);
  }

  // Personas del padrón local para la tripulación y los cargadores.
  const { rows: personas } = await db.query(
    `SELECT id, roles FROM logistics.drivers
      WHERE tenant_id=$1 AND deleted_at IS NULL AND active AND status='activo' ORDER BY full_name`, [T]);
  const choferes = personas.filter((p) => p.roles.includes('chofer'));
  const ayudantes = personas.filter((p) => p.roles.includes('ayudante'));
  const cargadores = personas.filter((p) => p.roles.includes('cargador'));
  if (!choferes.length || !ayudantes.length || cargadores.length < 3) {
    throw new Error('El padrón local no tiene choferes, ayudantes o cargadores activos suficientes.');
  }

  // Quien APRUEBA en la demo: otra persona, con el rol que en el tenant firma gastos (tesorería).
  // El vale lo prepara superoot y el sistema le impide aprobarlo («nadie aprueba lo propio»).
  const bcrypt = require('bcryptjs');
  await db.query(
    `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo, status, must_change_password, kind)
     VALUES ($1,'aprobador_prueba',$2,'Prueba · Aprueba gastos','tesoreria',true,'active',false,'interno')
     ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_name='tesoreria',
       activo=true, status='active', must_change_password=false, deleted_at=NULL`,
    [T, await bcrypt.hash('aprobador_prueba', 10)]);

  // 2. Sesión.
  const login = await http('POST', '/auth-mt/login', null, { username: USER, password: PASS, tenant_slug: 'mega_dulces' });
  const token = login.access_token || login.token || login.accessToken;
  if (!token) throw new Error('El login no devolvió token.');

  let k = 0;
  for (const g of GUIAS) {
    // 3. Tomar la guía de Kepler (si ya se tomó, reusar).
    let shipmentId;
    const ya = await db.query(
      `SELECT id FROM logistics.shipments WHERE tenant_id=$1 AND kepler_sucursal=$2 AND kepler_guia=$3
          AND deleted_at IS NULL AND status <> 'cancelado'`, [T, g.suc, g.guia]);
    if (ya.rows[0]) shipmentId = ya.rows[0].id;
    else {
      const r = await http('POST', `/logistics/shipments/from-kepler/${g.suc}/${g.guia}`, token, { delivery_type: 'route' });
      shipmentId = r.shipment.id;
    }
    const { rows: [guia] } = await db.query(
      `SELECT id, driver_id, departure_time FROM logistics.delivery_guides WHERE shipment_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [shipmentId]);

    // 4. Completar la guía: chofer (si Kepler no lo trae), ayudante y horario.
    if (!guia.departure_time) {
      const chofer = guia.driver_id ?? choferes[k % choferes.length].id;
      const ayudante = g.ayudante ? (ayudantes.find((a) => a.id !== chofer)?.id ?? null) : null;
      await http('POST', `/logistics/guides/${guia.id}/complete`, token, {
        ...(guia.driver_id ? {} : { driver_id: chofer }),
        helper1_id: ayudante, helper2_id: null,
        departure_time: g.salida, arrival_time: g.llegada, overnight: false,
      });
    }

    // 5. Cargadores.
    if (g.cargadores) {
      const ids = cargadores.slice(0, g.cargadores).map((a) => a.id);
      await http('PUT', `/logistics/trip-closure/shipments/${shipmentId}/cargadores`, token, { driver_ids: ids });
    }

    // 6. Cerrar paradas de cliente.
    if (g.cerrar) {
      const cierre = await http('GET', `/logistics/trip-closure/shipments/${shipmentId}`, token);
      const abiertas = cierre.paradas.filter((p) => p.recipient_status === 'pendiente' && p.tipo_parada === 'cliente');
      const aCerrar = g.cerrar === 'menos_una' ? abiertas.slice(0, Math.max(0, abiertas.length - 1)) : abiertas;
      for (const [i, p] of aCerrar.entries()) {
        const noEntrega = g.cerrar === 'todas' && i === aCerrar.length - 1; // una «no entregada» con evidencia
        await http('POST', `/logistics/trip-closure/paradas/${p.recipient_id}/cierre`, token, noEntrega
          ? { resultado: 'no_entregado', motivo: 'not_located', nota: 'Negocio cerrado (prueba)' }
          : { resultado: 'entregado', recibio: 'PERSONA DE PRUEBA' });
      }
    }

    const fin = await http('GET', `/logistics/trip-closure/shipments/${shipmentId}`, token);
    const v = fin.viajes[0];
    console.log(`✓ ${g.suc}-${g.guia} (${g.que}): ${v.estado_viaje} · ${v.paradas_cerradas + v.paradas_con_diferencia}/${v.paradas} paradas · ${fin.pagos.length} renglones de pago`);
    k += 2;
  }
  await db.end();
  console.log('\nListo. Abre Logística › Embarques (pestaña «Cierre y pago») y Finanzas › Gastos › «Comisiones de logística».');
  console.log('Para aprobar un vale entra con aprobador_prueba / aprobador_prueba: quien lo armó no puede aprobarlo.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
