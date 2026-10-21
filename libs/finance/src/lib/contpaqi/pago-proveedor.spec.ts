import { asientoCuadra, AsientoRechazado } from './poliza-egreso';
import {
  armarPagoProveedorCompleto, CUENTA, esProvisionada, type EntradaPagoProveedor, type FacturaPagada,
} from './pago-proveedor';
import { distanciaEdicion, normalizarNombre, resolverRfcAcreedor, type PadronEmisores } from './rfc-acreedor';

/**
 * `[CP.8.72]` Candado de las reglas del asiento de pago a proveedor. Puro: sin base, sin Nest.
 *
 * Cada caso es una forma medida en las pólizas de la contadora de 2026 (`FASE_CP8_ATERRIZAJE.md` §3.6),
 * y los rechazos son lo que NO debe salir armado: un asiento que cuadra a la fuerza es peor que uno
 * que se manda a confirmar.
 */
const SUF = '000123';
const renglones = (a: { movimientos: { cuenta: string; abono: boolean; importe: number }[] }) =>
  a.movimientos.map((m) => `${m.abono ? 'A' : 'C'} ${m.cuenta} ${m.importe.toFixed(2)}`);

const factura = (p: Partial<FacturaPagada> = {}): FacturaPagada => ({
  uuid: 'F-1', total: 11600, iva: 1600, ieps: 0, base16: 10000, fecha: '2026-10-05', enProvision: false, ...p,
});
const entrada = (p: Partial<EntradaPagoProveedor> = {}): EntradaPagoProveedor => ({
  fecha: '2026-10-19', concepto: 'PAGO PRUEBA', cuenta_banco: '1020250000', pagado: 11600, sufijo: SUF,
  facturas: [factura()], notas: [], ...p,
});

describe('R1 · factura provisionada → 2120 + traspaso de impuestos', () => {
  it('la factura de $52,339.34 (ago) pagada el 19-oct: 2120 + traspaso IEPS, sin renglón de IVA en cero', () => {
    // Caso real medido en `[CP.8.63]`: IEPS 3,876.99, IVA tasa 0.
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 52339.34,
      facturas: [factura({ uuid: '9FEAEBA1', total: 52339.34, iva: 0, ieps: 3876.99, base16: 0, fecha: '2026-08-26' })],
    }));
    expect(renglones(a)).toEqual([
      `C 2120${SUF} 52339.34`,
      'C 1470100000 3876.99',
      'A 1470110000 3876.99',
      'A 1020250000 52339.34',
    ]);
    expect(a.uuids).toEqual(['9FEAEBA1']);
    expect(a.redondeo).toBe(0);
    expect(asientoCuadra(a)).toBe(true);
  });

  it('IVA de una provisionada: 1060 C / 1470040 A por el IVA del CFDI', () => {
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 23200, facturas: [factura({ total: 23200, iva: 3200, base16: 20000, fecha: '2026-09-10' })],
    }));
    expect(renglones(a)).toContain('C 1060000000 3200.00');
    expect(renglones(a)).toContain('A 1470040000 3200.00');
  });
});

describe('2120 o compra directa: regla de 20 mil O provisión del mes', () => {
  it('$20 mil exactos de mes anterior → provisionada; $19,999.99 → directa (corte medido 19,500–20,499)', () => {
    expect(esProvisionada(factura({ total: 20000, fecha: '2026-09-30' }), '2026-10-01')).toBe(true);
    expect(esProvisionada(factura({ total: 19999.99, fecha: '2026-09-30' }), '2026-10-01')).toBe(false);
  });
  it('mismo mes y ≥ 20 mil → directa (98 % de los casos medidos)', () => {
    expect(esProvisionada(factura({ total: 50000, fecha: '2026-10-02' }), '2026-10-19')).toBe(false);
  });
  it('⭐ si está en la provisión de su mes, va a 2120 aunque la regla diga directa — no repite el doble registro', () => {
    expect(esProvisionada(factura({ total: 5000, fecha: '2026-10-02', enProvision: true }), '2026-10-19')).toBe(true);
  });
});

describe('R2 · compra directa → 5020 base 16 % + IVA + IEPS + 5010 el resto', () => {
  it('factura al 16 %: 5020 por la base del CFDI y 1060 por su IVA', () => {
    const a = armarPagoProveedorCompleto(entrada());
    expect(renglones(a)).toEqual([`C 5020${SUF} 10000.00`, 'C 1060000000 1600.00', 'A 1020250000 11600.00']);
  });
  it('factura mixta 0 %/16 %: se parte por la base del CFDI', () => {
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 21600, facturas: [factura({ total: 21600, iva: 1600, base16: 10000, fecha: '2026-10-02' })],
    }));
    expect(renglones(a)).toEqual([
      `C 5020${SUF} 10000.00`, 'C 1060000000 1600.00', `C 5010${SUF} 10000.00`, 'A 1020250000 21600.00',
    ]);
  });
  it('⭐ el residuo de centavos de la base NO abre un renglón 5010: va al redondeo (cargo 5201)', () => {
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 1160.03, facturas: [factura({ total: 1160.03, iva: 160, base16: 1000 })],
    }));
    expect(renglones(a).some((r) => r.includes(`5010${SUF}`))).toBe(false);
    expect(renglones(a)).toContain(`C ${CUENTA.NO_DEDUCIBLES} 0.03`);
    expect(asientoCuadra(a)).toBe(true);
  });
  it('sin base16 en el CFDI se usa la que implica el IVA', () => {
    const a = armarPagoProveedorCompleto(entrada({ facturas: [factura({ base16: null })] }));
    expect(renglones(a)[0]).toBe(`C 5020${SUF} 10000.00`);
  });
});

