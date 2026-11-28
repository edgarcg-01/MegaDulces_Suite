/**
 * `[CSU.28]` Pruebas de la venta del turno y las facturas de contado.
 *
 * Casos REALES de Morelia Abastos, medidos en prod el 2026-11-26 (`database/scripts/csu28-turno-prod.js`):
 *  · Corte `0000161` (Caja 3-39, 2-nov): 118 tickets por $182,383.10 − devoluciones $8,751.25 = $173,631.85, el corte.
 *    Facturas del turno: `0000373` y `0000374` (un mismo cliente) y `0000376` (Contado, ticket 3-5114, $66,086.74, con
 *    la nota `UA2501-0000017` −$8,392.25 «Error de cobro.»).
 *  · `0000379` y `0000380` (otro cliente, 3-nov): tickets 9-120 y 9-121 → corte `0000163` (Caja 9-18).
 *  · `0000471` (14-nov): su ticket 1-1836 es del 6-oct → corte `0000024` (Caja 1-15), 39 días antes de la factura.
 *  · `0000539` (20-nov): su ticket 10-9 es del 30-sep → no hay corte: el corte POS empezó el 1-oct.
 */
import {
  armarFacturas, corteDeFactura, diasHastaFacturar, facturaDeContado, facturasDelTurno, pagoDelTicket, parametrosFacturas, ventaDelTurnoDetalle,
  type FacturaCruda,
} from './facturas-de-contado';
import type { CorteRow } from '@megadulces/contracts';

const cruda = (x: Partial<FacturaCruda>): FacturaCruda => ({
  sucursal: '08', tipo: 12, sub: 1, tipo_nombre: 'Factura Cont No Fiscal', folio: '0000000', fecha: '2026-11-02',
  cliente: 'CONTADO', total: '0', estado: 'N', ticket_caja: '3', ticket_folio: '0000000', ticket_fecha: '2026-11-02',
  ticket_turno: '39', ticket_total: '0', ticket_pago: '0|0', notas: [], ...x,
});

const F376 = facturaDeContado(cruda({
  folio: '0000376', total: '66086.74', ticket_folio: '0005114', ticket_total: '66086.21',
  notas: [{ doc_prefix: 'UA2501', folio: '0000017', fecha: '2026-11-02', monto: '8392.25', motivo: 'Error de cobro.' }],
}));
const F373 = facturaDeContado(cruda({ folio: '0000373', cliente: 'CLIENTE UNO', total: '8716.55', ticket_folio: '0005127', ticket_total: '8716.64' }));
const F374 = facturaDeContado(cruda({ folio: '0000374', cliente: 'CLIENTE UNO', total: '1098.47', ticket_folio: '0005130' }));
const F379 = facturaDeContado(cruda({ folio: '0000379', fecha: '2026-11-03', cliente: 'CLIENTE DOS', total: '6762.06', ticket_caja: '9', ticket_folio: '0000120', ticket_fecha: '2026-11-03', ticket_turno: '18', ticket_pago: '6762.05|0' }));
const F380 = facturaDeContado(cruda({ folio: '0000380', fecha: '2026-11-03', cliente: 'CLIENTE DOS', total: '37875.13', ticket_caja: '9', ticket_folio: '0000121', ticket_fecha: '2026-11-03', ticket_turno: '18' }));
const F471 = facturaDeContado(cruda({ folio: '0000471', fecha: '2026-11-14', total: '2521.50', ticket_caja: '1', ticket_folio: '0001836', ticket_fecha: '2026-10-06', ticket_turno: '15' }));
const F539 = facturaDeContado(cruda({ folio: '0000539', fecha: '2026-11-20', total: '1299.50', ticket_caja: '10', ticket_folio: '0000009', ticket_fecha: '2026-09-30', ticket_turno: '1' }));

