import { describe, expect, it } from 'vitest';
import { ThreeWayDetail } from '../../bank.service';
import { explainMovements } from './three-way-explain';

/**
 * [CB.82] Lo posterior al último día del banco queda fuera del cuadre: el panel «Qué explica» no
 * puede listarlo como «falta en Workbook». Caso real (nov-2026, BBVA 6721): pagos del 11-nov que el
 * libro, cargado el 10, todavía no traía.
 */
function detalle(): ThreeWayDetail {
  return {
    period: '2026-11',
    account: { bank: 'BBVA', account_label: '6721', contpaqi_cuenta: '102', contpaqi_nombre: null, linked_cpq: true },
    excel: [],
    kepler_only: [
      { source: 'kepler', key: 'k1', doc: 'X-D-26 1', fecha: '2026-11-11', importe: 903918.62, dir: 'out', concepto: 'EFFEM', metodo: 'Tra', casado_otro_periodo: null, motivo: 'despues_del_banco' },
      { source: 'kepler', key: 'k2', doc: 'X-D-26 2', fecha: '2026-11-05', importe: 1000, dir: 'out', concepto: 'DENTRO', metodo: 'Tra', casado_otro_periodo: null, motivo: 'sin_casar' },
    ],
    contpaqi_only: [
      { source: 'contpaqi', key: 'c1', poliza: 'E 1', fecha: '2026-11-11', importe: 668239.2, dir: 'out', concepto: 'MONDELEZ', despues_del_banco: true },
      { source: 'contpaqi', key: 'c2', poliza: 'E 2', fecha: '2026-11-04', importe: 500, dir: 'out', concepto: 'DENTRO', despues_del_banco: false },
    ],
    recon_totals: {} as ThreeWayDetail['recon_totals'],
    agg: { bank_in: 0, kepler_in: 0, bank_out: 0, kepler_out: 0, delta_in: 0, delta_out: 0 },
    totals: { excel_n: 0, excel_monto: 0, excel_en_kepler: 0, excel_en_contpaqi: 0, sin_match_n: 0, sin_match_monto: 0,
      kepler_only_n: 2, kepler_only_monto: 0, kepler_only_otro_periodo_n: 0, kepler_only_otro_periodo_monto: 0,
      contpaqi_only_n: 2, contpaqi_only_monto: 0 },
    banco_hasta: '2026-11-10',
  };
}

describe('[CB.82] explainMovements y la ventana del banco', () => {
  it('Banco − Kepler: no lista lo de Kepler posterior al banco, sí lo de adentro', () => {
    const m = explainMovements(detalle(), 'egresos', 'wk');
    expect(m.map((x) => x.concepto)).toEqual(['DENTRO']);
  });

  it('Banco − ContPAQi: no lista la póliza posterior al banco, sí la de adentro', () => {
    const m = explainMovements(detalle(), 'egresos', 'wc');
    expect(m.map((x) => x.concepto)).toEqual(['DENTRO']);
  });

  it('control: sin la marca, lo posterior SÍ aparece (el filtro es la marca, no la fecha)', () => {
    const d = detalle();
    d.kepler_only[0].motivo = 'sin_casar';
    d.contpaqi_only[0].despues_del_banco = false;
    expect(explainMovements(d, 'egresos', 'kc').map((x) => x.concepto)).toEqual(['EFFEM', 'MONDELEZ', 'DENTRO', 'DENTRO']);
  });
});
