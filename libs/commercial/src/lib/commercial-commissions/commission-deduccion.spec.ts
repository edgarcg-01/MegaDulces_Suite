import { CommercialCommissionsService } from './commercial-commissions.service';
import { totalesDeCorrida } from './commission-totales.logic';

/**
 * `[RD.91]` — **Una deducción sin cargar no es una deducción de cero.**
 *
 * El defecto, medido en prod el 2026-10-28 sobre Q21 (la primera corrida del motor): sus 11
 * renglones de supervisor quedaron `deduccion_status = 'sin_configurar'`,
 * `commission_beneficiary_config` tiene **0 filas**, y aun así la corrida publicó
 * `total_deduccion = 0.00`, `total_neto = 51,522.93` (igual al bruto) y la compuerta
 * `deduccion_configurada` en **«pasa — todas las deducciones resueltas»**.
 *
 * Dos causas, y esto rompe las dos:
 *  1. La compuerta contaba `sin_configurar` en las LÍNEAS, y el motor la llamaba antes de
 *     copiar ese estado a las líneas del supervisor (que nacen con `null`). Nunca podía avisar.
 *  2. Los totales restaban la deducción `sin_configurar` como 0.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

function linea(route_code: string, beneficiario: 'chofer' | 'supervisor', a_pagar: number) {
  return {
    route_code, beneficiario, motivo_no_pago: null,
    subtotal: 1000, venta: 1100, comision: a_pagar, a_pagar, dias_multifuente: 0,
  };
}

describe('[RD.91] deducción del supervisor', () => {
  const lines = [linea('21', 'chofer', 300), linea('21', 'supervisor', 100)];
  const universo = [{ route_code: '21', comisiona: true }];

  it('con la deducción sin cargar, el neto y la deducción son NULL — no el bruto', () => {
    const t = totalesDeCorrida(lines, universo,
      [{ deduccion: 0, deduccion_status: 'no_aplica' }, { deduccion: 0, deduccion_status: 'sin_configurar' }],
      [], 1, 0);
    expect(t.total_a_pagar).toBe(400);
    expect(t.total_deduccion).toBeNull();
    expect(t.total_neto).toBeNull();
  });

  it('con la deducción cargada, el neto es bruto menos deducción', () => {
    const t = totalesDeCorrida(lines, universo,
      [{ deduccion: 0, deduccion_status: 'no_aplica' }, { deduccion: 25.5, deduccion_status: 'aplicada' }],
      [], 1, 0);
    expect(t.total_deduccion).toBe(25.5);
    expect(t.total_neto).toBe(r2(400 - 25.5));
  });

  // Se llama por el borde, como en commission-inmutable.spec: la compuerta es privada.
  function compuertas(beneficiarios: { beneficiario: string; nombre: string; deduccion_status: string }[]) {
    const tenantCtx = { get: () => ({ userId: 'u1' }), requireTenantId: () => 't1' } as never;
    const tk = { run: async (cb: (t: unknown) => unknown) => cb(null) } as never;
    const svc = new CommercialCommissionsService(tk, tenantCtx) as unknown as {
      compuertas: (...a: unknown[]) => { gate: string; estado: string; detalle: string }[];
    };
    // Las líneas del supervisor tal como el motor las tiene cuando corre la compuerta:
    // `deduccion_status` todavía en null.
    const lineas = [{ beneficiario: 'supervisor', route_code: '21', supervisor_nombre: 'ANA',
      deduccion_status: null, bonos: 0, dias_con_venta: null, dias_esperados: null }];
    const totals = { rutas_con_dato: 1, rutas_sin_dato: 0, dias_multifuente: 0 };
    return svc.compuertas('2026-10-28', '2026-10-21', totals, '2026-10-22', lineas, beneficiarios)
      .find((g) => g.gate === 'deduccion_configurada');
  }

  it('la compuerta AVISA cuando un supervisor no tiene deducción, y lo nombra', () => {
    const g = compuertas([{ beneficiario: 'supervisor', nombre: 'ANA', deduccion_status: 'sin_configurar' }]);
    expect(g?.estado).toBe('advierte');
    expect(g?.detalle).toContain('ANA');
  });

  it('la compuerta pasa cuando todas están cargadas', () => {
    const g = compuertas([{ beneficiario: 'supervisor', nombre: 'ANA', deduccion_status: 'aplicada' }]);
    expect(g?.estado).toBe('pasa');
  });
});