const C161 = { sucursal: '08', folio: '0000161', caja: '3', turno: '39', fecha: '2026-11-02', monto: 173631.85, devoluciones_total: 8751.25 };
const C163 = { sucursal: '08', folio: '0000163', caja: '9', turno: '18', fecha: '2026-11-03', monto: 54506.76, devoluciones_total: 0 };
const C024 = { sucursal: '08', folio: '0000024', caja: '1', turno: '15', fecha: '2026-10-06', monto: 1, devoluciones_total: 0 };
const CORTES = [C161, C163, C024];
const TODAS = [F376, F373, F374, F379, F380, F471, F539];

describe('[CSU.28] la factura de contado', () => {
  it('0000376: su nota de crédito se ve y el neto la descuenta', () => {
    expect(F376).toMatchObject({ total: 66086.74, notas_total: 8392.25, neto: 57694.49, tipo_nombre: 'Factura Cont No Fiscal' });
    expect(F376.notas).toEqual([{ doc_prefix: 'UA2501', folio: '0000017', fecha: '2026-11-02', monto: 8392.25, motivo: 'Error de cobro.' }]);
    expect(F376.ticket).toMatchObject({ caja: '3', folio: '0005114', turno: '39', total: 66086.21, pago: { pago: 0, cambio: 0 } });
  });
  it('sin nota, el neto es el total', () => {
    expect(F373).toMatchObject({ notas: [], notas_total: 0, neto: 8716.55 });
  });
  it('sin ticket encontrado no se inventa uno', () => {
    expect(facturaDeContado(cruda({ ticket_fecha: null })).ticket).toBeNull();
  });
  it('el «pagó|cambio» del ticket se lee tal cual; vacío o ilegible es null, no cero', () => {
    expect(pagoDelTicket('18900|35.73')).toEqual({ pago: 18900, cambio: 35.73 });
    expect(pagoDelTicket(' 0 | 0 ')).toEqual({ pago: 0, cambio: 0 });
    expect(pagoDelTicket('')).toBeNull();
    expect(pagoDelTicket(null)).toBeNull();
    expect(pagoDelTicket('efectivo')).toBeNull();
  });
  it('días del ticket a la factura: 0000471 se facturó 39 días después', () => {
    expect(diasHastaFacturar(F471)).toBe(39);
    expect(diasHastaFacturar(F376)).toBe(0);
  });
  it('los parámetros siguen el orden de la consulta', () => {
    expect(parametrosFacturas('2026-11-01', '2026-11-25', ['08'])).toEqual(
      ['2026-11-01', ['08'], ['08'], ['08'], '2026-11-01', ['08'], '2026-11-01', '2026-11-25', '2026-11-01', '2026-11-25']);
  });
});

describe('[CSU.28] las facturas del turno', () => {
  it('corte 0000161: 0000376, 0000374 y 0000373 — sólo las de su caja y turno', () => {
    expect(facturasDelTurno(C161, TODAS).map((f) => f.folio)).toEqual(['0000376', '0000374', '0000373']);
  });
  it('corte 0000163: las dos del mismo cliente', () => {
    expect(facturasDelTurno(C163, TODAS).map((f) => f.folio)).toEqual(['0000380', '0000379']);
  });
  it('el mismo folio de turno en otra sucursal no es de este corte', () => {
    expect(facturasDelTurno({ ...C161, sucursal: '07' }, TODAS)).toEqual([]);
  });
});

describe('[CSU.28] el corte de una factura', () => {
  it('0000376 → 0000161; 0000379 y 0000380 → 0000163', () => {
    expect(corteDeFactura(F376, CORTES).corte?.folio).toBe('0000161');
    expect(corteDeFactura(F379, CORTES).corte?.folio).toBe('0000163');
    expect(corteDeFactura(F380, CORTES).corte?.folio).toBe('0000163');
  });
  it('0000471: facturada en noviembre, su corte es el de octubre de su ticket', () => {
    expect(corteDeFactura(F471, CORTES)).toEqual({ corte: C024, por_que: null });
  });
  it('0000539: ticket del 30-sep → «antes del corte POS», no «sin corte»', () => {
    expect(corteDeFactura(F539, CORTES)).toEqual({ corte: null, por_que: 'antes_del_corte_pos' });
  });
  it('ticket de octubre sin corte de su turno → «sin corte»', () => {
    expect(corteDeFactura(F471, [C161])).toEqual({ corte: null, por_que: 'sin_corte' });
  });
  it('sin ticket → «sin ticket»', () => {
    expect(corteDeFactura(facturaDeContado(cruda({ ticket_fecha: null })), CORTES)).toEqual({ corte: null, por_que: 'sin_ticket' });
  });
  it('dos cortes del mismo turno a ±1 día → ambiguo, no se elige uno', () => {
    expect(corteDeFactura(F376, [C161, { ...C161, folio: '0000999', fecha: '2026-11-03' }])).toEqual({ corte: null, por_que: 'ambiguo' });
  });
});

