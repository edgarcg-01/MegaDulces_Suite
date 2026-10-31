/**
 * `[CGA-A.65]` La hoja de gastos de zona — el motor, contra las hojas en PAPEL de Morelia (fotos de
 * Edgar, 2026-10-29) y los pagos REALES de Kepler de esos días (prod, sólo lectura). Una hoja que
 * no sale igual que el papel no sirve, por bonita que se vea.
 */
import { ZONAS_HOJA_GASTOS } from '@megadulces/contracts';
import {
  armarHojaAbierta, cuadreDelRetiro, depositoDeHoja, instruccionDePago, motivoFueraDeHoja, requisitoDeHoja, retirosQueCuadran,
  type DepositoBancoHoja, type PagoDeZona, type RetiroLibreHoja,
} from './hoja-gastos.engine';

const MORELIA = ZONAS_HOJA_GASTOS.find((z) => z.clave === 'morelia')!;
type Fila = [suc: string, folio: string, benef: string, importe: number, clave: string | null, centro: string | null, ref: string | null, capt: string];
const pago = (dia: string) => ([s, f, b, i, clave, centro, ref, capt]: Fila): PagoDeZona => ({
  origen_ref: `${s}|X-D-26|${f}|0011`, sucursal: s, doc_tipo: 'X-D-26', folio: f, fecha_pago: dia, fecha_captura: capt,
  beneficiario: b, clave, centro, referencia: ref, importe: String(i), en_libro: null, cg_folio: null, en_hoja: false,
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
    expect(h).toMatchObject({ total: 0, instruccion: null, renglones: [], fuera: [], pagados_aparte: [] });
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

describe('[CGA-A.65] lo que ya salió de Caja General va abajo; lo capturado sin origen, en la hoja', () => {
  const base = pago('2026-10-23');
  const fila = (f: Fila, extra: Partial<PagoDeZona>): PagoDeZona => ({ ...base(f), ...extra });

  it('pagado con cajón o ligado a un retiro sin hoja: abajo, con su folio de Caja General', () => {
    const h = armarHojaAbierta(MORELIA, [
      fila(DIA_23[2], { en_libro: 'cajon', cg_folio: 'CG-2026-00600' }),
      fila(DIA_23[3], { en_libro: 'caos', cg_folio: 'CG-2026-00601' }),
      fila(DIA_23[4], { en_libro: 'sin_origen', cg_folio: 'CG-2026-00602' }),
      fila(DIA_23[5], {}),
    ], null);
    expect(h.pagados_aparte.map((r) => [r.folio.slice(-3), r.como, r.cg_folio])).toEqual([
      ['282', 'cajon', 'CG-2026-00600'], ['283', 'caos', 'CG-2026-00601'],
    ]);
    // Capturado sin decir de dónde salió: SÍ va en la hoja (al pagarla se liga a su retiro).
    expect(h.renglones.map((r) => r.folio.slice(-3))).toEqual(['284', '285']);
    expect(h.total).toBe(1802.95);
  });

  it('NEGATIVA: lo que ya va en otra hoja no aparece en la abierta', () => {
    const h = armarHojaAbierta(MORELIA, [fila(DIA_23[2], { en_hoja: true }), fila(DIA_23[3], {})], null);
    expect(h.renglones.map((r) => r.folio.slice(-3))).toEqual(['283']);
    expect(h.pagados_aparte).toEqual([]);
  });

  it('lo que no es reposición va abajo aunque ya esté en el libro (con su motivo, no como «pagado aparte»)', () => {
    const h = armarHojaAbierta(MORELIA, [fila(DIA_23[0], { en_libro: 'cajon', cg_folio: 'CG-2026-00700' })], null);
    expect(h.fuera.map((r) => r.motivo)).toEqual(['apoyo_proveedores']);
    expect(h.pagados_aparte).toEqual([]);
  });
});

describe('[CGA-A.65] el candado: qué pago sólo se paga con su hoja aprobada', () => {
  const p = (sucursal: string, fecha_pago: string, centro: string | null, referencia: string | null = null) =>
    ({ sucursal, fecha_pago, centro, referencia });

  it('un gasto de Abastos o de Madero desde el arranque de la zona: sí, y dice cuál zona', () => {
    expect(requisitoDeHoja(p('08', MORELIA.desde, '007'))?.clave).toBe('morelia');
    expect(requisitoDeHoja(p('07', '2026-11-03', null))?.clave).toBe('morelia');
    expect(requisitoDeHoja(p('06', '2026-11-03', '007'))?.clave).toBe('canindo');
  });

  it('NEGATIVA: antes del arranque, de otra sucursal, o lo que no va en la hoja → sigue su camino de siempre', () => {
    // Morelia arranca el 12/10 (Edgar, 2026-10-30: se registran las hojas en papel desde ahí); Canindo el 29/10.
    expect(requisitoDeHoja(p('08', '2026-10-11', '007'))).toBeNull();
    expect(requisitoDeHoja(p('06', '2026-10-28', '007'))).toBeNull();
    expect(requisitoDeHoja(p('01', '2026-11-03', '007'))).toBeNull();
    expect(requisitoDeHoja(p('08', '2026-11-03', '009'))).toBeNull();
    expect(requisitoDeHoja(p('08', '2026-11-03', '003', 'C-237'))).toBeNull();
    expect(requisitoDeHoja(p('08', '', '007'))).toBeNull();
  });
});

describe('[CGA-A.65] al pagar: UN retiro paga la hoja entera, y el cajón pone la diferencia', () => {
  it('las cinco hojas de octubre con retiro: cuadran, y el cajón pone lo que puso de verdad', () => {
    expect(cuadreDelRetiro(169696.03, 169500)).toEqual({ ok: true, cajon: 196.03 });
    expect(cuadreDelRetiro(135431, 135430)).toEqual({ ok: true, cajon: 1 });
    expect(cuadreDelRetiro(163083.49, 163080)).toEqual({ ok: true, cajon: 3.49 });
    expect(cuadreDelRetiro(58953.69, 58900)).toEqual({ ok: true, cajon: 53.69 });
    expect(cuadreDelRetiro(156678.61, 156670)).toEqual({ ok: true, cajon: 8.61 });
    expect(cuadreDelRetiro(1000, 1000)).toEqual({ ok: true, cajon: 0 });
  });

  it('NEGATIVA: un retiro mayor que la hoja, uno al que le faltan $500 o más, o uno vacío → no', () => {
    expect(cuadreDelRetiro(58953.69, 58960)).toMatchObject({ ok: false, motivo: 'mayor' });
    expect(cuadreDelRetiro(58953.69, 58450)).toMatchObject({ ok: false, motivo: 'corto' });
    expect(cuadreDelRetiro(58953.69, 58453.69)).toMatchObject({ ok: false, motivo: 'corto' });
    expect(cuadreDelRetiro(58953.69, 58453.70)).toEqual({ ok: true, cajon: 499.99 });
    expect(cuadreDelRetiro(58953.69, 0)).toMatchObject({ ok: false, motivo: 'vacio' });
  });

  // Los retiros REALES de CAOS de 10 mil o más del 21 al 29 de octubre (prod, sólo lectura).
  const r = (id: number, dia: string, cuando: string, ref: string, total: number): RetiroLibreHoja =>
    ({ device: 'AST700-19758', external_id: id, dia, occurred_at: `${cuando}:00-06:00`, ref, total });
  const OCT = [
    r(1675, '2026-10-21', '2026-10-21T11:41', 'cocadas', 20050),
    r(1677, '2026-10-21', '2026-10-21T11:42', 'corso', 68040),
    r(1692, '2026-10-22', '2026-10-22T09:42', 'fruti frsk', 160420),
    r(1695, '2026-10-22', '2026-10-22T10:12', 'bolsas', 149150),
    r(1706, '2026-10-23', '2026-10-23T13:52', 'gnf morelia', 163080),
    r(1707, '2026-10-23', '2026-10-23T14:03', 'gnf ma', 58900),
    r(1715, '2026-10-23', '2026-10-23T18:01', 'bono mkt', 10000),
    r(1717, '2026-10-24', '2026-10-24T12:08', 'coca cola', 45190),
    r(1722, '2026-10-26', '2026-10-26T13:48', 'tdc amex', 119720),
    r(1775, '2026-10-28', '2026-10-28T10:29', 'gnf 26/10', 156670),
    r(1795, '2026-10-29', '2026-10-29T11:01', 'don jhonny', 83620),
    r(1802, '2026-10-29', '2026-10-29T12:37', 'pal alma', 148060),
  ];

  it('la hoja de la venta del 20 y la del 23: un solo candidato cada una, y es el que la pagó', () => {
    expect(retirosQueCuadran(163083.49, null, '2026-10-21', '2026-10-21', OCT)).toEqual([
      { device: 'AST700-19758', external_id: 1706, ref: 'gnf morelia', total: 163080, dia: '2026-10-23', cajon: 3.49 },
    ]);
    expect(retirosQueCuadran(58953.69, null, '2026-10-23', '2026-10-23', OCT).map((x) => x.external_id)).toEqual([1707]);
    expect(retirosQueCuadran(156678.61, null, '2026-10-28', '2026-10-28', OCT).map((x) => x.external_id)).toEqual([1775]);
  });

  it('CONTROL: el mismo total corrido $1,000 no encuentra ninguno', () => {
    expect(retirosQueCuadran(164083.49, null, '2026-10-21', '2026-10-21', OCT)).toEqual([]);
    expect(retirosQueCuadran(57953.69, null, '2026-10-23', '2026-10-23', OCT)).toEqual([]);
  });

  it('NEGATIVA: un retiro antes del último pago de la hoja, o a más de 7 días, no es de ella', () => {
    expect(retirosQueCuadran(58953.69, null, '2026-10-24', '2026-10-24', OCT)).toEqual([]);
    expect(retirosQueCuadran(163083.49, null, '2026-10-12', '2026-10-15', OCT)).toEqual([]);
    // Aprobada tarde: la ventana corre desde la aprobación.
    expect(retirosQueCuadran(163083.49, null, '2026-10-12', '2026-10-17', OCT).map((x) => x.external_id)).toEqual([1706]);
  });

  it('con dos que cuadran: primero el que trae el folio de la hoja, luego el que deja menos al cajón', () => {
    const dos = [r(1, '2026-10-30', '2026-10-30T10:00', 'gnf', 9950), r(2, '2026-10-30', '2026-10-30T11:00', 'gnf hg-7', 9900),
      r(3, '2026-10-30', '2026-10-30T12:00', 'gnf', 9990)];
    expect(retirosQueCuadran(9999.5, 7, '2026-10-30', '2026-10-30', dos).map((x) => x.external_id)).toEqual([2, 3, 1]);
    expect(retirosQueCuadran(9999.5, null, '2026-10-30', '2026-10-30', dos).map((x) => x.external_id)).toEqual([3, 1, 2]);
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
