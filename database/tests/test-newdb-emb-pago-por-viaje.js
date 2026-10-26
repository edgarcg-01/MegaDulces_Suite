/* eslint-disable no-console */
/**
 * EMB.24–EMB.29 — Pago por viaje cerrado (ADR-091).
 *
 *   0. CONTRATO. Las cuatro relaciones son VISTAS; las de logística respetan la RLS de quien
 *      consulta (security_invoker); `finance.trip_pay_lines` tiene RLS forzada y el índice único
 *      parcial que impide pagar dos veces.
 *   1. EL CIERRE DE TRASPASOS, contra un cálculo INDEPENDIENTE (otra consulta, sobre kdm1 crudo):
 *      cada traspaso que la vista da por cerrado tiene su U-A-50 en la sucursal destino por el
 *      mismo importe. PRUEBA NEGATIVA de la trampa medida: TI### NO es el número de sucursal
 *      (TI007 = Zamora 05); traducir por el número encuentra menos recepciones.
 *   2. EL VIAJE (transacción que se deshace): abierto mientras haya paradas sin registrar; una
 *      parada sin registrar NO se cierra; registrada se cierra (foto opcional desde 2026-10-12); guía incompleta no libera nada.
 *   3. EL PAGO: el mismo renglón no entra a dos vales (23505, prueba negativa); si el vale se
 *      rechaza, el renglón vuelve a estar disponible sólo después de dejar de estar vigente.
 *
 * Uso:  node database/tests/test-newdb-emb-pago-por-viaje.js     (DATABASE_URL_NEW, local)
 */
require('dotenv').config();
const { Client } = require('pg');
const { assertSafeTarget } = require('./_lib/assert-safe-target');
const { correr, noMedido } = require('./_lib/no-medido');

const URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
const M = '00000000-0000-0000-0000-00000000d01c';

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}
const n = (v) => Number(v ?? 0);

