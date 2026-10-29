/**
 * `[CGA-A.65]` La hoja de gastos de zona — el motor, contra las hojas en PAPEL de Morelia (fotos de
 * Edgar, 2026-10-29) y los pagos REALES de Kepler de esos días (prod, sólo lectura). Una hoja que
 * no sale igual que el papel no sirve, por bonita que se vea.
 */
import { ZONAS_HOJA_GASTOS } from '@megadulces/contracts';
import {
  armarHojaAbierta, depositoDeHoja, instruccionDePago, motivoFueraDeHoja, retirosDeHoja,
  type DepositoBancoHoja, type PagoDeZona, type RetiroCaosHoja,
} from './hoja-gastos.engine';

const MORELIA = ZONAS_HOJA_GASTOS.find((z) => z.clave === 'morelia')!;
type Fila = [suc: string, folio: string, benef: string, importe: number, clave: string | null, centro: string | null, ref: string | null, capt: string];
const pago = (dia: string) => ([s, f, b, i, clave, centro, ref, capt]: Fila): PagoDeZona => ({
  origen_ref: `${s}|X-D-26|${f}|0011`, sucursal: s, doc_tipo: 'X-D-26', folio: f, fecha_pago: dia, fecha_captura: capt,
  beneficiario: b, clave, centro, referencia: ref, importe: String(i),
});

