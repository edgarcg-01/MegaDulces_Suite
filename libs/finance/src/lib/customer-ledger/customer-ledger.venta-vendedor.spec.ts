import { CustomerLedgerService, VENTA_VENDEDOR_DIAS } from './customer-ledger.service';

/**
 * `[CXC.52]` La venta de cada vendedor en Cartera (`ventaPorVendedor`): por (sucursal, clave), sumada por día, y
 * sin lo que la sucursal facturó en Kepler antes de su cutover (antes de eso la verdad era Wincaja).
 */
type Fila = { suc: string; vend: string; f: string; total: string };

function trxFalsa(cortes: { kepler_code: string; d: string }[], filas: Fila[]) {
  const llamadas: { sql: string; params: unknown[] }[] = [];
  const raw = async (sql: string, params: unknown[] = []) => {
    llamadas.push({ sql, params });
    return { rows: sql.includes('v_branch_erp_cutover') ? cortes : filas };
  };
  return { trx: { raw } as never, llamadas };
}

const svc = new CustomerLedgerService(null as never, null as never) as unknown as {
  ventaPorVendedor(trx: never, hoy: string): Promise<Map<string, number>>;
};

describe('[CXC.52] venta por vendedor para Cartera', () => {
  it('suma los días de cada (sucursal, clave), al centavo', async () => {
    const { trx } = trxFalsa([{ kepler_code: '06', d: '-infinity' }], [
      { suc: '06', vend: '30003', f: '2026-11-20', total: '1000.10' },
      { suc: '06', vend: '30003', f: '2026-11-21', total: '0.20' },
      { suc: '06', vend: '501', f: '2026-11-21', total: '50' },
    ]);
    const m = await svc.ventaPorVendedor(trx, '2026-11-23');
    expect(m.get('06||30003')).toBe(1000.3);
    expect(m.get('06||501')).toBe(50);
  });

  it('la misma clave en otra sucursal es otra fila (el código solo nombra a otra persona según la plaza)', async () => {
    const { trx } = trxFalsa([{ kepler_code: '01', d: '-infinity' }, { kepler_code: '04', d: '-infinity' }], [
      { suc: '01', vend: '30003', f: '2026-11-20', total: '10' },
      { suc: '04', vend: '30003', f: '2026-11-20', total: '20' },
    ]);
    const m = await svc.ventaPorVendedor(trx, '2026-11-23');
    expect([m.get('01||30003'), m.get('04||30003')]).toEqual([10, 20]);
  });

  it('NEGATIVA — lo facturado antes del cutover de la sucursal, o de una sucursal sin cutover, no cuenta', async () => {
    const { trx } = trxFalsa([{ kepler_code: '00', d: '2026-11-21' }], [
      { suc: '00', vend: '2', f: '2026-11-20', total: '999' }, // antes del cutover
      { suc: '00', vend: '2', f: '2026-11-21', total: '5' }, // el día del cutover sí
      { suc: '09', vend: '1', f: '2026-11-21', total: '7' }, // sin fila de cutover
    ]);
    const m = await svc.ventaPorVendedor(trx, '2026-11-23');
    expect(m.get('00||2')).toBe(5);
    expect(m.has('09||1')).toBe(false);
  });

  it('la ventana: de hoy − 29 a hoy (30 días), sólo venta U-D 8/10/12 no cancelada de la propia sucursal', async () => {
    const { trx, llamadas } = trxFalsa([], []);
    await svc.ventaPorVendedor(trx, '2026-11-23');
    const q = llamadas.find((l) => l.sql.includes('kepler_ods.kdm1'))!;
    expect(VENTA_VENDEDOR_DIAS).toBe(30);
    expect(q.params).toEqual(['2026-11-23', 29, '2026-11-23']);
    for (const pieza of ["h.c2 = 'U' AND h.c3 = 'D'", 'IN (8, 10, 12)', 'btrim(h.c1) = btrim(h.sucursal)', "<> 'C'", 'h.c16']) {
      expect(q.sql).toContain(pieza);
    }
  });
});