describe('[CSU.28] el paso «La venta del turno»', () => {
  it('0000161: 118 tickets $182,383.10 − $8,751.25 = $173,631.85, igual al corte, con sus 3 facturas', () => {
    const d = ventaDelTurnoDetalle(C161, { tickets: 118, total: 182383.1 }, TODAS);
    expect(d).toMatchObject({ tickets: 118, total: 182383.1, devoluciones: 8751.25, neto: 173631.85, igual_al_corte: true });
    expect(d?.facturas.map((f) => f.folio)).toEqual(['0000376', '0000374', '0000373']);
  });
  it('si el corte no es la venta del turno, lo dice (no lo esconde)', () => {
    expect(ventaDelTurnoDetalle({ ...C161, monto: 170000 }, { tickets: 118, total: 182383.1 }, TODAS)?.igual_al_corte).toBe(false);
  });
  it('sin venta del turno → null (no un detalle de ceros)', () => {
    expect(ventaDelTurnoDetalle(C161, null, TODAS)).toBeNull();
  });
});

describe('[CSU.30] el corte de una factura, con el rango en que se buscaron cortes', () => {
  const RANGO = { desde: '2026-10-31', hasta: '2026-11-26' };
  it('0000471: su ticket (6-oct) es de fuera del rango → «otro periodo», no «sin corte»', () => {
    expect(corteDeFactura(F471, [C161], RANGO)).toEqual({ corte: null, por_que: 'otro_periodo' });
  });
  it('con su corte en la lista, aunque sea de otro periodo, se liga', () => {
    expect(corteDeFactura(F471, CORTES, RANGO).corte?.folio).toBe('0000024');
  });
  it('un ticket de septiembre con corte (Padre Hidalgo tuvo 5) se liga: primero se busca, luego se explica', () => {
    const ph = { sucursal: '08', folio: '0000005', caja: '10', turno: '1', fecha: '2026-09-30', monto: 1, devoluciones_total: 0 };
    expect(corteDeFactura(F539, [ph], RANGO).corte?.folio).toBe('0000005');
  });
  it('sin rango, un ticket sin corte es «sin corte» (como en CSU.28)', () => {
    expect(corteDeFactura(F471, [C161])).toEqual({ corte: null, por_que: 'sin_corte' });
  });
  it('[CSU.31] un ticket de la ORILLA del rango sin corte es «otro periodo»: su corte puede ser del día de junto, que no se buscó', () => {
    const orilla = (fecha: string) => facturaDeContado(cruda({ folio: '0000901', ticket_caja: '7', ticket_turno: '99', ticket_fecha: fecha }));
    expect(corteDeFactura(orilla(RANGO.desde), [C161], RANGO).por_que).toBe('otro_periodo');
    expect(corteDeFactura(orilla(RANGO.hasta), [C161], RANGO).por_que).toBe('otro_periodo');
    // Adentro del rango, sus cortes posibles (±1 día) sí se buscaron todos: no tiene corte.
    expect(corteDeFactura(orilla('2026-11-01'), [C161], RANGO).por_que).toBe('sin_corte');
  });
});

