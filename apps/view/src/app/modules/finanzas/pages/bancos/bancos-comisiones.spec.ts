import { describe, expect, it } from 'vitest';
import type { CargoComision, DiaComision, PropuestaComisiones } from '../../bank.service';
import { cifrasDeComisiones, polizaDelGasto, vistaDeComisiones } from './bancos-comisiones';

/**
 * `[CB.62]` La vista «Comisiones»: cada sección cuenta lo mismo que el resumen de la API (si la lista y la cifra de
 * arriba no casan, la pantalla miente), lo más reciente primero, y lo que ya está completo en Kepler no sale.
 */
const c = (id: string, tipo: 'comision' | 'iva', importe: number, o: Partial<CargoComision> = {}): CargoComision =>
  ({ id, cuenta: '4885', concepto: `${tipo === 'iva' ? 'IVA TASA' : 'APLI TASA'} DE DES CREDITO/175096865`, fecha: '2026-11-03', importe, tipo, kepler_pago: null, kepler_sucursal: null, kepler_gasto: null, ...o });
const dia = (sucursal: string, dia_venta: string, estado: DiaComision['estado'], cargos: CargoComision[], o: Partial<DiaComision> = {}): DiaComision =>
  ({ sucursal, dia_venta, acreedor: 'GB004', banco: 'BBVA', estado, motivos: [], total: cargos.reduce((s, x) => s + x.importe, 0), iva: 0, cargos, plan: null, ...o });

const PROPUESTA: PropuestaComisiones = {
  medido: true, motivo: null, desde: '2026-10-27', hasta: '2026-11-10', descarga: { hasta: '2026-11-10', subida_en: '2026-11-10T15:43:45Z' },
  dias: [
    dia('06', '2026-10-30', 'lista', [c('c22', 'comision', 59.25), c('c23', 'iva', 9.48)]),
    dia('05', '2026-10-31', 'lista', [c('c1', 'comision', 93.58), c('c2', 'iva', 14.97)], {
      plan: { total: 108.55, iva: 14.97, gasto: { kdm6: [{ c7: 1, c11: 93.58 }], poliza: { tipo: 'D', fecha: '2026-10-31', renglones: [{ c3: '201', c4: 'A', c5: 108.55 }, { c3: '122-001', c4: 'C', c5: 14.97 }, { c3: '611-003', c4: 'C', c5: 93.58 }] } }, pagos: [{ cargo: 'c1', poliza: { fecha: '2026-11-03' } }, { cargo: 'c2', poliza: { fecha: '2026-11-03' } }] },
    }),
    // Morelia Abastos: Finanzas capturó el gasto, sin pagos.
    dia('08', '2026-10-31', 'parcial', [c('c3', 'comision', 3946.68, { kepler_gasto: 'gasto 0000321' }), c('c4', 'iva', 631.47)], { motivos: ['Finanzas ya capturó 1 de 1 comisiones en Kepler (gasto 0000321)'] }),
    // Pagos sueltos de Finanzas sin su gasto: por revisar, sólo lo no pagado.
    dia('01', '2026-11-02', 'parcial', [c('c5', 'comision', 67.52, { kepler_pago: '0000140' }), c('c6', 'iva', 10.8)], { motivos: ['1 de 2 pagos capturados: no se escribe encima'] }),
    // Yurécuaro: Finanzas tiene de ese día otro importe (candado 3).
    dia('04', '2026-11-04', 'parcial', [c('c7', 'comision', 15.37), c('c8', 'iva', 2.46)], { motivos: ['Finanzas ya tiene de ese día gasto 0000084 ($17.32) con otros importes: se revisa, no se escribe encima'] }),
    dia('07', '2026-11-03', 'ya_en_kepler', [c('c9', 'comision', 471.78, { kepler_pago: '0000300' }), c('c10', 'iva', 75.48, { kepler_pago: '0000301' })]),
  ],
  por_revisar: [
    { deposito: { id: 'd1', cuenta: '4176', banco: 'BBVA', fecha: '2026-11-09', importe: 1000 }, cargos: [c('c11', 'comision', 20, { cuenta: '4176' }), c('c12', 'iva', 3.2, { cuenta: '4176' })], motivo: 'la sucursal aún no captura este depósito', espera: true },
    { deposito: { id: 'd2', cuenta: '4176', banco: 'BBVA', fecha: '2026-11-05', importe: 500 }, cargos: [c('c13', 'comision', 10, { cuenta: '4176' }), c('c14', 'iva', 1.6, { cuenta: '4176' })], motivo: 'la sucursal aún no captura este depósito', espera: true },
    { deposito: { id: 'd3', cuenta: '7744', banco: 'BANORTE', fecha: '2026-11-06', importe: 900 }, cargos: [c('c15', 'comision', 30, { cuenta: '7744' }), c('c16', 'iva', 4.8, { cuenta: '7744' })], motivo: 'la sucursal aún no captura este depósito', espera: true },
    { deposito: { id: 'd4', cuenta: '4885', banco: 'BBVA', fecha: '2026-11-03', importe: 800 }, cargos: [c('c17', 'comision', 12.05), c('c18', 'iva', 1.93)], motivo: 'el depósito no está en Kepler (U-A-5) después de 7 días', espera: false },
    // Finanzas ya pagó todos sus cargos aunque la sucursal no capturó el depósito: no es trabajo de nadie.
    { deposito: { id: 'd5', cuenta: '4885', banco: 'BBVA', fecha: '2026-11-03', importe: 700 }, cargos: [c('c19', 'comision', 9.35, { kepler_pago: '0000221' }), c('c20', 'iva', 1.5, { kepler_pago: '0000222' })], motivo: 'el depósito no está en Kepler (U-A-5) después de 7 días', espera: false },
  ],
  huerfanos: [c('c21', 'comision', 7)],
  resumen: { cargos: 23, listos: 4, ya_en_kepler: 5, gasto_capturado_sin_pago: 2, esperando_sucursal: 6, por_revisar: 6, monto_listo: 177.28 },
};

