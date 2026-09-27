import { describe, expect, it } from 'vitest';
import type { FlujoRequisicionDto } from '@megadulces/contracts';
import {
  CandidatoOc, elegirOc, etapaRequisicion, mediana, negadosRecurrentes, resumenFlujo, sucursalKepler, surtidoPct,
  VENTANA_OC_DIAS,
} from './flujo-compras';

const C = (folio: string, comunes: number, dias = 3, monto = 1000): CandidatoOc =>
  ({ sucursal: '01', folio, fecha: '2026-09-10', dias, monto, comunes });

describe('[RA-PRO.63] elegirOc — la OC que trae más productos de la requisición', () => {
  it('gana la que trae más productos, aunque sea más lejana', () => {
    const r = elegirOc(10, [C('A', 6, 1), C('B', 9, 8)]);
    expect(r?.oc.folio).toBe('B');
    expect(r?.pct).toBe(90);
    expect(r?.confianza).toBe('alta');
    expect(r?.ambigua).toBe(false);
  });

  it('a igualdad de productos, la más cercana en fecha, y se DECLARA ambigua', () => {
    const r = elegirOc(4, [C('LEJOS', 3, 9), C('CERCA', 3, 2)]);
    expect(r?.oc.folio).toBe('CERCA');
    expect(r?.confianza).toBe('media');
    expect(r?.ambigua).toBe(true);
  });

  it('determinista: a igualdad total gana el folio menor', () => {
    expect(elegirOc(2, [C('0009', 2, 1), C('0002', 2, 1)])?.oc.folio).toBe('0002');
  });

  it('⭐ NEGATIVA: debajo de 50% no se liga (es otra compra del mismo proveedor)', () => {
    expect(elegirOc(10, [C('A', 4)])).toBeNull();
  });

  it('⭐ NEGATIVA: fuera de la ventana o antes de la requisición no cuenta', () => {
    expect(elegirOc(2, [C('A', 2, VENTANA_OC_DIAS + 1)])).toBeNull();
    expect(elegirOc(2, [C('A', 2, -1)])).toBeNull();
  });

  it('sin renglones o sin productos en común → null', () => {
    expect(elegirOc(0, [C('A', 1)])).toBeNull();
    expect(elegirOc(3, [C('A', 0)])).toBeNull();
    expect(elegirOc(3, [])).toBeNull();
  });

  it('comunes nunca pasa de 100%', () => {
    expect(elegirOc(2, [C('A', 5)])?.pct).toBe(100);
  });
});

describe('[RA-PRO.63] etapaRequisicion', () => {
  it('cada camino', () => {
    expect(etapaRequisicion({ sinFuente: true, conOc: true, conEntrada: true, diasDesde: 30 })).toBe('sin_fuente');
    expect(etapaRequisicion({ sinFuente: false, conOc: true, conEntrada: true, diasDesde: 30 })).toBe('con_entrada');
    expect(etapaRequisicion({ sinFuente: false, conOc: true, conEntrada: false, diasDesde: 30 })).toBe('en_oc');
    expect(etapaRequisicion({ sinFuente: false, conOc: false, conEntrada: false, diasDesde: 30 })).toBe('sin_oc');
  });
  it('⭐ NEGATIVA: una requisición de ayer sin OC NO es "sin OC": sigue en la ventana', () => {
    expect(etapaRequisicion({ sinFuente: false, conOc: false, conEntrada: false, diasDesde: 1 })).toBe('esperando');
    expect(etapaRequisicion({ sinFuente: false, conOc: false, conEntrada: false, diasDesde: VENTANA_OC_DIAS })).toBe('esperando');
  });
});

describe('[RA-PRO.63] surtidoPct', () => {
  it('en dinero, entero', () => {
    expect(surtidoPct(1000, 850)).toBe(85);
    expect(surtidoPct(1000, 0)).toBe(0);
  });
  it('⭐ NEGATIVA: OC sin monto → null, no división entre cero', () => {
    expect(surtidoPct(0, 500)).toBeNull();
    expect(surtidoPct(-10, 500)).toBeNull();
  });
});

const RQ = (p: Partial<FlujoRequisicionDto>): FlujoRequisicionDto => ({
  id: 'x', folio: 'RQ', fecha: '2026-09-01', almacen: '01', almacen_nombre: 'PH', proveedor: 'MONDELEZ',
  renglones: 0, costo: 0, etapa: 'sin_oc', motivo: null, oc: null, entrada: null, negados: 0, lineas: [], ...p,
});
const OC = (folio: string, monto: number) =>
  ({ sucursal: '01', folio, fecha: '2026-09-02', dias: 1, monto, coincidencia_pct: 100, confianza: 'alta' as const, ambigua: false, requisiciones_en_oc: 1 });

