import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { AutoabastoPedidoService } from './autoabasto-pedido.service';

/**
 * `[PQ.138]` · ADR-127 — **El pedido a otra sucursal sale al ERP en el acto; la compra, no.**
 *
 * Las dos reglas que esta fase convierte en código, y que ninguna compuerta anterior cubría:
 *
 *  1. **Quién sale.** Sólo los grupos de origen SUCURSAL se sueltan a Kepler. La compra a
 *     proveedor compromete dinero con un tercero y sigue su camino de siempre — bandeja de
 *     Compras, aprobación, y su `X-A-30` al aprobarla. Mezclarlas escribiría en el ERP una compra
 *     que nadie aprobó.
 *  2. **Nunca lanza, y nunca miente.** Cuando el empuje corre, la requisición ya está escrita y
 *     commiteada: un error hacia arriba le diría a la sucursal que falló algo que sí se guardó, y
 *     un ERP caído dejaría a las nueve sin poder pedir. Cada caso devuelve `no_salio` **con
 *     motivo**; ninguno devuelve éxito sin folio.
 *
 * ⚠️ Lo que NO se prueba acá: que Kepler acepte el documento. Eso es el ensayo contra el servidor
 * vivo (`kepler-requisition-sink.ensayo.spec.ts`), que corre desde `md`.
 */

/** El servicio sin pasar por Nest: se le cuelgan sólo las piezas que el método toca. */
const motorCon = (piezas: Partial<Record<string, unknown>>): CommercialReplenishmentService => {
  const s = Object.create(CommercialReplenishmentService.prototype) as Record<string, unknown>;
  s['logger'] = { warn: () => undefined, log: () => undefined };
  return Object.assign(s, piezas) as unknown as CommercialReplenishmentService;
};

describe('[PQ.138] soltarPedidoDeSucursal — aprobar y empujar, sin lanzar nunca', () => {
  it('el camino feliz devuelve el folio del documento, con su sucursal', async () => {
    const motor = motorCon({
      setEstado: async () => ({ id: 'a', estado: 'approved' }),
      keplerSink: {},
      pushToKepler: async () => ({ ya_estaba: false, kepler: { sucursal: '08', folio: '0001576' } }),
    });
    const r = await motor.soltarPedidoDeSucursal(['a']);
    expect(r.get('a')).toEqual({ estado: 'entregada', sucursal: '08', folio: '0001576' });
  });

  it('un pedido que YA tenía documento se distingue de uno nuevo', async () => {
    const motor = motorCon({
      setEstado: async () => ({ id: 'a', estado: 'approved' }),
      keplerSink: {},
      pushToKepler: async () => ({ ya_estaba: true, kepler: { sucursal: '08', folio: '0001576' } }),
    });
    expect((await motor.soltarPedidoDeSucursal(['a'])).get('a')).toEqual({
      estado: 'ya_estaba', sucursal: '08', folio: '0001576',
    });
  });

  it('⛔ si el ERP acepta pero NO devuelve folio, no se canta éxito', async () => {
    const motor = motorCon({
      setEstado: async () => ({ id: 'a', estado: 'approved' }),
      keplerSink: {},
      pushToKepler: async () => ({ ya_estaba: false }),
    });
    const r = await motor.soltarPedidoDeSucursal(['a']) as Map<string, { estado: string; motivo?: string }>;
    expect(r.get('a')?.estado).toBe('no_salio');
    expect(r.get('a')?.motivo).toContain('no devolvió folio');
  });

  /** El caso REAL de prod: el interruptor de la sucursal está apagado y `pushToKepler` tira. */
  it('⛔ el interruptor apagado deja el motivo exacto, y NO tumba el envío', async () => {
    const motor = motorCon({
      setEstado: async () => ({ id: 'a', estado: 'approved' }),
      keplerSink: {},
      pushToKepler: async () => { throw new Error('La escritura a Kepler de la sucursal 08 (traspaso) está apagada desde la Suite'); },
    });
    const r = await motor.soltarPedidoDeSucursal(['a']) as Map<string, { estado: string; motivo?: string }>;
    expect(r.get('a')?.estado).toBe('no_salio');
    expect(r.get('a')?.motivo).toContain('apagada desde la Suite');
  });

  it('⛔ si no se pudo aprobar, se dice eso y NO se empuja', async () => {
    let empujo = false;
    const motor = motorCon({
      setEstado: async () => { throw new Error("La requisición no está en estado 'pending_approval'"); },
      keplerSink: {},
      pushToKepler: async () => { empujo = true; return { ya_estaba: false, kepler: { sucursal: '08', folio: 'x' } }; },
    });
    const r = await motor.soltarPedidoDeSucursal(['a']) as Map<string, { estado: string; motivo?: string }>;
    expect(r.get('a')?.estado).toBe('no_salio');
    expect(r.get('a')?.motivo).toContain('no se pudo aprobar');
    expect(empujo).toBe(false);
  });

  it('⛔ sin sink ligado se dice que la escritura no está habilitada: no se simula que salió', async () => {
    const motor = motorCon({ setEstado: async () => ({ id: 'a', estado: 'approved' }), keplerSink: undefined });
    const r = await motor.soltarPedidoDeSucursal(['a']) as Map<string, { estado: string; motivo?: string }>;
    expect(r.get('a')?.estado).toBe('no_salio');
    expect(r.get('a')?.motivo).toContain('no está habilitada');
  });

  /**
   * ⛔ EN SERIE. Dos documentos a la vez en la misma sucursal pelean por el contador de folios de
   * Kepler. Si alguien cambia el bucle por un `Promise.all`, esta se pone roja.
   */
  it('⛔ los empuja de UNO en UNO, nunca en paralelo', async () => {
    let dentro = 0, maximo = 0;
    const motor = motorCon({
      setEstado: async () => ({ id: 'x', estado: 'approved' }),
      keplerSink: {},
      pushToKepler: async () => {
        dentro++; maximo = Math.max(maximo, dentro);
        await new Promise((ok) => setTimeout(ok, 5));
        dentro--;
        return { ya_estaba: false, kepler: { sucursal: '08', folio: '1' } };
      },
    });
    await motor.soltarPedidoDeSucursal(['a', 'b', 'c']);
    expect(maximo).toBe(1);
  });

  it('una lista vacía no toca el ERP', async () => {
    const motor = motorCon({ pushToKepler: async () => { throw new Error('no debió llamarse'); } });
    expect((await motor.soltarPedidoDeSucursal([])).size).toBe(0);
  });
});