const cargosDe = (xs: { cargos: number | CargoComision[] }[]): number => xs.reduce((s, x) => s + (typeof x.cargos === 'number' ? x.cargos : x.cargos.length), 0);

describe('[CB.62] vistaDeComisiones', () => {
  const v = vistaDeComisiones(PROPUESTA);

  it('cada sección cuenta los mismos cargos que el resumen de la API, y entre todas suman el total', () => {
    const r = PROPUESTA.resumen;
    expect(cargosDe(v.listos)).toBe(r.listos);
    expect(v.medias.reduce((s, d) => s + d.cargos.filter((x) => !x.kepler_pago).length, 0)).toBe(r.gasto_capturado_sin_pago);
    expect(cargosDe(v.espera)).toBe(r.esperando_sucursal);
    expect(cargosDe(v.revisar)).toBe(r.por_revisar);
    expect(r.listos + r.ya_en_kepler + r.gasto_capturado_sin_pago + r.esperando_sucursal + r.por_revisar).toBe(r.cargos);
  });

  it('lo listo va primero lo más reciente', () => {
    expect(v.listos.map((d) => `${d.sucursal} ${d.dia_venta}`)).toEqual(['05 2026-10-31', '06 2026-10-30']);
  });

  it('«a medias» es el día con un gasto de Finanzas (Morelia Abastos, gasto 0000321)', () => {
    expect(v.medias.map((d) => d.sucursal)).toEqual(['08']);
  });

  it('lo que espera a la sucursal va por cuenta: el banco no dice de qué sucursal es', () => {
    expect(v.espera).toEqual([
      { cuenta: '4176', banco: 'BBVA', depositos: 2, cargos: 4, total: 34.8, desde: '2026-11-05' },
      { cuenta: '7744', banco: 'BANORTE', depositos: 1, cargos: 2, total: 34.8, desde: '2026-11-06' },
    ]);
  });

  it('por revisar dice por qué: el día con otros importes, los pagos sueltos, el depósito viejo y el huérfano', () => {
    // Lo más reciente primero: 4-nov, el depósito y el huérfano del 3-nov (mayor importe antes), el día del 2-nov.
    expect(v.revisar.map((f) => [f.sucursal ?? f.cuenta, f.cargos])).toEqual([['04', 2], ['4885', 2], ['4885', 1], ['01', 1]]);
    expect(v.revisar[0].motivo).toMatch(/gasto 0000084/);
    expect(v.revisar[0].dia?.sucursal).toBe('04');
  });

  it('⛔ lo que ya tiene todos sus pagos en Kepler no sale en ninguna lista (ni el día ni el depósito)', () => {
    const ids = [...v.listos, ...v.medias].flatMap((d) => d.cargos.map((x) => x.id));
    expect(ids).not.toContain('c9');
    expect(v.revisar.some((f) => f.clave === 'b|d5')).toBe(false);
  });
});

describe('[CB.62] cifras y póliza', () => {
  it('la franja dice lo que NO se escribe y cada cifra abre su lista', () => {
    const it = cifrasDeComisiones(PROPUESTA);
    expect(it.map((x) => [x.label, x.value, x.drill ?? null])).toEqual([
      ['Finanzas los dejó a medias', 2, 'medias'], ['Esperando a la sucursal', 6, 'espera'], ['Por revisar', 6, 'revisar'], ['Con su pago en Kepler', 5, null],
    ]);
    expect(it[2].tone).toBe('warn');
  });

  it('la póliza del gasto se lee por cuenta, cargo o abono e importe', () => {
    expect(polizaDelGasto(PROPUESTA.dias[1])).toEqual([
      { cuenta: '201', lado: 'Abono', importe: 108.55 }, { cuenta: '122-001', lado: 'Cargo', importe: 14.97 }, { cuenta: '611-003', lado: 'Cargo', importe: 93.58 },
    ]);
    expect(polizaDelGasto(PROPUESTA.dias[0])).toEqual([]);
  });
});
