import type { Knex } from 'knex';
import type { PaymentCalendarEnsayoKepler } from '@megadulces/contracts';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';
import { armarPagosKepler, conceptoDeFactura, CONCEPTO_GASTOS_GENERALES, motivosParaNoEscribir, type FacturaAPagar, type PlanPorConcepto, type ProveedorKepler } from './pago-kepler.armador';
import { compararConCaptura, NO_CUBIERTO_POR_EL_ENSAYO, type CapturaKepler } from './ensayo-pago-kepler';
import { SQL_CIERRE_KEPLER, armarCierres, type FilaCierreKepler } from '../cierre-kepler.sql';
import { leerValidacionDelDia } from '../validacion-pago.sql';
import { movimientosDePoliza, tablaPolizaDelMes } from '../../shared/kepler-contable';

/**
 * `[PGP.105]` **El ensayo del `X-D-26`, leído de la réplica.** Lee de `kepler_ods` —no del Kepler
 * vivo— lo mismo que lee el adaptador (`kepler-pago-sink.adapter.ts`): las facturas con su saldo, el
 * acreedor con los datos de su último pago, y la cuenta de tesorería; arma el documento con
 * `armarPagoKepler` (el MISMO código que escribiría) y aplica la compuerta de la Suite
 * (`motivosParaNoEscribir`). No escribe nada.
 *
 * Si Tesorería ya capturó el pago a mano (el cierre `[PGP.94]` lo encuentra por `kdxf`), el saldo de
 * cada factura se reconstruye como era ANTES de ese pago (`c20` + lo que le aplicó) y el plan se
 * compara contra lo capturado (`compararConCaptura`).
 *
 * ⚠️ La réplica va unos minutos atrás del Kepler vivo: el adaptador vuelve a leer todo en vivo antes
 * de escribir. El ensayo dice lo que se escribiría con lo que la réplica sabe.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Las facturas del pago, con su documento, saldo, concepto e impuestos. Parámetros: `[llaves (uuid[])]`. */
const SQL_FACTURAS_ENSAYO = `
SELECT k.oid::text AS oid, k.sucursal, btrim(k.c1) AS almacen, k.acreedor, k.doc_tipo::int AS tipo, k.doc_sub::int AS subtipo, k.folio,
       btrim(coalesce(k.c18, '')) AS concepto, btrim(coalesce(k.c16, '')) AS referencia, k.c20::float8 AS saldo,
       coalesce(m.c14::numeric, 0)::float8 AS iva, coalesce(m.c15::numeric, 0)::float8 AS ieps, coalesce(m.c16::numeric, 0)::float8 AS total
  FROM (SELECT ${sqlKeplerPayableId('d')} AS oid, d.*
          FROM (SELECT kdxe.sucursal, kdxe.c1, btrim(kdxe.c2) AS acreedor, kdxe.c4 AS doc_tipo, kdxe.c5 AS doc_sub,
                       btrim(kdxe.c6) AS folio, kdxe.c16, kdxe.c18, kdxe.c20
                  FROM kepler_ods.kdxe
                 WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A') d) k
  LEFT JOIN kepler_ods.kdm1 m
    ON m.sucursal = k.sucursal AND m.c1 = k.c1 AND m.c2 = 'X' AND m.c3 = 'A'
   AND btrim(m.c4::text) = btrim(k.doc_tipo::text) AND btrim(m.c5::text) = btrim(k.doc_sub::text) AND btrim(m.c6) = k.folio
 WHERE k.oid = ANY(?::uuid[])`;

/**
 * `[PGP.111]` P7: lo que la Suite escribiría (uno o varios X-D-26, uno por concepto) contra lo que Tesorería capturó
 * (uno o varios). Con uno y uno se comparan directo (así se ve la diferencia de concepto); con más, se parean por
 * concepto y lo que sobra de un lado se dice.
 */