describe('[RA-PRO.63] resumenFlujo', () => {
  it('⭐ una OC compartida por dos requisiciones se cuenta UNA vez en el surtido', () => {
    const ent = { n: 1, primera_fecha: '2026-09-03', monto: 500, surtido_pct: 50 };
    const r = resumenFlujo([
      RQ({ id: '1', etapa: 'con_entrada', renglones: 4, negados: 1, oc: OC('A', 1000), entrada: ent }),
      RQ({ id: '2', etapa: 'con_entrada', renglones: 6, negados: 0, oc: OC('A', 1000), entrada: ent }),
      RQ({ id: '3', etapa: 'sin_oc', renglones: 9 }),
    ]);
    expect(r.ocs_distintas).toBe(1);
    expect(r.surtido_dinero_pct).toBe(50); // no 50+50 / 1000+1000 duplicado… ni 100
    expect(r.con_oc).toBe(2);
    expect(r.renglones_ligados).toBe(10); // la sin OC no entra
    expect(r.renglones_en_oc_pct).toBe(90);
    expect(r.por_etapa).toMatchObject({ con_entrada: 2, sin_oc: 1, en_oc: 0, esperando: 0, sin_fuente: 0 });
  });
  it('⭐ la MEDIANA no se deja arrastrar por una OC gigante a medio recibir', () => {
    const e = (monto: number, pct: number) => ({ n: 1, primera_fecha: null, monto, surtido_pct: pct });
    const r = resumenFlujo([
      RQ({ id: '1', etapa: 'con_entrada', oc: OC('GRANDE', 10_000_000), entrada: e(1_900_000, 19) }),
      RQ({ id: '2', etapa: 'con_entrada', oc: OC('B', 100_000), entrada: e(98_000, 98) }),
      RQ({ id: '3', etapa: 'con_entrada', oc: OC('C', 100_000), entrada: e(100_000, 100) }),
      RQ({ id: '4', etapa: 'en_oc', oc: OC('D', 50_000), entrada: null }),
    ]);
    expect(r.surtido_mediana_pct).toBe(98);
    expect(r.surtido_dinero_pct).toBe(20); // el ponderado se sigue dando, al lado
    expect(r.ocs_con_entrada).toBe(3); // D no tiene entrada: no entra a la mediana
  });
  it('mediana: par, impar, vacío', () => {
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([90, 100])).toBe(95);
    expect(mediana([])).toBeNull();
  });
  it('sin requisiciones ligadas: los porcentajes son null (no 0%)', () => {
    const r = resumenFlujo([RQ({ etapa: 'esperando', renglones: 3 })]);
    expect(r.renglones_en_oc_pct).toBeNull();
    expect(r.surtido_dinero_pct).toBeNull();
    expect(r.surtido_mediana_pct).toBeNull();
  });
});

describe('[RA-PRO.63] negadosRecurrentes', () => {
  const L = (sku: string, en_oc: boolean | null, costo = 100) => ({ sku, nombre: sku, costo, en_oc });
  it('cuenta pedido vs negado sólo en requisiciones con OC', () => {
    const out = negadosRecurrentes([
      RQ({ oc: OC('A', 1), lineas: [L('OREO', false), L('TRIDENT', true)] }),
      RQ({ oc: OC('B', 1), lineas: [L('OREO', false, 50), L('TRIDENT', false)] }),
      RQ({ oc: null, lineas: [L('OREO', null)] }), // sin OC: no se sabe → no cuenta
    ]);
    expect(out).toEqual([{ sku: 'OREO', nombre: 'OREO', proveedor: 'MONDELEZ', veces_pedido: 2, veces_negado: 2, costo_negado: 150 }]);
  });
  it('⭐ NEGATIVA: negado una sola vez no es recurrente', () => {
    expect(negadosRecurrentes([RQ({ oc: OC('A', 1), lineas: [L('X', false)] })])).toEqual([]);
  });
});

describe('[RA-PRO.63] sucursalKepler', () => {
  it('kepler_code gana; si no, el code de dos dígitos (CEDIS 00)', () => {
    expect(sucursalKepler('01', '01')).toBe('01');
    expect(sucursalKepler('00', null)).toBe('00');
  });
  it('⭐ NEGATIVA: el almacén Wincaja (MD-32) no tiene OC en Kepler → null', () => {
    expect(sucursalKepler('MD-32', null)).toBeNull();
    expect(sucursalKepler(null, null)).toBeNull();
  });
});
