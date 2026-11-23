import { CustomerLedgerService, rangoVentaVendedor, VENTA_VENDEDOR_DIAS, VENTA_VENDEDOR_MAX_DIAS } from './customer-ledger.service';

/**
 * `[CXC.52]` La venta de cada vendedor en Cartera (`ventaPorVendedor`): por (sucursal, clave), sumada por día, y
 * sin lo que la sucursal facturó en Kepler antes de su cutover (antes de eso la verdad era Wincaja). El periodo lo
 * elige la persona (`rangoVentaVendedor`): por defecto 30 días, y lo mal escrito se rechaza, no cae al default.
 */
type Fila = { suc: string; vend: string; total: string };

function trxFalsa(cortes: { kepler_code: string; d: string }[], filas: Fila[]) {
  const llamadas: { sql: string; params: unknown[] }[] = [];
  const raw = async (sql: string, params: unknown[] = []) => {
    llamadas.push({ sql, params });
    return { rows: sql.includes('v_branch_erp_cutover') ? cortes : filas };
  };
  return { trx: { raw } as never, llamadas };
}

const svc = new CustomerLedgerService(null as never, null as never) as unknown as {
  ventaPorVendedor(trx: never, desde: string, hasta: string): Promise<Map<string, number>>;
};

describe('[CXC.52] venta por vendedor para Cartera', () => {
  it('una fila por (sucursal, clave), al centavo; la misma clave en otra sucursal es otra fila', async () => {
    const { trx } = trxFalsa([{ kepler_code: '01', d: '-infinity' }, { kepler_code: '04', d: '-infinity' }], [
      { suc: '01', vend: '30003', total: '1000.104' },
      { suc: '04', vend: '30003', total: '20' },
    ]);
    const m = await svc.ventaPorVendedor(trx, '2026-10-25', '2026-11-23');
    expect([m.get('01||30003'), m.get('04||30003')]).toEqual([1000.1, 20]);
  });

  it('el cutover de cada sucursal entra al SQL; la sucursal sin cutover cae en ELSE NULL (no cuenta)', async () => {
    const { trx, llamadas } = trxFalsa([{ kepler_code: '00', d: '2026-09-30' }, { kepler_code: '03', d: '-infinity' }], []);
    await svc.ventaPorVendedor(trx, '2026-08-24', '2026-11-23');
    const q = llamadas.find((l) => l.sql.includes('kepler_ods.kdm1'))!;
    expect(q.sql).toContain('h.c9::date >= CASE btrim(h.sucursal) WHEN ? THEN ?::date WHEN ? THEN ?::date ELSE NULL END');
    expect(q.params).toEqual(['2026-08-24', '2026-11-23', '00', '2026-09-30', '03', '-infinity']);
  });

  it('NEGATIVA — sin ninguna fila de cutover no se consulta kdm1 ni se inventa venta', async () => {
    const { trx, llamadas } = trxFalsa([], [{ suc: '06', vend: '1', total: '999' }]);
    const m = await svc.ventaPorVendedor(trx, '2026-10-25', '2026-11-23');
    expect(m.size).toBe(0);
    expect(llamadas.some((l) => l.sql.includes('kepler_ods.kdm1'))).toBe(false);
  });

  it('sólo venta U-D 8/10/12 no cancelada de la propia sucursal, por su total c16', async () => {
    const { trx, llamadas } = trxFalsa([{ kepler_code: '06', d: '-infinity' }], []);
    await svc.ventaPorVendedor(trx, '2026-08-24', '2026-11-23');
    const q = llamadas.find((l) => l.sql.includes('kepler_ods.kdm1'))!;
    for (const pieza of ["h.c2 = 'U' AND h.c3 = 'D'", 'IN (8, 10, 12)', 'btrim(h.c1) = btrim(h.sucursal)', "<> 'C'", 'h.c16', 'GROUP BY 1, 2']) {
      expect(q.sql).toContain(pieza);
    }
  });

  describe('el periodo', () => {
    it('sin fechas: los últimos 30 días hasta hoy', () => {
      expect(VENTA_VENDEDOR_DIAS).toBe(30);
      expect(rangoVentaVendedor('2026-11-23')).toEqual({ desde: '2026-10-25', hasta: '2026-11-23' });
    });

    it('un mes, tres meses o un rango, tal como se pide', () => {
      expect(rangoVentaVendedor('2026-11-23', '2026-10-01', '2026-10-31')).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
      expect(rangoVentaVendedor('2026-11-23', '2026-08-24', '2026-11-23')).toEqual({ desde: '2026-08-24', hasta: '2026-11-23' });
      // Con sólo «hasta», 30 días antes de esa fecha.
      expect(rangoVentaVendedor('2026-11-23', undefined, '2026-10-31')).toEqual({ desde: '2026-10-02', hasta: '2026-10-31' });
    });

    it('NEGATIVA — lo mal escrito, al revés, posterior a hoy o de más de un año se rechaza (no cae al default)', () => {
      for (const malo of ['2026-13-01', '2026-02-30', 'ayer', '01/11/2026']) {
        expect(() => rangoVentaVendedor('2026-11-23', malo, '2026-11-23')).toThrow(/date_from inválido/);
      }
      expect(() => rangoVentaVendedor('2026-11-23', '2026-11-10', '2026-11-01')).toThrow(/posterior a date_to/);
      expect(() => rangoVentaVendedor('2026-11-23', '2026-11-01', '2026-11-24')).toThrow(/posterior a hoy/);
      expect(VENTA_VENDEDOR_MAX_DIAS).toBe(366);
      expect(rangoVentaVendedor('2026-11-23', '2025-11-23', '2026-11-23').desde).toBe('2025-11-23'); // 366 días: entra
      expect(() => rangoVentaVendedor('2026-11-23', '2025-11-22', '2026-11-23')).toThrow(/máximo es 366/);
    });
  });
});
