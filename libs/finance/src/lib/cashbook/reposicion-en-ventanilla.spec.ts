import type { ZonaHojaGastos } from '@megadulces/contracts';
import type { PagoDeZona } from '../caja/hoja-gastos.engine';
import { hojaDeReposicion, type JuicioDePago } from './reposicion-en-ventanilla';

/** `[LE.6.8]` La hoja que ve la Ventanilla: la regla de siempre, sin lo anterior a la apertura ni lo ya pedido. */
const ZONA: ZonaHojaGastos = { clave: 'morelia', nombre: 'Zona Morelia', sucursales: ['08', '07'], desde: '2026-10-12', cuenta_deposito: null };
const pago = (folio: string, fecha: string, importe: number, over: Partial<PagoDeZona> = {}): PagoDeZona => ({
  origen_ref: `07|X-D-26|${folio}|0011`, sucursal: '07', doc_tipo: 'X-D-26', folio, fecha_pago: fecha, fecha_captura: fecha,
  beneficiario: 'GASTOS GENERALES', clave: 'G001', centro: '007', referencia: null, importe, en_libro: null, cg_folio: null, en_hoja: false, ...over,
});

describe('[LE.6.8] la hoja de reposición de la Ventanilla', () => {
  it('lo anterior a la apertura NO entra: se cuenta aparte (lo reconstruye E3)', () => {
    // $1,550.50: la máquina da $1,550 en billetes (3 de $500 y uno de $50) y el cajón pone los 50 centavos.
    const h = hojaDeReposicion(ZONA, [pago('1', '2026-10-15', 1000), pago('2', '2026-11-05', 1250.5), pago('3', '2026-11-05', 300)], '2026-11-05', new Set());
    expect(h.anteriores).toEqual({ n: 1, monto_minor: '100000' });
    expect(h.renglones.map((r) => r.folio)).toEqual(['2', '3']);
    expect(h).toMatchObject({ total_minor: '155050', maquina_minor: '155000', cajon_minor: '50', sin_arranque: false });
  });

  it('sin apertura no hay hoja: todo se declara como anterior', () => {
    const h = hojaDeReposicion(ZONA, [pago('1', '2026-11-05', 1000)], null, new Set());
    expect(h).toMatchObject({ sin_arranque: true, renglones: [], total_minor: '0', anteriores: { n: 1, monto_minor: '100000' } });
  });

  it('lo que no se repone sale con su motivo (la misma regla de la hoja), y lo ya pedido no vuelve a entrar', () => {
    const h = hojaDeReposicion(ZONA, [
      pago('1', '2026-11-05', 500),
      pago('2', '2026-11-05', 900, { centro: '009' }),
      pago('3', '2026-11-05', 700, { referencia: 'C-237' }),
      pago('4', '2026-11-05', 200),
    ], '2026-11-05', new Set(['07|X-D-26|4|0011']));
    expect(h.renglones.map((r) => r.folio)).toEqual(['1']);
    expect(h.fuera.map((f) => [f.folio, f.motivo])).toEqual([['2', 'nomina'], ['3', 'compra_registrada']]);
  });
});

describe('[LE.6.18] una sola autorización por pago: la hoja sólo pide firma si a algún pago le falta la suya', () => {
  const ref = (folio: string) => `07|X-D-26|${folio}|0011`;
  const libre: JuicioDePago = { detenido: null, firma: null };
  const pagos = [pago('1', '2026-11-05', 1000), pago('2', '2026-11-05', 550.5), pago('3', '2026-11-05', 300)];

  it('todos con su compra o su gasto aprobado: la hoja sale sin firma', () => {
    const h = hojaDeReposicion(ZONA, pagos, '2026-11-05', new Set(), new Map(pagos.map((p) => [p.origen_ref, libre])));
    expect(h).toMatchObject({ motivo_firma: null, detenidos: [], total_minor: '185050' });
    expect(h.renglones).toHaveLength(3);
  });

  it('uno sin autorización: entra, y la hoja entera pide la firma de Tesorería diciendo por qué', () => {
    const h = hojaDeReposicion(ZONA, pagos, '2026-11-05', new Set(), new Map<string, JuicioDePago>([
      [ref('1'), libre], [ref('2'), libre], [ref('3'), { detenido: null, firma: 'Kepler no dice qué gasto o compra paga' }],
    ]));
    expect(h.renglones).toHaveLength(3);
    expect(h.motivo_firma).toBe('1 pago no trae su autorización (Kepler no dice qué gasto o compra paga): la firma Tesorería');
  });

  it('lo detenido (gasto sin aprobar) no entra: va a «detenidos» con su motivo y no suma al total', () => {
    const h = hojaDeReposicion(ZONA, pagos, '2026-11-05', new Set(), new Map<string, JuicioDePago>([
      [ref('1'), libre], [ref('2'), { detenido: 'se aprueba en Aprobación de gastos', firma: null }], [ref('3'), libre],
    ]));
    expect(h.renglones.map((r) => r.folio)).toEqual(['1', '3']);
    expect(h.detenidos.map((d) => [d.folio, d.motivo])).toEqual([['2', 'se aprueba en Aprobación de gastos']]);
    expect(h).toMatchObject({ total_minor: '130000', motivo_firma: null });
  });

  it('sin veredicto (Kepler no se pudo leer) NO sale como autorizado: pide firma', () => {
    const h = hojaDeReposicion(ZONA, pagos, '2026-11-05', new Set());
    expect(h.motivo_firma).toMatch(/^3 pagos no traen su autorización/);
  });

  it('todo detenido: la hoja queda vacía, sin firma que pedir, y lo detenido se ve', () => {
    const h = hojaDeReposicion(ZONA, pagos, '2026-11-05', new Set(),
      new Map(pagos.map((p) => [p.origen_ref, { detenido: 'rechazado', firma: null }])));
    expect(h).toMatchObject({ renglones: [], total_minor: '0', motivo_firma: null });
    expect(h.detenidos).toHaveLength(3);
  });
});