describe('Notas de crédito', () => {
  it('descuento al 0 % → abono 5050 + reversa del IEPS', () => {
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 11600 - 1080,
      notas: [{ uuid: 'N-1', total: 1080, iva: 0, ieps: 80, base16: 0, fecha: '2026-10-10', tipoRelacion: '01' }],
    }));
    expect(renglones(a)).toContain(`A 5050${SUF} 1000.00`);
    expect(renglones(a)).toContain('A 1470100000 80.00');
    expect(a.uuids).toEqual(['F-1', 'N-1']);
    expect(asientoCuadra(a)).toBe(true);
  });
  it('relación 03 al 16 % → devolución 5080 + reversa del IVA', () => {
    const a = armarPagoProveedorCompleto(entrada({
      pagado: 11600 - 1160,
      notas: [{ uuid: 'N-2', total: 1160, iva: 160, ieps: 0, base16: 1000, fecha: '2026-10-10', tipoRelacion: '03' }],
    }));
    expect(renglones(a)).toContain(`A 5080${SUF} 1000.00`);
    expect(renglones(a)).toContain('A 1060000000 160.00');
  });
});

describe('Redondeo y compuerta', () => {
  it('la contadora paga 6 ¢ menos que la factura → abono 4200010000 OTROS INGRESOS', () => {
    const a = armarPagoProveedorCompleto(entrada({ pagado: 11599.94 }));
    expect(renglones(a)).toContain(`A ${CUENTA.OTROS_INGRESOS} 0.06`);
    expect(a.redondeo).toBe(0.06);
    expect(asientoCuadra(a)).toBe(true);
  });
  it('⛔ si facturas − notas no da lo pagado (≥ $1), NO se arma: va a confirmar', () => {
    expect(() => armarPagoProveedorCompleto(entrada({ pagado: 11000 }))).toThrow(AsientoRechazado);
    try { armarPagoProveedorCompleto(entrada({ pagado: 11000 })); } catch (e) { expect((e as AsientoRechazado).motivo).toBe('no_cuadra'); }
  });
  it('⛔ sin facturas no se arma', () => {
    expect(() => armarPagoProveedorCompleto(entrada({ facturas: [] }))).toThrow(/qué facturas/);
  });
  it('⛔ sufijo de proveedor que no son 6 dígitos', () => {
    expect(() => armarPagoProveedorCompleto(entrada({ sufijo: '123' }))).toThrow(/Sufijo/);
  });
  it('pago parcial (fracción): todo proporcional y cuadra', () => {
    const a = armarPagoProveedorCompleto(entrada({ pagado: 5800, facturas: [factura({ fraccion: 0.5 })] }));
    expect(renglones(a)).toEqual([`C 5020${SUF} 5000.00`, 'C 1060000000 800.00', 'A 1020250000 5800.00']);
  });
});

describe('`[CP.8.71]` RFC del acreedor: se valida contra los emisores y se repara sólo si es único', () => {
  const padron: PadronEmisores = {
    rfcs: new Set(['PCP920423KQA', 'CCO820507BV4', 'BDE030612K56', 'AAA010101AAA', 'AAA010101AAB']),
    porNombre: new Map([[normalizarNombre('Botanas y Derivados, S.A. de C.V.'), new Set(['BDE030612K56'])]]),
  };
  it('tal cual', () => expect(resolverRfcAcreedor('BDE030612K56', null, padron)).toEqual({ rfc: 'BDE030612K56', via: 'tal_cual' }));
  it('dedazo de 2 caracteres', () => expect(resolverRfcAcreedor('PCP920523HQA', null, padron)).toEqual({ rfc: 'PCP920423KQA', via: 'parecido' }));
  it('con guiones y cortado («CCO-820507-BV»): a 1 edición', () => expect(resolverRfcAcreedor('CCO-820507-BV', null, padron)?.rfc).toBe('CCO820507BV4'));
  it('RFC de otra razón social → por el nombre del acreedor', () => {
    expect(resolverRfcAcreedor('ADI101008AL1', 'BOTANAS Y DERIVADOS SA DE CV', padron)).toEqual({ rfc: 'BDE030612K56', via: 'por_nombre' });
  });
  it('⛔ dos emisores a ≤ 2 ediciones → no se elige', () => expect(resolverRfcAcreedor('AAA010101AAC', null, padron)).toBeNull());
  it('⛔ nada se parece → null (se declara, no se adivina)', () => expect(resolverRfcAcreedor('ZZZ999999ZZZ', 'OTRO', padron)).toBeNull());
  it('distancia de edición con corte', () => {
    expect(distanciaEdicion('PCP920523HQA', 'PCP920423KQA')).toBe(2);
    expect(distanciaEdicion('ABCDEFGHIJKL', 'ZZZZZZZZZZZZ')).toBe(3);
  });
});
