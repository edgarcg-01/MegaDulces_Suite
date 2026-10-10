/**
 * `[MCP.1]` / `[MCP.4]` Pruebas del motor de la Mesa de Control de Preventa.
 *
 * Los casos salen de datos REALES leídos en prod (solo lectura) el 2026-10-08:
 *  · PD-2026-00053 (Yurécuaro, cliente 10070…) contra su ticket 04UD1003-0002097: mismos 13
 *    productos; 17064 cobrado 1.04 contra 1 pedido; 20612 a $5.98 contra $6.72 pedido; 97335 se
 *    cobró 1 de 2. El total del renglón del pedido trae IVA y el del ticket no.
 *  · El cliente `10465` es de la sucursal 01: pedido para la 04 NO puede buscar con esa clave.
 * Cada regla lleva su prueba negativa.
 */
import {
  bloqueoDeLiga,
  claveCliente,
  compararRenglones,
  contarPorEtapa,
  diasEntre,
  etapaDe,
  MAX_REINTENTOS_ENTREGA,
  partesFolio,
  requiereDevolucion,
  resumenLiquidacion,
  semaforo,
} from './presale-control.engine';

describe('etapaDe', () => {
  const base = { status: 'confirmed', wave_stage: null, ligado: false, customer_erp_code: '10182' };

  it('confirmado sin ola = por surtir', () => {
    expect(etapaDe(base)).toBe('por_surtir');
  });
  it('en ola viva = en surtido; listo_embarque = en caja', () => {
    expect(etapaDe({ ...base, wave_stage: 'en_ola' })).toBe('en_surtido');
    expect(etapaDe({ ...base, wave_stage: 'checado' })).toBe('en_surtido');
    expect(etapaDe({ ...base, wave_stage: 'listo_embarque' })).toBe('en_caja');
  });
  it('cliente sin clave de Kepler = esperando alta (aunque no haya ola)', () => {
    expect(etapaDe({ ...base, customer_erp_code: null })).toBe('esperando_alta');
  });
  it('la liga manda sobre la ola: cobrado aunque la ola siga abierta', () => {
    expect(etapaDe({ ...base, wave_stage: 'en_ola', ligado: true })).toBe('cobrado');
  });
  it('entregado de conformidad en la guía = entregado, aunque el pedido siga confirmado', () => {
    expect(etapaDe({ ...base, ligado: true, en_guia_impresa: true, entregado_en_guia: true })).toBe('entregado');
  });
  it('negativa: un cancelado con entrega registrada sigue siendo cancelado', () => {
    expect(etapaDe({ ...base, status: 'cancelled', entregado_en_guia: true })).toBe('cancelado');
  });
  it('en una guía impresa = en ruta, aunque ya tenga documento ligado', () => {
    expect(etapaDe({ ...base, ligado: true, en_guia_impresa: true })).toBe('en_ruta');
    expect(etapaDe({ ...base, en_guia_impresa: false, ligado: true })).toBe('cobrado');
  });
  it('negativa: un pedido entregado o cancelado NO vuelve a en ruta por seguir en la guía', () => {
    expect(etapaDe({ ...base, status: 'fulfilled', en_guia_impresa: true })).toBe('entregado');
    expect(etapaDe({ ...base, status: 'cancelled', en_guia_impresa: true })).toBe('cancelado');
  });
  it('lo cerrado manda sobre todo (negativa: un cancelado ligado NO sale como cobrado)', () => {
    expect(etapaDe({ ...base, status: 'cancelled', ligado: true })).toBe('cancelado');
    expect(etapaDe({ ...base, status: 'fulfilled', customer_erp_code: null })).toBe('entregado');
  });
});

describe('semaforo', () => {
  it('cuenta días por calendario, no por la zona del servidor', () => {
    expect(diasEntre('2026-09-30', '2026-10-08')).toBe(8);
    expect(diasEntre('2026-10-08', '2026-10-08')).toBe(0);
  });
  it('vencido / hoy / a tiempo', () => {
    expect(semaforo('2026-10-01', '2026-10-08', 'por_surtir')).toEqual({ due: 'vencido', days_late: 7 });
    expect(semaforo('2026-10-08', '2026-10-08', 'en_caja')).toEqual({ due: 'hoy', days_late: 0 });
    expect(semaforo('2026-10-09', '2026-10-08', 'en_surtido')).toEqual({ due: 'a_tiempo', days_late: -1 });
  });
  it('cobrado SÍ lleva semáforo: pagado no es entregado', () => {
    expect(semaforo('2026-10-01', '2026-10-08', 'cobrado').due).toBe('vencido');
  });
  it('negativa: entregado y cancelado no llevan semáforo aunque la fecha ya pasó', () => {
    expect(semaforo('2026-06-20', '2026-10-08', 'entregado')).toEqual({ due: null, days_late: null });
    expect(semaforo('2026-06-20', '2026-10-08', 'cancelado')).toEqual({ due: null, days_late: null });
  });
});