// Kepler, día de pago 23/10: los 13 de la hoja en papel («venta del día 23», $58,953.69) y 3 más.
const DIA_23: Fila[] = [
  ['07', '0000280', 'CAPITAN DE MARCA', 350, 'GNFC003', '002', 'CAPITAN DE MARCA', '2026-10-22'],
  ['07', '0000281', 'COMISIONES RUTAS DE VENTAS', 3660.83, null, '003', 'GUILLERMO HERNANDEZ', '2026-10-22'],
  ['07', '0000282', 'CUERITOS PREMIUM ZACAPU', 2850, 'CC036', '007', null, '2026-10-23'],
  ['07', '0000283', 'BOTANAS PAU', 7313, 'CB013', '007', null, '2026-10-23'],
  ['07', '0000284', 'VICTOR ANGUIANO GUZMAN', 372, 'CV003', '007', null, '2026-10-23'],
  ['07', '0000285', 'GASTOS GENERALES CAJA CHICA MORELIA MADERO', 1430.95, 'GG022', '007', null, '2026-10-23'],
  ['07', '0000286', 'FERNANDO GUTIERREZ RODRIGUEZ', 6055, 'CF019', '007', null, '2026-10-23'],
  ['07', '0000287', 'ALEGRIAS DE AMARANTO MONSIL', 6622.5, 'CA31', '007', null, '2026-10-23'],
  ['08', '0000530', 'CAPITAN DE MARCA', 1050, 'GNFC003', '002', 'CAPITAN DE MARCA', '2026-10-22'],
  ['08', '0000533', 'DELICIATE', 13035, 'CF007', '007', null, '2026-10-23'],
  ['08', '0000534', 'BOTANAS PAU', 7330, 'CB013', '007', null, '2026-10-23'],
  ['08', '0000535', 'ALEGRIAS DE AMARANTO MONSIL', 2215.8, 'CA31', '007', null, '2026-10-23'],
  ['08', '0000536', 'BOTANAS MICHOACAN', 4900, 'CR004', '007', null, '2026-10-23'],
  ['08', '0000537', 'VICTOR ANGUIANO GUZMAN', 6063.55, 'CV003', '007', null, '2026-10-23'],
  ['08', '0000538', 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS', 605.89, 'GG015', '007', null, '2026-10-23'],
  ['08', '0000541', 'ESTACION DE SERVICIO TAVISA', 160, 'GE005', '007', null, '2026-10-23'],
];

describe('[CGA-A.65] qué pago NO va en la hoja (la regla que reproduce el papel)', () => {
  it.each([
    ['009', 'NOMINA', 'nomina'],
    ['002', 'CAPITAN DE MARCA', 'apoyo_proveedores'],
    ['003', 'GUILLERMO HERNANDEZ', 'comisiones'],
    // Morelia paga mercancía con el centro 003: lo decide la referencia de la compra, no el centro.
    ['003', 'C-237', 'compra_registrada'],
    ['C-011', 'C-65', 'compra_registrada'],
    ['004', 'C-81', 'compra_registrada'],
    ['001', 'COMPRA 313', 'compra_registrada'],
  ])('centro %s, referencia «%s» → %s', (centro, ref, motivo) => {
    expect(motivoFueraDeHoja(centro, ref)).toBe(motivo);
  });

  it('SÍ van: el centro 007, y lo que quien captura dejó sin centro o con el 004 (las hojas lo traían)', () => {
    expect(motivoFueraDeHoja('007', null)).toBeNull();
    expect(motivoFueraDeHoja(null, '166')).toBeNull();
    expect(motivoFueraDeHoja('004', '0188')).toBeNull();
    expect(motivoFueraDeHoja('007', 'V-102444 VIATICOS')).toBeNull();
  });
});

describe('[CGA-A.65] la hoja de la venta del 23/10 sale igual que el papel', () => {
  const h = armarHojaAbierta(MORELIA, DIA_23.map(pago('2026-10-23')), '2026-10-29T12:00:00Z');

  it('13 renglones por $58,953.69, en el orden del papel: Abastos primero, por folio', () => {
    expect(h.renglones).toHaveLength(13);
    expect(h.total).toBe(58953.69);
    expect(h.renglones.map((r) => `${r.sucursal}-${r.folio.slice(-3)}`)).toEqual([
      '08-533', '08-534', '08-535', '08-536', '08-537', '08-538', '08-541',
      '07-282', '07-283', '07-284', '07-285', '07-286', '07-287',
    ]);
  });

  it('por sucursal y por clase, y suman el total', () => {
    expect(h.por_sucursal).toEqual([
      { sucursal: '08', renglones: 7, total: 34310.24 },
      { sucursal: '07', renglones: 6, total: 24643.45 },
    ]);
    expect(h.por_clase).toEqual([
      { clase: 'proveedor', renglones: 10, total: 56756.85 },
      { clase: 'gasto', renglones: 3, total: 2196.84 },
    ]);
  });

  it('lo que no va se ve con su motivo: los dos Capitán de marca y la comisión', () => {
    expect(h.fuera.map((r) => [r.folio.slice(-3), r.motivo])).toEqual([
      ['530', 'apoyo_proveedores'], ['280', 'apoyo_proveedores'], ['281', 'comisiones'],
    ]);
  });

  it('cómo se paga: de CAOS lo que da en billetes, el cajón el resto, y se deposita el total', () => {
    expect(h.instruccion).toEqual({ retiro: 58950, cajon: 3.69, deposito: 58953.69, referencia: null });
    expect(instruccionDePago(58953.69, 12).referencia).toBe('HG-12');
  });
});

describe('[CGA-A.65] el día de pago 21/10: dos hojas en papel, y los pagos de mercancía fuera', () => {
  const DIA_21: Fila[] = [
    ['07', '0000168', 'FERNANDO GUTIERREZ RODRIGUEZ', 5572, 'CF019', '007', null, '2026-10-20'],
    ['07', '0000173', 'CHURROS LOS BIGOTES', 2540, 'CC001', 'C-011', 'C-65', '2026-10-21'],
    ['07', '0000177', 'CHURROS LOS BIGOTES', 859, 'CC001', '004', 'C-81', '2026-10-21'],
    ['07', '0000189', 'FERNANDO GUTIERREZ RODRIGUEZ', 5180, 'CF019', '007', null, '2026-10-21'],
    ['08', '0000492', 'JOSE BALTAZAR ZUNIGA VAZQUEZ', 72091.5, 'CJ022', '003', 'C-237', '2026-10-21'],
    ['08', '0000507', 'BOTANAS PAU', 22138, 'CB013', '007', null, '2026-10-21'],
  ];
  const h = armarHojaAbierta(MORELIA, DIA_21.map(pago('2026-10-21')), null);

  it('los pagos de compras registradas (referencia «C-…») no entran, aunque su centro diga 003 o 004', () => {
    expect(h.renglones.map((r) => r.folio.slice(-3))).toEqual(['507', '168', '189']);
    expect(h.fuera.map((r) => [r.folio.slice(-3), r.motivo])).toEqual([
      ['492', 'compra_registrada'], ['173', 'compra_registrada'], ['177', 'compra_registrada'],
    ]);
    expect(h.total).toBe(32890);
  });

  it('sin edad del dato de Kepler, se dice null (no medido)', () => {
    expect(h.datos_al).toBeNull();
  });
});

describe('[CGA-A.65] la hoja vacía, y lo que no es de la zona', () => {
  it('sin pagos: total 0, sin instrucción, y las dos sucursales de la zona se declaran con 0', () => {
    const h = armarHojaAbierta(MORELIA, [], null);
    expect(h).toMatchObject({ total: 0, instruccion: null, renglones: [], fuera: [] });
    expect(h.por_sucursal).toEqual([{ sucursal: '08', renglones: 0, total: 0 }, { sucursal: '07', renglones: 0, total: 0 }]);
  });

  it('NEGATIVA: un pago de otra sucursal o repetido no entra a la hoja de Morelia', () => {
    const ajeno = pago('2026-10-23')(['06', '0000400', 'BOTANAS PAU', 500, 'CB013', '007', null, '2026-10-23']);
    const uno = pago('2026-10-23')(DIA_23[2]);
    const h = armarHojaAbierta(MORELIA, [ajeno, uno, { ...uno }], null);
    expect(h.renglones.map((r) => r.origen_ref)).toEqual([uno.origen_ref]);
    expect(h.total).toBe(2850);
  });
});

describe('[CGA-A.65] al pagar: el retiro se reconoce por el folio de la hoja', () => {
  const r = (id: number, ref: string): RetiroCaosHoja => ({ device: 'AST700', external_id: id, occurred_at: '2026-10-30T19:00:00Z', ref, total: 58950 });
  it('sólo los retiros cuya referencia nombra esa hoja', () => {
    const retiros = [r(1, 'gnf morelia HG-12'), r(2, 'gnf ma'), r(3, 'HG-120'), r(4, 'hg12')];
    expect(retirosDeHoja(12, retiros).map((x) => x.external_id)).toEqual([1, 4]);
    expect(retirosDeHoja(120, retiros).map((x) => x.external_id)).toEqual([3]);
    expect(retirosDeHoja(13, retiros)).toEqual([]);
  });
});

describe('[CGA-A.65] al pagar: el depósito, en una o dos partes, del día del retiro a 7 días', () => {
  // Con la forma de los depósitos medidos (la hoja de la venta del 20 se depositó en $80,000 y
  // $83,083.50 el mismo día del retiro), más depósitos que no son de ella.
  const d = (id: string, dia: string, importe: number): DepositoBancoHoja => ({ id, dia, importe });
  const banco = [
    d('a', '2026-10-23', 199000), d('b', '2026-10-23', 83083.5), d('c', '2026-10-23', 80000),
    d('e', '2026-10-23', 58953.5), d('f', '2026-10-23', 27000), d('g', '2026-10-26', 29832.5),
  ];

  it('dos partes que suman el total (± $0.50): la hoja de la venta del 20', () => {
    expect(depositoDeHoja(163083.49, '2026-10-23', banco)).toEqual({ estado: 'encontrado', ids: ['b', 'c'], suma: 163083.5 });
  });

  it('una parte: la hoja de la venta del 23 (se depositó $58,953.50 por $58,953.69)', () => {
    expect(depositoDeHoja(58953.69, '2026-10-23', banco)).toEqual({ estado: 'encontrado', ids: ['e'], suma: 58953.5 });
  });

  it('CONTROL: el mismo total corrido $1,000 no encuentra nada', () => {
    expect(depositoDeHoja(164083.49, '2026-10-23', banco)).toEqual({ estado: 'no_encontrado' });
    expect(depositoDeHoja(57953.69, '2026-10-23', banco)).toEqual({ estado: 'no_encontrado' });
  });

  it('NEGATIVA: un depósito antes del retiro o a más de 7 días no es de esta hoja', () => {
    expect(depositoDeHoja(58953.69, '2026-10-24', banco)).toEqual({ estado: 'no_encontrado' });
    expect(depositoDeHoja(29832.5, '2026-10-18', banco)).toEqual({ estado: 'no_encontrado' });
    expect(depositoDeHoja(29832.5, '2026-10-19', banco)).toEqual({ estado: 'encontrado', ids: ['g'], suma: 29832.5 });
  });

  it('NEGATIVA: más de una combinación posible NO se elige', () => {
    const dos = [d('x', '2026-10-23', 50000), d('y', '2026-10-23', 50000.2), d('z', '2026-10-23', 49999.9), d('w', '2026-10-23', 50000.1)];
    expect(depositoDeHoja(100000, '2026-10-23', dos)).toEqual({ estado: 'ambiguo', opciones: 6 });
  });

  it('en seis partes (la hoja del 14/10) no se reconoce sola: la liga una persona', () => {
    const seis = [55910.55, 46759.48, 33530, 31758, 1594, 144].map((v, i) => d(`s${i}`, '2026-10-15', v));
    expect(depositoDeHoja(169696.03, '2026-10-15', seis)).toEqual({ estado: 'no_encontrado' });
  });
});