describe('[PQ.138] enviar(): sale al ERP el pedido a otra sucursal, NO la compra a proveedor', () => {
  /** El servidor filtra por UUID antes de mirar nada: los ids de prueba tienen que serlo. */
  const P1 = '11111111-1111-1111-1111-111111111111';
  const P2 = '22222222-2222-2222-2222-222222222222';

  const linea = (id: string, tipo: 'matriz' | 'proveedor', clave: string) => ({
    linea: {
      product_id: id, estado: 'falta', surte: { tipo, clave },
      a_pedir: { cantidad: 2, cantidad_base: 24 }, ajuste: null,
    },
    fila: {}, cf: 12, efectivo_base: 24,
  });

  /** El servicio con las piezas mínimas: lo que se mide es a QUIÉN se suelta, no cómo se arma. */
  const armar = (renglones: unknown[], soltados: string[][]) => {
    const svc = Object.create(AutoabastoPedidoService.prototype) as Record<string, unknown>;
    svc['logger'] = { warn: () => undefined };
    svc['tenantCtx'] = { requireTenantId: () => 't', get: () => ({ userId: null, username: null }) };
    svc['armarAlmacen'] = async () => ({ renglones });
    svc['borradorDe'] = async () => 'ped-1';
    svc['huella'] = async () => undefined;
    // Un `trx` de mentira: encadenable y vacío. Lo que se mide es a quién se suelta, no el SQL.
    const qb = (filas: unknown[]): Record<string, unknown> => {
      const b = Promise.resolve(filas) as unknown as Record<string, unknown>;
      for (const m of ['where', 'whereIn', 'whereNull', 'select', 'first', 'insert', 'update']) b[m] = () => b;
      return b;
    };
    // El almacén 08 (la matriz) existe: sin esto el grupo caería en «no se encontró su matriz».
    const trx = Object.assign((tabla: string) => qb(tabla === 'commercial.warehouses' ? [{ id: 'w08', code: '08' }] : []),
      { raw: async () => ({ rows: [] }) });
    svc['tk'] = { run: async (fn: (t: unknown) => Promise<unknown>) => fn(trx) };
    svc['motor'] = {
      crearRequisicionesDeSucursal: async (_w: string, dtos: Array<{ source_type: string }>) => ({
        creadas: dtos.map((_d, i) => ({ id: `req-${i}`, folio: `RQ-${i}`, indice: i, renglones: 1, total_units: 2 })),
        ya_pedidos: [],
      }),
      soltarPedidoDeSucursal: async (ids: string[]) => {
        soltados.push(ids);
        return new Map(ids.map((id) => [id, { estado: 'entregada', sucursal: '08', folio: '0001576' }]));
      },
    };
    return svc as unknown as AutoabastoPedidoService;
  };

  const almacen = { id: 'w1', code: '07', name: 'Morelia Madero' };

  it('el pedido a la matriz sale al ERP y la respuesta trae su folio de Kepler', async () => {
    const soltados: string[][] = [];
    const svc = armar([linea(P1, 'matriz', '08')], soltados);
    const r = await svc.enviar(almacen, 'almacen', { warehouse_id: 'w1', product_ids: [P1] });
    expect(soltados).toEqual([['req-0']]);
    expect(r.requisiciones[0].kepler).toEqual({ estado: 'entregada', sucursal: '08', folio: '0001576' });
  });

  /** ⛔ LA REGLA DE ADR-127: la compra a proveedor NO se escribe sola en el ERP. */
  it('⛔ la compra a proveedor NO se suelta, y su requisición no trae resultado de Kepler', async () => {
    const soltados: string[][] = [];
    const svc = armar([linea(P1, 'proveedor', 'prov-1')], soltados);
    const r = await svc.enviar(almacen, 'almacen', { warehouse_id: 'w1', product_ids: [P1] });
    expect(soltados).toEqual([]);
    expect(r.requisiciones[0].kepler).toBeUndefined();
  });

  it('con las dos juntas, sale sólo la de sucursal', async () => {
    const soltados: string[][] = [];
    const svc = armar([linea(P1, 'matriz', '08'), linea(P2, 'proveedor', 'prov-1')], soltados);
    const r = await svc.enviar(almacen, 'almacen', { warehouse_id: 'w1', product_ids: [P1, P2] });
    expect(soltados).toHaveLength(1);
    expect(soltados[0]).toHaveLength(1);
    const conKepler = r.requisiciones.filter((x) => x.kepler);
    expect(conKepler).toHaveLength(1);
    expect(conKepler[0].surte.tipo).toBe('matriz');
  });
});