describe('bloqueoDeLiga', () => {
  const ok = { customer_erp_code: '10182', customer_erp_branch: '04', branch: '04', branch_has_documents: true };

  it('cliente de la misma sucursal, sucursal con documentos = se puede buscar', () => {
    expect(bloqueoDeLiga(ok)).toBeNull();
  });
  it('cliente sin clave (alta en campo) no se puede buscar', () => {
    expect(bloqueoDeLiga({ ...ok, customer_erp_code: null })).toBe('cliente_sin_clave');
    expect(bloqueoDeLiga({ ...ok, customer_erp_code: '000' })).toBe('cliente_sin_clave');
  });
  it('negativa: la clave de OTRA sucursal no se usa (traería los tickets de otra persona)', () => {
    expect(bloqueoDeLiga({ ...ok, customer_erp_code: '10465', customer_erp_branch: '01' })).toBe('cliente_de_otra_sucursal');
  });
  it('sucursal sin documentos de Kepler en el ODS (Morelia Madero) se declara', () => {
    expect(bloqueoDeLiga({ ...ok, branch: '32', branch_has_documents: false })).toBe('sucursal_sin_documentos');
    expect(bloqueoDeLiga({ ...ok, branch: null })).toBe('sucursal_sin_documentos');
  });
  it('normaliza ceros a la izquierda', () => {
    expect(claveCliente('010182')).toBe('10182');
    expect(claveCliente('  10182 ')).toBe('10182');
  });
});

describe('compararRenglones (PD-2026-00053 contra 04UD1003-0002097)', () => {
  const P = (sku: string, quantity: number, unit_price: number) =>
    ({ product_id: `p${sku}`, sku, description: null, quantity, unit_price });
  const D = (sku: string, cantidad: number, precio_unitario: number, unidad = 'PZA') =>
    ({ product_id: `p${sku}`, sku, description: null, cantidad, unidad, precio_unitario });

  const out = compararRenglones(
    [P('20606', 6, 17.99), P('17064', 1, 65.1), P('20612', 16, 6.72), P('97335', 2, 152.29), P('11111', 1, 10)],
    [D('20606', 6, 17.99), D('17064', 1.04, 65.1, 'KG'), D('20612', 16, 5.98), D('97335', 1, 152.29), D('22222', 3, 4)],
  );
  const por = (sku: string) => out.find((r) => r.sku === sku)!;

  it('igual cuando coinciden cantidad y precio', () => {
    expect(por('20606').match).toBe('igual');
  });
  it('detecta cantidad (granel 1.04 kg y 1 de 2) y precio (5.98 contra 6.72)', () => {
    expect(por('17064').match).toBe('cantidad');
    expect(por('17064').charged_unit).toBe('KG');
    expect(por('97335').match).toBe('cantidad');
    expect(por('20612').match).toBe('precio');
  });
  it('renglones de un solo lado se declaran, no se esconden', () => {
    expect(por('11111').match).toBe('solo_pedido');
    expect(por('11111').charged_qty).toBeNull();
    expect(por('22222').match).toBe('solo_documento');
    expect(por('22222').ordered_qty).toBeNull();
  });
  it('negativa: comparar importes con IVA contra importes sin IVA daría diferencia falsa; aquí no', () => {
    // 65.10 × 1.16 = 75.52 (pedido con IVA) contra 65.10 (ticket sin IVA): el precio unitario es el mismo.
    expect(por('17064').ordered_price).toBe(65.1);
    expect(por('17064').charged_price).toBe(65.1);
  });
  it('suma renglones repetidos del mismo producto con precio ponderado', () => {
    const r = compararRenglones([P('1', 2, 10), P('1', 2, 20)], [D('1', 4, 15)]);
    expect(r).toHaveLength(1);
    expect(r[0].ordered_qty).toBe(4);
    expect(r[0].ordered_price).toBe(15);
    expect(r[0].match).toBe('igual');
  });
  it('parea por SKU cuando el renglón del documento no trae product_id', () => {
    const r = compararRenglones([P('20606', 6, 17.99)], [{ ...D('20606', 6, 17.99), product_id: null }]);
    expect(r).toHaveLength(1);
    expect(r[0].match).toBe('igual');
  });
});