correr(async () => {
  if (!URL) noMedido('falta DATABASE_URL_NEW en el entorno');
  assertSafeTarget('test-newdb-emb-pago-por-viaje', { url: URL });
  const db = new Client({ connectionString: URL });
  await db.connect();
  const q = async (sql, args) => (await db.query(sql, args)).rows;

  try {
    const [{ db: dbname }] = await q('SELECT current_database() AS db');
    console.log(`\n=== EMB.24–29 — Pago por viaje cerrado · destino ${dbname} ===\n`);

    // ── 0. Contrato ────────────────────────────────────────────────────────────────────────
    console.log('── 0. Contrato');
    const rels = await q(`
      SELECT ns.nspname || '.' || c.relname AS nombre, c.relkind::text AS kind, c.reloptions
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE (ns.nspname, c.relname) IN (('analytics','erp_shipment_stop_closure'),('logistics','v_trip_stop_closure'),
                                         ('logistics','v_trip_state'),('logistics','v_trip_pay_items'))`);
    if (rels.length === 0) noMedido('las vistas de EMB.24 no están en este destino (migración 20261012084447 sin aplicar)');
    assert(rels.length === 4 && rels.every((r) => r.kind === 'v'), 'las 4 relaciones existen y son VISTAS, no copias');
    assert(rels.filter((r) => r.nombre.startsWith('logistics.')).every((r) => (r.reloptions || []).includes('security_invoker=true')),
      'las vistas de logística son security_invoker (respetan la RLS de quien consulta)');
    const [tabla] = await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'finance.trip_pay_lines'::regclass`);
    assert(tabla.relrowsecurity && tabla.relforcerowsecurity, 'finance.trip_pay_lines tiene RLS forzada');
    const [ux] = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname='finance' AND indexname='ux_trip_pay_lines_una_vez'`);
    assert(ux && /UNIQUE/.test(ux.indexdef) && /WHERE vigente/.test(ux.indexdef), 'índice único parcial: un renglón vigente por viaje/persona/concepto');

    // ── 1. Cierre de traspasos contra un cálculo independiente ─────────────────────────────
    console.log('\n── 1. Traspasos: la recepción de Kepler, y la trampa del TI###');
    const muestra = await q(`
      SELECT sucursal, serie, folio, destino_code, destino_sucursal, importe_embarcado, recepcion_folio, recepcion_importe
        FROM analytics.erp_shipment_stop_closure
       WHERE tipo_parada = 'traspaso' AND cierre_kepler = 'cerrada'
       ORDER BY fecha DESC LIMIT 40`);
    if (muestra.length === 0) noMedido('no hay traspasos cerrados en este destino');
    let independientes = 0;
    for (const m of muestra) {
      const [r] = await q(`
        SELECT round(x.c16::numeric,2) AS importe FROM kepler_ods.kdm1 x
         WHERE x.c2='U' AND x.c3='A' AND x.c4=50 AND btrim(x.sucursal)=$1 AND btrim(x.c1)=$1
           AND x.c37=41 AND x.c38=$2 AND btrim(x.c39)=$3 AND btrim(x.c6)=$4`,
        [m.destino_sucursal, m.serie, m.folio, m.recepcion_folio]);
      if (r && Math.abs(n(r.importe) - n(m.importe_embarcado)) <= 1) independientes++;
    }
    assert(independientes === muestra.length,
      `las ${muestra.length} recepciones que la vista da por buenas existen en kdm1 crudo por el mismo importe (±$1)`);

    const [trampa] = await q(`
      SELECT count(*) FILTER (WHERE destino_code ~ '^TI[0-9]+$' AND right(destino_code,2) <> destino_sucursal) AS ti_distinto,
             count(*) FILTER (WHERE cierre_kepler = 'cerrada') AS cerradas_vista
        FROM analytics.erp_shipment_stop_closure WHERE tipo_parada = 'traspaso'`);
    assert(n(trampa.ti_distinto) > 0, `hay traspasos cuyo TI### NO es su número de sucursal (${trampa.ti_distinto}): traducir por número sería un error`);
    const [ingenuo] = await q(`
      SELECT count(*) AS n FROM analytics.erp_shipment_stop_closure c
       WHERE c.tipo_parada = 'traspaso' AND EXISTS (
         SELECT 1 FROM kepler_ods.kdm1 x
          WHERE x.c2='U' AND x.c3='A' AND x.c4=50 AND btrim(x.sucursal) = right(c.destino_code,2)
            AND btrim(x.c39) = c.folio AND x.c37=41 AND x.c38=c.serie)`);
    console.log(`     con la tabla pv_suc_ip: ${trampa.cerradas_vista} cerradas · traduciendo por el número: ${ingenuo.n} con recepción`);
    assert(n(ingenuo.n) < n(trampa.cerradas_vista), 'PRUEBA NEGATIVA: traducir TI### por el número de sucursal encuentra MENOS recepciones');

    // ── 2 y 3. El viaje y el pago, en una transacción que se deshace ───────────────────────
    console.log('\n── 2. El viaje: abierto → cerrado sólo con las paradas registradas');
    await db.query('BEGIN');
    try {
      const persona = async (nombre, rol) => (await q(
        `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active)
         VALUES ($1,$2,ARRAY[$3]::text[],'interno','activo',true) RETURNING id`, [M, nombre, rol]))[0].id;
      const chofer = await persona('PRUEBA CHOFER EMB', 'chofer');
      const ayudante = await persona('PRUEBA AYUDANTE EMB', 'ayudante');
      const cargador = await persona('PRUEBA CARGADOR EMB', 'cargador');

      const [s] = await q(`INSERT INTO logistics.shipments (tenant_id, folio, shipment_date, type, status)
        VALUES ($1,'EMB-PRUEBA-29','2026-09-30','entrega','programado') RETURNING id`, [M]);
      const [g] = await q(`INSERT INTO logistics.delivery_guides
          (tenant_id, number, shipment_id, type, status, driver_id, driver_commission, helper1_id, helper1_commission,
           departure_time, arrival_time, overnight, per_diem_total, per_diem_breakdown)
        VALUES ($1,'GUIA-PRUEBA-29',$2,'entrega','pendiente',$3,129,$4,91.2,'06:10','15:40',false,400,
          '{"driver":{"subtotal":200},"helper1":{"subtotal":200},"helper2":{"subtotal":0}}'::jsonb) RETURNING id`,
        [M, s.id, chofer, ayudante]);
      const r1 = (await q(`INSERT INTO logistics.guide_recipients (tenant_id, guide_id, customer_name, status)
        VALUES ($1,$2,'CLIENTE PRUEBA 1','pendiente') RETURNING id`, [M, g.id]))[0].id;
      const r2 = (await q(`INSERT INTO logistics.guide_recipients (tenant_id, guide_id, customer_name, status)
        VALUES ($1,$2,'CLIENTE PRUEBA 2','pendiente') RETURNING id`, [M, g.id]))[0].id;
      const [ld] = await q(`INSERT INTO logistics.load_details (tenant_id, shipment_id, driver_id, rate, role_at_time)
        VALUES ($1,$2,$3,30,'cargador') RETURNING id`, [M, s.id, cargador]);

      const estado = async () => (await q(`SELECT estado_viaje, paradas_pendientes FROM logistics.v_trip_state WHERE guide_id=$1`, [g.id]))[0];
      const items = async () => q(`SELECT rol, concept, amount, liberado, en_vale, estado_viaje FROM logistics.v_trip_pay_items WHERE shipment_id=$1 ORDER BY rol, concept`, [s.id]);

      let e = await estado();
      assert(e.estado_viaje === 'abierto' && n(e.paradas_pendientes) === 2, 'con dos paradas sin cerrar el viaje está ABIERTO');
      let it = await items();
      assert(it.filter((i) => i.rol !== 'cargador').every((i) => !i.liberado), 'abierto: comisión y viáticos RETENIDOS');
      assert(it.length === 5, 'cinco renglones: comisión y viático del chofer y del ayudante, y la carga');
      assert(!it.find((i) => i.rol === 'cargador').liberado, 'la carga de un embarque manual que no ha salido NO se libera');

      // Se mira LA PARADA, no el viaje: el viaje seguiría abierto por la otra parada aunque la
      // regla se rompiera (así lo encontró la mutación del 2026-10-12).
      const [p0] = await q(`SELECT estado_parada FROM logistics.v_trip_stop_closure WHERE recipient_id=$1`, [r1]);
      assert(p0.estado_parada === 'pendiente', 'PRUEBA NEGATIVA: sin registrar la entrega, la parada de cliente NO se cierra');

      await q(`UPDATE logistics.guide_recipients SET status='entregado', delivered_to='PRUEBA' WHERE id=$1`, [r1]);
      const [p1] = await q(`SELECT estado_parada FROM logistics.v_trip_stop_closure WHERE recipient_id=$1`, [r1]);
      assert(p1.estado_parada === 'cerrada', 'registrada «entregado» SIN foto, la parada se cierra (foto opcional desde 2026-10-12)');

      await q(`UPDATE logistics.guide_recipients SET status='no_entregado', incident_type='not_located' WHERE id=$1`, [r2]);
      await q(`UPDATE logistics.shipments SET status='en_ruta' WHERE id=$1`, [s.id]);
      e = await estado();
      assert(e.estado_viaje === 'cerrado', 'con las dos paradas registradas (una entrega y una no entrega) el viaje está CERRADO');
      it = await items();
      assert(it.every((i) => i.liberado), 'cerrado y con salida: todo liberado, incluida la carga');

      await q(`UPDATE logistics.delivery_guides SET departure_time=NULL WHERE id=$1`, [g.id]);
      e = await estado();
      assert(e.estado_viaje === 'guia_incompleta', 'una guía sin horario es «guía incompleta», aunque las paradas estén cerradas');
      assert((await items()).filter((i) => i.rol !== 'cargador').every((i) => !i.liberado), 'guía incompleta: no libera comisión ni viáticos');
      await q(`UPDATE logistics.delivery_guides SET departure_time='06:10' WHERE id=$1`, [g.id]);

      console.log('\n── 3. El pago: una vez, y de nuevo sólo si el vale se rechaza');
      const vale = async () => (await q(`INSERT INTO finance.expense_proofs (tenant_id, solicitante, proveedor, importe, files, status, created_by)
        VALUES ($1,'PRUEBA CHOFER EMB','PRUEBA CHOFER EMB',129,'[]','recibida','prueba') RETURNING id`, [M]))[0].id;
      const linea = (valeId) => db.query(`INSERT INTO finance.trip_pay_lines (tenant_id, expense_proof_id, source, source_id, shipment_id, driver_id, concept, amount)
        VALUES ($1,$2,'guia',$3,$4,$5,'comision',129)`, [M, valeId, g.id, s.id, chofer]);
      const v1 = await vale();
      await linea(v1);
      it = await items();
      assert(it.find((i) => i.rol === 'chofer' && i.concept === 'comision').en_vale, 'la comisión del chofer queda «en vale»');

      await db.query('SAVEPOINT doble');
      let code = null;
      try { await linea(await vale()); } catch (err) { code = err.code; }
      await db.query('ROLLBACK TO SAVEPOINT doble');
      assert(code === '23505', 'PRUEBA NEGATIVA: el mismo renglón NO entra a un segundo vale (23505)');

      await q(`UPDATE finance.expense_proofs SET status='rechazada' WHERE id=$1`, [v1]);
      it = await items();
      assert(!it.find((i) => i.rol === 'chofer' && i.concept === 'comision').en_vale, 'con el vale rechazado, la comisión deja de estar «en vale»');
      await db.query('SAVEPOINT vigente');
      code = null;
      try { await linea(await vale()); } catch (err) { code = err.code; }
      await db.query('ROLLBACK TO SAVEPOINT vigente');
      assert(code === '23505', 'mientras el renglón del vale rechazado siga vigente, no se duplica');
      await q(`UPDATE finance.trip_pay_lines SET vigente=false WHERE expense_proof_id=$1`, [v1]);
      await linea(await vale());
      assert(true, 'al dejar de estar vigente, el renglón entra al vale nuevo');

      assert(ld.id && (await items()).find((i) => i.rol === 'cargador').amount == 30, 'la carga se paga a la tarifa registrada ($30)');

      // [EMB.39] Carga por caja: 531 cajas × $0.20 = $106.20 entre dos → $53.10 cada quien. El
      // renglón guarda con qué cajas y qué tarifa se calculó; la vista paga lo que dice `rate`.
      const cargador2 = await persona('PRUEBA CARGADOR 2 EMB', 'cargador');
      await q(`DELETE FROM logistics.load_details WHERE shipment_id=$1`, [s.id]);
      await q(`INSERT INTO logistics.load_details (tenant_id, shipment_id, driver_id, rate, boxes, rate_per_box, role_at_time)
        VALUES ($1,$2,$3,53.10,531,0.2,'cargador'), ($1,$2,$4,53.10,531,0.2,'cargador')`, [M, s.id, cargador, cargador2]);
      const cargas = (await items()).filter((i) => i.rol === 'cargador');
      assert(cargas.length === 2 && cargas.every((i) => Number(i.amount) === 53.1), 'por caja: cada cargador cobra su parte ($53.10)');
      assert(Math.round(cargas.reduce((a, i) => a + Number(i.amount), 0) * 100) === 10620, 'las partes suman el total de la carga ($106.20)');
      await q(`UPDATE logistics.load_details SET rate=0 WHERE shipment_id=$1 AND driver_id=$2`, [s.id, cargador2]);
      assert((await items()).filter((i) => i.rol === 'cargador').length === 1, 'PRUEBA NEGATIVA: una carga de $0 (puras piezas sueltas) no genera pago');
    } finally {
      await db.query('ROLLBACK');
    }
    const [resto] = await q(`SELECT count(*) AS n FROM logistics.shipments WHERE folio='EMB-PRUEBA-29'`);
    assert(n(resto.n) === 0, 'no quedan residuos de la prueba');
    console.log(`\n${assertions} aserciones ✓`);
  } finally {
    await db.end();
  }
});
