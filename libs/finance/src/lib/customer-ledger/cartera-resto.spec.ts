import { CustomerLedgerService, PARTIDA_RESTO_SQL } from './customer-ledger.service';

/**
 * `[GP.R.1]` La cartera dice cuánto de lo vivo es resto de centavos SIN cambiar `saldo` ni `vencido`.
 * Se ejercita `cartera()` con el SQL simulado (la fila cruda de `agregado()`); la consulta real se midió en
 * prod el 2026-11-20 (17 clientes vencidos sólo por resto, $57.92 en 188 partidas).
 */
type Fila = Record<string, unknown>;

function servicio(clientes: Fila[]) {
  const s = Object.create(CustomerLedgerService.prototype) as CustomerLedgerService;
  const fake = s as unknown as Record<string, unknown>;
  fake['tenantCtx'] = { requireTenantId: () => 't' };
  fake['tk'] = { run: (fn: (trx: unknown) => unknown) => fn({}) };
  fake['fuenteCartera'] = async () => ({ rel: 'x' });
  fake['freshness'] = async () => ({ status: 'unknown' });
  fake['ultimosContactos'] = async () => null;
  fake['opciones'] = () => ({});
  fake['agregado'] = async () => ({ hoy: '2026-11-20', clientes, pago: null, por_vendedor: [], por_zona: [], por_tipo_universo: [] });
  return s;
}

const cli = (code: string, extra: Fila): Fila => ({
  sucursal: '08', cliente_code: code, saldo_cliente: 0, residual: 0, vencido: 0, vencido_resto: 0,
  resto_redondeo: 0, n_restos: 0, n_partidas: 1, n_saldadas: 0, cuenta_kind: 'cliente_final', ...extra,
});

describe('[GP.R.1] cartera: el resto de centavos se dice aparte', () => {
  it('un cliente cuyo único vencido es un resto sale marcado, y su vencido NO cambia', async () => {
    const r = await servicio([
      cli('A', { saldo_cliente: 0.37, residual: 0.37, vencido: 0.37, vencido_resto: 0.37, resto_redondeo: 0.37, n_restos: 1 }),
    ]).cartera({});
    const a = r.clientes[0];
    expect(a.vencido).toBe(0.37);
    expect(a.saldo).toBe(0.37);
    expect(a.solo_resto_vencido).toBe(true);
    expect(r.kpi.resto).toEqual({ monto: 0.37, partidas: 1, clientes_solo_resto_vencido: 1 });
    expect(r.kpi.total_vencido).toBe(0.37);
  });

  it('negativo: con deuda vencida de verdad además del resto, NO es «sólo resto»', async () => {
    const r = await servicio([
      cli('B', { saldo_cliente: 500.37, residual: 500.37, vencido: 500.37, vencido_resto: 0.37, resto_redondeo: 0.37, n_restos: 1 }),
    ]).cartera({});
    expect(r.clientes[0].solo_resto_vencido).toBe(false);
    expect(r.kpi.resto.clientes_solo_resto_vencido).toBe(0);
  });

  it('negativo: sin vencido no hay «moroso por resto» aunque tenga un resto por vencer', async () => {
    const r = await servicio([
      cli('C', { saldo_cliente: 0.2, residual: 0.2, vencido: 0, vencido_resto: 0, resto_redondeo: 0.2, n_restos: 1 }),
    ]).cartera({});
    expect(r.clientes[0].solo_resto_vencido).toBe(false);
    expect(r.kpi.resto.monto).toBe(0.2);
  });

  it('el SQL usa la misma regla que el contrato: tope, ya cobrada y medio centavo', () => {
    expect(PARTIDA_RESTO_SQL).toBe('d.res > 0.005 AND d.res <= 1 AND d.res < d.importe - 0.005');
  });
});
