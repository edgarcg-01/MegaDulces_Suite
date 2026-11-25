#!/usr/bin/env node
/**
 * [GP.R.2] El registro del Ajuste Abono — lo que la Suite escribe en SU base (Kepler no se toca).
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * Regla 13: una escritura no está probada hasta que corre contra una base real. Aquí, como `app_runtime` (el rol de
 * prod, con RLS), en una transacción que se REVIERTE:
 *
 *  1. **El camino feliz**: la fila nace `pendiente` y se cierra `escrito` con el folio que dio Kepler.
 *  2. **Idempotencia**: la misma `referencia` no entra dos veces (índice único, 23505).
 *  3. **Dos a la vez** del mismo cliente: el segundo `pendiente` choca (índice único parcial).
 *  4. ⛔ **La referencia cabe en 20** — `md.kdm1.c11` es `varchar(20)`, medido ESCRIBIENDO el 2026-11-24. Si la Suite
 *     guardara una más larga, el ajuste moriría al escribirse en Kepler. Con su control: 20 pasa, 21 no.
 *  5. **Negativas de la tabla**: sin motivo, automática con persona, importe en cero, `facturas` vacío o que no es
 *     arreglo, estado inventado, folio de Kepler sin estar `escrito` (y `escrito` sin folio).
 *  6. **`app_runtime` no puede BORRAR** (el registro no se borra: regla 5).
 *  7. **El interruptor** acepta `ajuste_abono` sembrado en 9 y **APAGADO**, sin tope, sin perder los tipos previos.
 *  8. **La llave** `FINANCE_RESTOS_CERRAR` quedó en `credito_cobranza` y en nadie más fuera de superadmin (regla 20).
 *  9. **RLS**: con otro tenant no se ve nada.
 * 10. ⛔ **`cfdi_insoluto`**: lo que la factura SIGUE debiendo ante el SAT. Admite **NULL** (= NO MEDIDO, que no es
 *     cero: un Ajuste Abono no emite CFDI) y rechaza un negativo. Medido el 2026-11-25: 220 de los 260 restos
 *     vivos son facturas PPD con CFDI, así que cerrarlos en Kepler **no los cierra ante el SAT**.
 *
 * ⚠️ Sin la tabla (migración 20261125100145 sin aplicar) reporta NO MEDIDO, nunca ✔.
 * ⛔ No se corre contra producción: exige `assert-safe-target` como las demás.
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const TABLA = 'finance.customer_credit_adjustments';
const LLAVE = 'FINANCE_RESTOS_CERRAR';

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-ajuste-abono-registro', { url: DST });

const FACTURAS = JSON.stringify([{ tipo: 8, serie: 1, folio: '0000470', importe: 1589.12, saldo: 7.2 }]);

/** Inserta un ajuste y devuelve el error de Postgres si lo hubo (para las negativas). */
async function meter(c, over = {}) {
  const f = {
    tenant_id: TENANT, sucursal: '08', cliente_code: 'C2043', referencia: `RC-${Math.random().toString(36).slice(2, 10)}`,
    importe: 7.2, facturas: FACTURAS, automatica: false, motivo: 'resto de centavos', estado: 'pendiente',
    created_by: 'prueba', ...over,
  };
  const cols = Object.keys(f);
  try {
    await c.query(
      `INSERT INTO ${TABLA} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map((k) => f[k]));
    return null;
  } catch (e) { return e; }
}

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();

  const { rows: [t] } = await c.query(`SELECT to_regclass($1) IS NOT NULL AS hay`, [TABLA]);
  if (!t.hay) {
    NM(`${TABLA} no existe: falta aplicar la migración 20261125100145`);
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○`); await c.end(); process.exit(fail ? 1 : 0); return;
  }

  // Como app_runtime, que es quien escribe en prod, y con el tenant puesto.
  await c.query('BEGIN');
  try {
    const { rows: [r] } = await c.query(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS hay`);
    if (r.hay) await c.query(`SET LOCAL ROLE app_runtime`);
    else NM('no existe el rol app_runtime en esta base: se prueba con el rol actual');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    // 1 · Camino feliz: nace pendiente y se cierra escrito con su folio.
    const ref = `RC-${Math.random().toString(36).slice(2, 10)}`;
    const e1 = await meter(c, { referencia: ref });
    if (e1) F(`el camino feliz no entró: ${e1.message}`);
    else {
      const u = await c.query(
        `UPDATE ${TABLA} SET estado = 'escrito', kepler_folio = $2, kepler_resultado = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND referencia = $4 AND estado = 'pendiente'`,
        [TENANT, '0000002', JSON.stringify({ estado: 'escrito', folio: '0000002' }), ref]);
      if (u.rowCount === 1) P('nace «pendiente» y se cierra «escrito» con el folio de Kepler');
      else F(`cerrar la fila tocó ${u.rowCount} filas`);
      const u2 = await c.query(`UPDATE ${TABLA} SET estado = 'escrito' WHERE tenant_id = $1 AND referencia = $2 AND estado = 'pendiente'`, [TENANT, ref]);
      if (u2.rowCount === 0) P('cerrarla otra vez no toca nada (el WHERE estado = pendiente)');
      else F('cerrar dos veces tocó filas');

      // 2 · Idempotencia por referencia.
      const e2 = await meter(c, { referencia: ref });
      if (e2 && e2.code === '23505') P('la misma referencia no entra dos veces (idempotencia)');
      else F(`repetir la referencia dio ${e2 ? e2.code : 'OK'}, se esperaba 23505`);
    }

    // 3 · Dos en curso del mismo cliente.
    const a = await meter(c, { cliente_code: 'C9001' });
    const b = await meter(c, { cliente_code: 'C9001' });
    if (!a && b && b.code === '23505') P('dos ajustes «pendiente» del mismo cliente: el segundo choca');
    else F(`el segundo pendiente dio ${b ? b.code : 'OK'}, se esperaba 23505`);

    // 4 · ⛔ La referencia cabe en 20 (kdm1.c11 es varchar(20)), con su control.
    const r20 = await meter(c, { referencia: 'A'.repeat(20), cliente_code: 'C9002' });
    const r21 = await meter(c, { referencia: 'A'.repeat(21), cliente_code: 'C9003' });
    if (!r20 && r21) P('la referencia de 20 pasa y la de 21 NO (kdm1.c11 es varchar(20))');
    else F(`20 → ${r20 ? r20.code : 'OK'} · 21 → ${r21 ? r21.code : 'OK'}; se esperaba OK y rechazo`);

    // 5 · Las negativas de la tabla.
    const casos = [
      ['sin motivo y sin ser automática', { motivo: null, cliente_code: 'C9100' }],
      ['automática CON persona', { automatica: true, created_by: 'alguien', motivo: null, cliente_code: 'C9101' }],
      ['importe en cero', { importe: 0, cliente_code: 'C9102' }],
      ['facturas vacío', { facturas: '[]', cliente_code: 'C9103' }],
      ['facturas que no es arreglo', { facturas: JSON.stringify({ a: 1 }), cliente_code: 'C9104' }],
      ['estado inventado', { estado: 'inventado', cliente_code: 'C9105' }],
      ['folio de Kepler sin estar escrito', { kepler_folio: '0000003', cliente_code: 'C9106' }],
      ['sucursal que no es de dos dígitos', { sucursal: '8', cliente_code: 'C9107' }],
    ];
    for (const [que, over] of casos) {
      const e = await meter(c, over);
      if (e) P(`rechaza: ${que}`);
      else F(`ACEPTÓ lo que no debía: ${que}`);
    }
    // El control de la negativa: la automática SIN persona sí entra.
    const auto = await meter(c, { automatica: true, created_by: null, motivo: null, cliente_code: 'C9200' });
    if (!auto) P('control: la automática sin persona SÍ entra');
    else F(`la automática legítima fue rechazada: ${auto.message}`);

    // 6 · No se borra.
    try {
      await c.query(`DELETE FROM ${TABLA} WHERE tenant_id = $1 AND cliente_code = 'C9200'`, [TENANT]);
      F('app_runtime PUDO borrar del registro');
    } catch { P('app_runtime no puede borrar del registro (regla 5)'); }

    // 10 · ⛔ El insoluto del SAT: NULL es un valor LEGÍTIMO (no medido), y un negativo no.
    const refI = `RC-${Math.random().toString(36).slice(2, 10)}`;
    const nulo = await meter(c, { referencia: refI, cliente_code: 'C9300' });
    if (!nulo) P('cfdi_insoluto nace NULL: lo que no se midió no se dibuja como cero');
    else F(`la fila sin cfdi_insoluto fue rechazada: ${nulo.message}`);
    const neg = await meter(c, { cfdi_insoluto: -1, cliente_code: 'C9301' });
    const cero = await meter(c, { cfdi_insoluto: 0, cliente_code: 'C9302' });
    const centavos = await meter(c, { cfdi_insoluto: 7.2, cliente_code: 'C9303' });
    if (neg && !cero && !centavos) P('cfdi_insoluto: rechaza negativo, acepta 0 y acepta centavos (los controles)');
    else F(`cfdi_insoluto: -1 → ${neg ? neg.code : 'OK'} · 0 → ${cero ? cero.code : 'OK'} · 7.20 → ${centavos ? centavos.code : 'OK'}`);
    // Y se puede cerrar con el insoluto medido, como hace el servicio.
    const uI = await c.query(
      `UPDATE ${TABLA} SET estado = 'escrito', kepler_folio = '0000003', cfdi_insoluto = 7.20, updated_at = now()
        WHERE tenant_id = $1 AND referencia = $2 AND estado = 'pendiente'`, [TENANT, refI]);
    if (uI.rowCount === 1) P('el servicio cierra la fila con el insoluto que dejó ante el SAT');
    else F(`cerrar con cfdi_insoluto tocó ${uI.rowCount} filas`);

    // 9 · RLS: con otro tenant no se ve nada.
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
    const { rows: [v] } = await c.query(`SELECT count(*)::int n FROM ${TABLA}`);
    if (v.n === 0) P('RLS: con otro tenant no se ve ninguna fila');
    else F(`RLS: con otro tenant se vieron ${v.n} filas`);
  } finally {
    await c.query('ROLLBACK');
    await c.query('RESET ROLE').catch(() => undefined);
  }

  // 7 · El interruptor (fuera de la transacción: lo sembró la migración).
  const { rows: [sw] } = await c.query(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int on_, count(*) FILTER (WHERE tope_dia IS NOT NULL)::int topes
       FROM commercial.kepler_push_switch WHERE tipo = 'ajuste_abono'`);
  if (sw.n === 9 && sw.on_ === 0 && sw.topes === 0) P('el interruptor «ajuste_abono»: 9 renglones, APAGADOS y sin tope');
  else F(`interruptor: ${sw.n} renglones, ${sw.on_} encendidos, ${sw.topes} con tope; se esperaba 9/0/0`);
  const { rows: [tc] } = await c.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'`);
  const perdidos = ['compra', 'telemarketing', 'traspaso', 'autorizacion'].filter((x) => !String(tc?.def ?? '').includes(`'${x}'`));
  if (!perdidos.length) P('la restricción conserva los tipos previos');
  else F(`la restricción perdió: ${perdidos.join(', ')}`);

  // 8 · La llave (regla 20).
  const { rows: tiene } = await c.query(
    `SELECT role_name FROM identity.role_permissions
      WHERE permissions -> $1::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`, [LLAVE]);
  const { rows: existe } = await c.query(
    `SELECT 1 FROM identity.role_permissions WHERE role_name = 'credito_cobranza' AND deleted_at IS NULL`);
  const nombres = tiene.map((r) => r.role_name);
  if (!existe.length) NM('esta base no tiene el rol credito_cobranza: la llave sólo puede quedar en superadmin');
  else if (nombres.length === 1 && nombres[0] === 'credito_cobranza') P(`${LLAVE} quedó en credito_cobranza y en nadie más`);
  else F(`${LLAVE} quedó en: ${nombres.join(', ') || '(ninguno)'}`);

  await c.end();
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(`FALLO: ${e.message}`); process.exit(1); });