describe('contarPorEtapa y reglas', () => {
  it('trae todas las etapas, en cero las vacías', () => {
    const c = contarPorEtapa(['por_surtir', 'por_surtir', 'cobrado']);
    expect(c.por_surtir).toBe(2);
    expect(c.cobrado).toBe(1);
    expect(c.esperando_alta).toBe(0);
    expect(Object.keys(c)).toHaveLength(8);
  });
  it('la regla de reintentos es la que pidió Francisco: 2', () => {
    expect(MAX_REINTENTOS_ENTREGA).toBe(2);
  });
});

describe('partesFolio', () => {
  it('parte el folio digital en sucursal, prefijo y folio', () => {
    expect(partesFolio('04UD1003-0002097')).toEqual({ sucursal: '04', doc_prefix: 'UD1003', folio: '0002097' });
  });
  it('negativa: lo que no tiene la forma no se adivina', () => {
    expect(partesFolio('99UD9999-CANDADO')).toBeNull();
    expect(partesFolio('UD1003-0002097')).toBeNull();
    expect(partesFolio('')).toBeNull();
  });
});

describe('[MCP.7] reintentos y liquidación', () => {
  it('sale una vez y puede salir 2 más: al 3er intento fallido va a devolución', () => {
    expect(requiereDevolucion(0)).toBe(false);
    expect(requiereDevolucion(2)).toBe(false);
    expect(requiereDevolucion(3)).toBe(true);
  });
  it('sólo lo entregado se espera; efectivo y transferencia por separado', () => {
    const r = resumenLiquidacion([
      { status: 'entregado', document_total: 1580.5, cash_amount: 1080.5, transfer_amount: 500 },
      { status: 'entregado', document_total: 742, cash_amount: 700, transfer_amount: 0, delivery_outcome: 'con_diferencia' },
      { status: 'no_entregado', document_total: 315.25, cash_amount: null, transfer_amount: null },
      { status: 'regreso', document_total: 100, cash_amount: null, transfer_amount: null },
    ]);
    expect(r).toEqual({
      entregados: 2, no_entregados: 2, pendientes: 0, documents_total: 2322.5,
      documentos_sin_total: 0, declared_cash: 1780.5, declared_transfer: 500, por_cobrar: 42, sin_explicar: 0,
    });
  });
  it('negativa: un pedido aún en camino se cuenta como pendiente y no suma', () => {
    const r = resumenLiquidacion([{ status: 'cargado', document_total: 500, cash_amount: null, transfer_amount: null }]);
    expect(r.pendientes).toBe(1);
    expect(r.documents_total).toBe(0);
  });
  it('un documento sin total en el ODS se declara, no se suma como cero escondido', () => {
    const r = resumenLiquidacion([{ status: 'entregado', document_total: null, cash_amount: 50, transfer_amount: 0 }]);
    expect(r.documentos_sin_total).toBe(1);
    expect(r.declared_cash).toBe(50);
  });
});

describe('[MCP.7] lo que Kepler cobró y nadie declaró', () => {
  it('negativa: un pedido "completo" con cobro declarado en 0 queda SIN EXPLICAR (no se cierra como cuadrado)', () => {
    const r = resumenLiquidacion([{ status: 'entregado', document_total: 5000, cash_amount: 0, transfer_amount: 0, delivery_outcome: 'completo' }]);
    expect(r.por_cobrar).toBe(5000);
    expect(r.sin_explicar).toBe(5000);
  });
  it('un "con diferencia" ya trae su nota: cuenta en por cobrar, no en sin explicar', () => {
    const r = resumenLiquidacion([{ status: 'entregado', document_total: 500, cash_amount: 450, transfer_amount: 0, delivery_outcome: 'con_diferencia' }]);
    expect(r.por_cobrar).toBe(50);
    expect(r.sin_explicar).toBe(0);
  });
  it('documento sin total: no entra al cuadre contra el documento', () => {
    const r = resumenLiquidacion([{ status: 'entregado', document_total: null, cash_amount: 80, transfer_amount: 0, delivery_outcome: 'completo' }]);
    expect(r.por_cobrar).toBe(0);
    expect(r.sin_explicar).toBe(0);
  });
});