function compararPlanesConCapturas(planes: PlanPorConcepto[], capturas: CapturaKepler[], sinCuenta: boolean) {
  const dif: string[] = [];
  if (sinCuenta) dif.push(`Cuenta de tesorería: la Suite no la sabe (el pago no trae cuenta de origen), Tesorería ${capturas[0].cuenta}`);
  if (planes.length === 1 && capturas.length === 1) {
    dif.push(...compararConCaptura(planes[0].plan, capturas[0]).diferencias);
  } else {
    const libres = [...capturas];
    for (const p of planes) {
      const i = libres.findIndex((c) => c.concepto === p.concepto);
      if (i < 0) { dif.push(`La Suite escribiría un X-D-26 con concepto ${p.concepto} (${p.importe.toFixed(2)}) que Tesorería no capturó así`); continue; }
      const [c] = libres.splice(i, 1);
      dif.push(...compararConCaptura(p.plan, c).diferencias.map((d) => `${p.concepto}: ${d}`));
    }
    for (const c of libres) dif.push(`Tesorería capturó el X-D-26 ${c.folio} con concepto ${c.concepto || '(vacío)'} que la Suite no escribiría`);
  }
  // La cuenta que falta ya se dijo una vez: la que el comparador agrega por documento sale sobrando.
  const limpias = sinCuenta ? dif.filter((d, k) => k === 0 || !/Cuenta de tesorería/.test(d)) : dif;
  return { folio: capturas.map((c) => c.folio).join(', '), coincide: limpias.length === 0, diferencias: limpias };
}

