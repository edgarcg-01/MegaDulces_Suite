import { CustomerLedgerService, RESUMEN_PERIODO_DIAS } from './customer-ledger.service';

/**
 * `[CXC.53]` El Resumen de Cartera sigue al periodo elegido (Edgar, 2026-11-23: «que todo el resumen se haga
 * dinámico»): la venta, el DSO y el comportamiento de pago. Lo demás (saldo, vencido, proyección) es foto de HOY.
 */
type Fila = Record<string, unknown>;

function servicio(clientes: Fila[]) {
  const s = Object.create(CustomerLedgerService.prototype) as CustomerLedgerService;
  const fake = s as unknown as Record<string, unknown>;
  const llamadas: unknown[][] = [];
  fake['tenantCtx'] = { requireTenantId: () => 't' };
  fake['tk'] = { run: (fn: (trx: unknown) => unknown) => fn({}) };
  fake['fuenteCartera'] = async () => ({ rel: 'x' });
  fake['hoy'] = async () => '2026-11-23';
  fake['freshness'] = async () => ({ status: 'unknown' });
  fake['ultimosContactos'] = async () => null;
  fake['opciones'] = () => ({});
  fake['agregado'] = async (...args: unknown[]) => {
    llamadas.push(args);
    return { hoy: '2026-11-23', clientes, pago: null, por_vendedor: [], por_zona: [], por_tipo_universo: [] };
  };
  return { s, llamadas };
}

const cli = (code: string, saldo: number, ventas: number): Fila => ({
  sucursal: '06', cliente_code: code, saldo_cliente: saldo, residual: saldo, vencido: 0, vencido_resto: 0,
  resto_redondeo: 0, n_restos: 0, n_partidas: 1, n_saldadas: 0, cuenta_kind: 'cliente_final', ventas_periodo: ventas,
});

describe('[CXC.53] el Resumen de Cartera sigue al periodo', () => {
  it('sin periodo: los últimos 90 días, y el DSO divide entre esos 90', async () => {
    const { s, llamadas } = servicio([cli('A', 900, 2700)]);
    const r = await s.cartera({});
    expect(RESUMEN_PERIODO_DIAS).toBe(90);
    expect(llamadas[0][4]).toEqual({ desde: '2026-08-26', hasta: '2026-11-23' });
    expect(r.resumen.periodo).toEqual({ desde: '2026-08-26', hasta: '2026-11-23', dias: 90 });
    expect(r.resumen.ventas_periodo).toBe(2700);
    expect(r.resumen.dso).toBe(30); // 900 / (2,700 / 90)
  });

  it('con periodo: la venta y el DSO son los de ESE periodo (un mes de 30 días)', async () => {
    const { s, llamadas } = servicio([cli('A', 900, 1800), cli('B', 0, 900)]);
    const r = await s.cartera({ period_from: '2026-10-01', period_to: '2026-10-30' });
    expect(llamadas[0][4]).toEqual({ desde: '2026-10-01', hasta: '2026-10-30' });
    expect(r.resumen.periodo.dias).toBe(30);
    // La venta del cliente que ya no debe también cuenta: el saldo en cero no la borra.
    expect(r.resumen.ventas_periodo).toBe(2700);
    expect(r.resumen.dso).toBe(10); // 900 / (2,700 / 30)
  });

  it('NEGATIVA — un periodo mal escrito o al revés se rechaza ANTES de tocar la pirámide', async () => {
    const { s, llamadas } = servicio([]);
    await expect(s.cartera({ period_from: "2026-10-01' OR 1=1 --", period_to: '2026-10-30' })).rejects.toThrow(/inválido/);
    await expect(s.cartera({ period_from: '2026-10-30', period_to: '2026-10-01' })).rejects.toThrow(/posterior a/);
    expect(llamadas).toHaveLength(0);
  });
});