describe('[CSU.30] la respuesta de facturas', () => {
  const llego = { estado: 'llego' as const, llego: 173631.85, por_saber: 0, sin_conciliar: 0, puente: 0, sin_deposito: 0, edad_dias: null };
  const fila = (c: typeof C161, x: Partial<CorteRow> = {}): CorteRow => ({
    ...c, clave: `${c.sucursal}-UD2301-${c.folio}`, documento: `UD2301-${c.folio}`, referencia: `Caja ${c.caja}-${c.turno}`,
    cuadre: 'cuadra', diferencia: 0, cobros: [], llegada: llego, venta_turno: null, venta_sin_forma_de_pago: null, ...x,
  }) as unknown as CorteRow;
  const CORTES_ROW = [fila(C161, { cuadre: 'corte_distinto', diferencia: 89436.19, venta_sin_forma_de_pago: 89436.19 }), fila(C163, { llegada: null })];
  const BASE = {
    periodo: { from: '2026-11-01', to: '2026-11-25' }, alcance: { todas: true, sucursales: [] }, sucursal: null, corte: null,
    rango: { desde: '2026-10-31', hasta: '2026-11-26' }, llegada_medida: true,
  };

  it('las del periodo por su fecha, la más nueva primero, cada una con su corte o con por qué no lo tiene', () => {
    const r = armarFacturas(TODAS, CORTES_ROW, BASE);
    expect(r.facturas.map((f) => [f.folio, f.corte, f.sin_corte])).toEqual([
      ['0000539', null, 'antes_del_corte_pos'],
      ['0000471', null, 'otro_periodo'],
      ['0000380', '08-UD2301-0000163', null],
      ['0000379', '08-UD2301-0000163', null],
      ['0000376', '08-UD2301-0000161', null],
      ['0000374', '08-UD2301-0000161', null],
      ['0000373', '08-UD2301-0000161', null],
    ]);
  });
  it('cada corte va una vez, con su llegada y su venta sin forma de pago', () => {
    const r = armarFacturas(TODAS, CORTES_ROW, BASE);
    expect(Object.keys(r.cortes).sort()).toEqual(['08-UD2301-0000161', '08-UD2301-0000163']);
    expect(r.cortes['08-UD2301-0000161']).toMatchObject({ llegada: { estado: 'llego' }, venta_sin_forma_de_pago: 89436.19 });
  });
  it('el resumen por tipo: facturas, monto, notas y el estado del corte de cada una («no medido» si su llegada no se midió)', () => {
    const [t] = armarFacturas(TODAS, CORTES_ROW, BASE).tipos;
    expect(t).toMatchObject({ tipo: 12, tipo_nombre: 'Factura Cont No Fiscal', facturas: 7, notas: 1, notas_monto: 8392.25 });
    expect(t.monto).toBe(124359.95);
    expect(t.neto).toBe(115967.7);
    expect(t.por_corte.llego).toEqual({ facturas: 3, monto: 75901.76 });
    expect(t.por_corte.no_medido).toEqual({ facturas: 2, monto: 44637.19 });
    expect(t.por_corte.otro_periodo).toEqual({ facturas: 1, monto: 2521.5 });
    expect(t.por_corte.antes_del_corte_pos).toEqual({ facturas: 1, monto: 1299.5 });
    expect(t.por_corte.sin_deposito).toEqual({ facturas: 0, monto: 0 });
  });
  it('con «corte»: las facturas de SU turno aunque la factura sea de otra fecha', () => {
    const tarde = facturaDeContado(cruda({ folio: '0000700', fecha: '2026-12-20', total: '10', ticket_folio: '0005200' }));
    const r = armarFacturas([...TODAS, tarde], CORTES_ROW, { ...BASE, corte: '08-UD2301-0000161' });
    expect(r.facturas.map((f) => f.folio)).toEqual(['0000700', '0000376', '0000374', '0000373']);
    expect(r.facturas.every((f) => f.corte === '08-UD2301-0000161')).toBe(true);
  });
  it('un corte que no está (o no es visible) → ninguna factura, no las de otro corte', () => {
    expect(armarFacturas(TODAS, CORTES_ROW, { ...BASE, corte: '08-UD2301-0000999' }).facturas).toEqual([]);
  });
  it('con «sucursal»: sólo las suyas', () => {
    expect(armarFacturas(TODAS, CORTES_ROW, { ...BASE, sucursal: '07' }).facturas).toEqual([]);
  });
});