export async function leerEnsayoPagoKepler(trx: Knex | Knex.Transaction, tenantId: string, allocationId: string, hoy: string): Promise<PaymentCalendarEnsayoKepler | null> {
  const a = (await trx.raw(`
    SELECT a.id::text AS id, a.status, a.payment_method, a.bank_account_id::text AS bank_account_id, a.kepler_payment_folio,
           a.destination_account_text, a.amount_assigned::float8 AS importe, coalesce(a.folio, left(a.id::text, 8)) AS referencia,
           to_char(a.paid_bank_date, 'YYYY-MM-DD') AS paid_bank_date, to_char(a.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS alta,
           l.status AS lot_status, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
           b.bank, b.account_label, b.kind
      FROM finance.payment_allocations a
      JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
      LEFT JOIN finance.bank_accounts b ON b.id = a.bank_account_id
     WHERE a.tenant_id = ? AND a.id = ?`, [tenantId, allocationId])).rows[0];
  if (!a) return null;

  const items = (await trx.raw(`
    SELECT i.obligation_source, i.obligation_id::text AS obligation_id, i.applied_amount::float8 AS aplicado,
           (CASE WHEN i.obligation_source = 'kepler_payable' THEN i.obligation_id
                 WHEN o.kepler_folio IS NOT NULL
                 THEN md5('kepler_payable|' || o.kepler_sucursal || '|' || o.kepler_doc_tipo || '|' || o.kepler_doc_sub || '|' || btrim(o.kepler_folio))::uuid
            END)::text AS oid
      FROM finance.payment_allocation_items i
      LEFT JOIN commercial.supplier_payment_obligations o ON i.obligation_source = 'supplier_payable' AND o.id = i.obligation_id
     WHERE i.tenant_id = ? AND i.allocation_id = ?`, [tenantId, allocationId])).rows as
    { obligation_source: string; obligation_id: string; aplicado: number; oid: string | null }[];

  const vacio = (motivos: string[]): PaymentCalendarEnsayoKepler => ({
    allocation_id: allocationId, estado: 'bloqueado', motivos, servidor: null, avisos: [], documentos: [], captura: null, no_cubierto: [...NO_CUBIERTO_POR_EL_ENSAYO],
  });
  const oids = items.map((i) => i.oid).filter((x): x is string => !!x);
  if (oids.length !== items.length || !items.length) {
    return vacio(['El pago trae renglones que no son facturas de Kepler: sólo se escriben pagos a facturas de proveedor']);
  }
  const docs = (await trx.raw(SQL_FACTURAS_ENSAYO, [oids])).rows as
    { oid: string; sucursal: string; almacen: string; acreedor: string; tipo: number; subtipo: number; folio: string; concepto: string; referencia: string; saldo: number; iva: number; ieps: number; total: number }[];
  const docDe = new Map(docs.map((d) => [d.oid, d]));
  const faltan = items.filter((i) => !docDe.has(i.oid as string)).length;
  if (faltan) return vacio([`${faltan === 1 ? 'Una factura no está' : `${faltan} facturas no están`} en la réplica de Kepler`]);
  const servidores = [...new Set(docs.map((d) => d.sucursal))];
  const acreedores = [...new Set(docs.map((d) => d.acreedor))];
  if (servidores.length !== 1) return vacio(['Trae facturas de más de una sucursal: cada sucursal paga en su servidor']);
  if (acreedores.length !== 1) return vacio(['Trae facturas de más de un acreedor: un X-D-26 paga a uno solo']);
  const servidor = servidores[0];
  const acreedor = acreedores[0];

  // ── ¿Tesorería ya lo capturó a mano? El cierre lo encuentra por kdxf (la misma regla de la pantalla).
  const filas = (await trx.raw(SQL_CIERRE_KEPLER, [items.filter((i) => i.obligation_source === 'kepler_payable').map((i) => i.obligation_id), tenantId])).rows as FilaCierreKepler[];
  const cierre = armarCierres([{ id: allocationId, lotDate: a.dia, alta: a.alta ?? a.dia }],
    items.map((i) => ({ allocation_id: allocationId, obligation_source: i.obligation_source, obligation_id: i.obligation_id })), filas).get(allocationId);
  // `[PGP.111]` P7: Tesorería puede haber capturado UNA transferencia como varios X-D-26 (uno por concepto): se leen todos.
  const capturas: CapturaKepler[] = [];
  for (const xd of cierre?.pagos.filter((p) => p.tipo === 'transferencia' && p.sucursal === servidor) ?? []) {
    const h = (await trx.raw(`
      SELECT to_char(c9, 'YYYY-MM-DD') AS fecha, btrim(c10) AS acreedor, c16::float8 AS importe, btrim(coalesce(c45, '')) AS cuenta, btrim(coalesce(c12, '')) AS concepto,
             coalesce(c81::numeric, 0)::float8 AS iva, coalesce(c84::numeric, 0)::float8 AS ieps
        FROM kepler_ods.kdm1
       WHERE sucursal = ? AND c1 = ? AND c2 = 'X' AND c3 = 'D' AND btrim(c4::text) = '26' AND btrim(c5::text) = '1' AND btrim(c6) = ?
       LIMIT 1`, [servidor, servidor, xd.folio])).rows[0];
    const ap = (await trx.raw(`
      SELECT btrim(c7::text) || '-' || btrim(c8::text) || '-' || btrim(c9) AS factura, sum(c10::numeric)::float8 AS aplicado
        FROM kepler_ods.kdxf
       WHERE sucursal = ? AND btrim(c1) = ? AND btrim(c4::text) = '26' AND btrim(c5::text) = '1' AND btrim(c6) = ?
       GROUP BY 1`, [servidor, servidor, xd.folio])).rows as { factura: string; aplicado: number }[];
    if (h) {
      // `[PGP.106]` La póliza que Kepler le asentó, para compararla con la que armaría la Suite.
      const tabla = tablaPolizaDelMes(String(h.fecha));
      const hay = tabla ? (await trx.raw('SELECT to_regclass(?) IS NOT NULL AS ok', [`kepler_ods.${tabla}`])).rows[0].ok : false;
      const renglones = hay ? (await trx.raw(`
        SELECT btrim(c3) AS c3, btrim(c4) AS c4, c5::float8 AS c5 FROM kepler_ods.${tabla}
         WHERE sucursal = ? AND c8 = 'E' AND btrim(c15) = 'X' AND btrim(c16) = 'D' AND btrim(c17::text) = '26' AND btrim(c19) = ?`, [servidor, xd.folio])).rows : [];
      capturas.push({ folio: xd.folio, acreedor: h.acreedor, importe: h.importe, cuenta: h.cuenta, concepto: h.concepto, iva: h.iva, ieps: h.ieps, aplicaciones: Object.fromEntries(ap.map((x) => [x.factura, Number(x.aplicado)])),
        poliza: renglones.length ? movimientosDePoliza({ tipo: 'E', fecha: String(h.fecha), renglones }) : null });
    }
  }

  // ── El acreedor: catálogo del servidor + datos fiscales de su último pago (como el adaptador).
  const d = (await trx.raw(`SELECT btrim(c2) c2, btrim(c3) c3, btrim(coalesce(c10, '')) rfc, btrim(coalesce(c4, '')) dom, c16::text dias
      FROM kepler_ods.kdxd WHERE sucursal = ? AND btrim(c2) = ? LIMIT 1`, [servidor, acreedor])).rows[0];
  if (!d) return vacio([`Kepler (${servidor}) no tiene al acreedor ${acreedor} en su catálogo (kdxd)`]);
  const prev = (await trx.raw(`SELECT coalesce(c22, '') c22, coalesce(c32, '') c32, coalesce(c33, '') c33, coalesce(c34, '') c34, coalesce(c35, '') c35
      FROM kepler_ods.kdm1 WHERE sucursal = ? AND c1 = ? AND c2 = 'X' AND c3 = 'D' AND btrim(c4::text) = '26' AND btrim(c10) = ? AND c43 <> 'C'
      ORDER BY c6 DESC LIMIT 1`, [servidor, servidor, acreedor])).rows[0];
  const dias = Number(d.dias);
  const proveedor: ProveedorKepler = prev
    ? { codigo: d.c2, rfc: prev.c22, nombre: prev.c32, domicilio: [prev.c33, prev.c34, prev.c35], dias: Number.isFinite(dias) ? dias : null }
    : { codigo: d.c2, rfc: d.rfc, nombre: d.c3, domicilio: [d.dom, '', ''], dias: Number.isFinite(dias) ? dias : null };

  // ── La cuenta de tesorería: la misma regla del adaptador (dígitos + banco contra kdb1).
  const digitos = String(a.account_label ?? '').replace(/\D/g, '');
  const banco = String(a.bank ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const cuentas = (await trx.raw(`SELECT btrim(c1) code, btrim(c2) nombre FROM kepler_ods.kdb1
      WHERE sucursal = ? AND ? <> '' AND (regexp_match(c2, '([0-9]{3,})'))[1] LIKE '%' || ?
        AND (regexp_replace(upper(c2),'[^A-Z]','','g') LIKE ? || '%' OR ? LIKE regexp_replace(upper(c2),'[^A-Z]','','g') || '%'
             OR (? = 'BBAJIO' AND regexp_replace(upper(c2),'[^A-Z]','','g') = 'BAJIO'))`,
    [servidor, digitos, digitos, banco, banco, banco])).rows as { code: string; nombre: string }[];

  const aplicadoReal = (f: { tipo: number; subtipo: number; folio: string }) => capturas.reduce((s, c) => s + (c.aplicaciones[`${f.tipo}-${f.subtipo}-${f.folio}`] ?? 0), 0);
  const facturas: FacturaAPagar[] = items.map((i) => {
    const k = docDe.get(i.oid as string)!;
    // Con la captura de Tesorería, el saldo de antes de ese pago; si no, el de hoy.
    const saldo = r2(Number(k.saldo) + aplicadoReal(k));
    return { almacen: k.almacen, tipo: k.tipo, subtipo: k.subtipo, folio: k.folio, concepto: k.concepto, referencia: k.referencia, saldo, aplicado: Number(i.aplicado), iva: k.iva, ieps: k.ieps, total: k.total };
  });

  const motivos: string[] = [];
  if (cuentas.length !== 1) motivos.push(a.bank_account_id
    ? `La cuenta ${a.bank ?? ''} ${a.account_label ?? ''} corresponde a ${cuentas.length} cuentas de tesorería en Kepler (kdb1): se necesita exactamente una`
    : 'Falta la cuenta de origen: no se sabe de qué banco sale');
  const validacion = (await leerValidacionDelDia(trx, tenantId, a.dia, hoy)).get(allocationId);
  motivos.push(...motivosParaNoEscribir({
    status: a.status, payment_method: a.payment_method, origen_kind: a.kind ?? null, kepler_payment_folio: a.kepler_payment_folio,
    lot_status: a.lot_status, validacion_estado: validacion?.estado ?? null,
    items: items.map(() => ({ obligation_source: 'kepler_payable', branch_code: servidor, kepler_saldada: false })),
  }));
  if (capturas.length) motivos.push(`Tesorería ya lo capturó en Kepler (X-D-26 ${capturas.map((c) => c.folio).join(', ')}): escribirlo otra vez lo duplicaría`);

  // Sin cuenta propia, en modo comparación se arma con la de Tesorería para poder comparar lo demás;
  // que la Suite no la sabía queda como diferencia (no se esconde).
  const cuentaSuite = cuentas.length === 1 ? cuentas[0].code : '';
  const armado = armarPagosKepler({
    sucursal: servidor, fecha: a.paid_bank_date ?? a.dia, hora: '00:00', referencia: String(a.referencia), importe: Number(a.importe),
    cuentaTesoreria: cuentaSuite || capturas[0]?.cuenta || '', destino: a.destination_account_text ?? null, proveedor, facturas,
  });
  if (!armado.ok) motivos.push(...armado.motivos.filter((m) => !motivos.includes(m)));
  const planes = armado.ok ? armado.planes : [];
  // `[PGP.111]` P8 pendiente de Contabilidad: se avisa sin detener (no es un motivo).
  const avisos = facturas.some((f) => !(f.concepto ?? '').trim() && conceptoDeFactura(f) === CONCEPTO_GASTOS_GENERALES)
    ? [`Factura de gasto sin concepto: se paga con ${CONCEPTO_GASTOS_GENERALES} «Gastos generales», como lo hace Tesorería (pendiente de que Contabilidad lo confirme)`]
    : [];
  const facturaDe = new Map(facturas.map((f) => [`${f.tipo}-${f.subtipo}-${f.folio}`, f]));
  return {
    allocation_id: allocationId,
    estado: motivos.length ? 'bloqueado' : 'listo',
    motivos,
    servidor,
    avisos,
    documentos: planes.map(({ plan, facturas: ids }) => ({
      fecha: String(plan.kdm1['c9']), acreedor: proveedor.codigo, acreedor_nombre: proveedor.nombre, rfc: proveedor.rfc,
      importe: Number(plan.kdm1['c16']), cuenta_tesoreria: String(plan.kdm1['c45']), cuenta_nombre: cuentas.length === 1 ? cuentas[0].nombre : null,
      concepto: String(plan.kdm1['c12']), referencia: String(plan.kdm1['c11']), iva: Number(plan.kdm1['c81']), ieps: Number(plan.kdm1['c84']),
      aplicaciones: ids.map((id) => { const f = facturaDe.get(id)!; return { factura: id, aplicado: r2(f.aplicado), saldo_antes: r2(f.saldo), saldo_despues: r2(f.saldo - f.aplicado) }; }),
    })),
    captura: capturas.length
      ? (planes.length ? compararPlanesConCapturas(planes, capturas, !cuentaSuite) : { folio: capturas.map((c) => c.folio).join(', '), coincide: false, diferencias: ['La Suite no pudo armar el documento: ver los motivos'] })
      : null,
    no_cubierto: [...NO_CUBIERTO_POR_EL_ENSAYO],
  };
}
