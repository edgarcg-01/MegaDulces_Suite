import { decidirPagosPorElBanco, gruposQueCasan, referenciaDeSalida, type PagoPendiente, type SalidaBanco } from './pago-por-el-banco';
import {
  RX_DEVOLUCION, SQL_SALIDAS_DE_LA_DESCARGA, SQL_SALIDAS_LIGADAS, SQL_SALIDAS_POR_EL_BANCO,
} from './pago-por-el-banco.sql';
import { SQL_LIBERADOS_QUE_SALIERON, SQL_SALIDA_DE_BANCO } from './pagos-vencidos.sql';

/**
 * `[PGP.201]` El testigo del banco: el pago partido en varias transferencias (Effem, 18-nov, prod) y la salida devuelta.
 * Las formas son las de prod: dos SPEI desde la misma cuenta, el mismo día, con la referencia `018112610087` al final del
 * concepto, que sumados dan el pago.
 */
const HOY = '2026-11-23';
const EFFEM: PagoPendiente = { id: 'effem', dia: '2026-11-18', importe: 1219113.39, metodo: null };
const spei = (o: Partial<SalidaBanco> = {}): SalidaBanco => ({
  id: 's1', cuenta_id: 'bbva4176', fecha: '2026-11-18', importe: 1000000,
  concepto: 'SPEI ENVIADO CITI MEXICO/0036039880 124 018112610087', ...o,
});
const PARTES = [spei(), spei({ id: 's2', importe: 219113.39, concepto: 'SPEI ENVIADO CITI MEXICO/0036040047 124 018112610087' })];

describe('[PGP.201] la referencia que comparten las partes de un pago', () => {
  it('es el número de 6 dígitos o más al final del concepto; sin él, o puros ceros, no hay', () => {
    expect(referenciaDeSalida('SPEI ENVIADO CITI MEXICO/0036039880 124 018112610087')).toBe('018112610087');
    expect(referenciaDeSalida('  PAGO 123456  ')).toBe('123456');
    expect(referenciaDeSalida('PAGO TRANSFERENCIA SPEI')).toBeNull();
    expect(referenciaDeSalida('REF 12345')).toBeNull();
    expect(referenciaDeSalida('REF 000000')).toBeNull();
    expect(referenciaDeSalida(null)).toBeNull();
  });
});

describe('[PGP.201] un pago partido en varias transferencias', () => {
  it('Effem: dos SPEI con la misma referencia que suman el pago lo prueban (antes: «sin salida» y seguía pendiente)', () => {
    const d = decidirPagosPorElBanco([EFFEM], PARTES, HOY).get('effem');
    expect(d).toEqual({ estado: 'probado', movimiento_id: 's1', cuenta_id: 'bbva4176', fecha: '2026-11-18', importe: 1219113.39, grupo: ['s1', 's2'] });
  });

  it('control: sin la referencia común, con otra suma, en otra cuenta, otro día o fuera de la ventana, no hay grupo', () => {
    const sinRef = PARTES.map((x) => ({ ...x, concepto: 'PAGO TRANSFERENCIA SPEI' }));
    expect(decidirPagosPorElBanco([EFFEM], sinRef, HOY).get('effem')?.estado).toBe('sin_salida');
    const otraRef = [PARTES[0], { ...PARTES[1], concepto: 'SPEI ENVIADO CITI MEXICO/0036040047 124 018112699999' }];
    expect(decidirPagosPorElBanco([EFFEM], otraRef, HOY).get('effem')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([{ ...EFFEM, importe: EFFEM.importe + 100 }], PARTES, HOY).get('effem')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([EFFEM], [PARTES[0], { ...PARTES[1], cuenta_id: 'otra' }], HOY).get('effem')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([EFFEM], [PARTES[0], { ...PARTES[1], fecha: '2026-11-19' }], HOY).get('effem')?.estado).toBe('sin_salida');
    expect(gruposQueCasan({ ...EFFEM, dia: '2026-11-10' }, PARTES)).toEqual([]);
  });

  it('una salida que ya es prueba de otro pago no entra al grupo', () => {
    expect(decidirPagosPorElBanco([EFFEM], PARTES, HOY, new Set(['s2'])).get('effem')?.estado).toBe('sin_salida');
  });

  it('si una parte casa sola con otro pago pendiente, no se adivina de quién es', () => {
    const otro: PagoPendiente = { id: 'otro', dia: '2026-11-18', importe: 219113.39, metodo: null };
    const d = decidirPagosPorElBanco([EFFEM, otro], PARTES, HOY);
    expect(d.get('effem')?.estado).toBe('disputada');
    expect(d.get('otro')?.estado).toBe('probado');
  });

  it('un grupo no explica dos pagos del mismo importe', () => {
    const gemelo: PagoPendiente = { ...EFFEM, id: 'gemelo', dia: '2026-11-17' };
    const d = decidirPagosPorElBanco([EFFEM, gemelo], PARTES, HOY);
    expect([d.get('effem')?.estado, d.get('gemelo')?.estado].filter((e) => e === 'probado')).toHaveLength(1);
  });

  it('la salida por el importe completo sigue ganando: el grupo es sólo cuando no la hay', () => {
    const completa = spei({ id: 's9', importe: 1219113.39, concepto: 'SPEI ENVIADO CITI MEXICO/0036049999 124 018112610087' });
    expect(decidirPagosPorElBanco([EFFEM], [completa, ...PARTES], HOY).get('effem')).toMatchObject({ estado: 'probado', movimiento_id: 's9' });
  });
});

describe('[PGP.201] una salida devuelta no es un pago (consultas)', () => {
  it('el libro, la descarga, la liberación y los liberados que salieron descartan la devuelta', () => {
    for (const sql of [SQL_SALIDAS_POR_EL_BANCO, SQL_SALIDAS_DE_LA_DESCARGA, SQL_SALIDA_DE_BANCO, SQL_LIBERADOS_QUE_SALIERON]) {
      expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM finance\.(bank_movements|bank_statement_lines) dv/);
      expect(sql).toContain(RX_DEVOLUCION);
    }
    expect(SQL_SALIDAS_POR_EL_BANCO).toContain("dv.raw_type = 'DS'");
  });

  it('el texto de la devolución reconoce cómo la nombra cada banco, y no una salida normal', () => {
    const rx = new RegExp(RX_DEVOLUCION, 'i');
    for (const c of ['SPEI DEVUELTOSANTANDER/0049853438 014 00', 'DEV. DEPOSITO ELECTRONICO', 'Abono por devolucion Sucursal: 859', 'TRANSFERENCIA RECHAZADA']) {
      expect(rx.test(c)).toBe(true);
    }
    for (const c of ['SPEI ENVIADO CITI MEXICO/0036039880 124 018112610087', 'PAGO TRANSFERENCIA SPEI', 'TRASPASO ENTRE CTAS 7744']) {
      expect(rx.test(c)).toBe(false);
    }
  });

  it('la liberación también reconoce el pago partido, y lo ligado guarda las partes', () => {
    expect(SQL_SALIDA_DE_BANCO).toMatch(/\[PGP\.201\] El pago partido[\s\S]*z\.n >= 2/);
    expect(SQL_SALIDAS_LIGADAS).toContain("h.detail -> 'banco' -> 'grupo'");
    expect((SQL_SALIDAS_LIGADAS.match(/\?/g) ?? []).length).toBe(1);
  });
});
