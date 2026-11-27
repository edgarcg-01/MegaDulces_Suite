// Sin `import ... from 'vitest'`: la config de este proyecto usa `globals: true`.
import { TiendaPedidoService } from './tienda-pedido.service';
import type { PedidoTienda } from './pedido-tienda-a-cotizacion';

/**
 * `[COT.7.50]` — lo que este servicio tiene que garantizar, con dobles.
 *
 * ⚠️ **NO MEDIDO acá:** que el INSERT real entre. Un endpoint que escribe no está probado hasta
 * que una prueba lo ejerció contra una base real con el payload de la pantalla (regla 13 del
 * proyecto). Esto prueba la decisión, no la escritura.
 */

/** Escalera como la devuelve `QuotePricingService.ladders`. */
const escalera = (base: string, pack?: string, box?: string) => ({
  name: null,
  unit_base: base,
  rungs: {
    base: { rung: 'base', label: base, price: 10, size: 1, volume: null },
    ...(pack ? { pack: { rung: 'pack', label: pack, price: 100, size: 10, volume: null } } : {}),
    ...(box ? { box: { rung: 'box', label: box, price: 1800, size: 180, volume: null } } : {}),
  },
});

const pedido = (p: Partial<PedidoTienda> = {}): PedidoTienda => ({
  numero: '11222',
  pago: 'PAID',
  estado: 'APPROVED',
  comprador: 'Comprador De Prueba',
  renglones: [{ sku: '95612', cantidad: 18, presentacion: 'Paquete', precio_tienda: 40.3, nombre: null }],
  ...p,
});

function armar(opciones: {
  previo?: { id: string; code: string; kepler_folio: string | null } | null;
  escaleras?: Map<string, unknown>;
  enviarFalla?: string;
  /** El libro revienta (base caída, permiso faltante): el pedido igual se tiene que contestar. */
  libroFalla?: string;
} = {}) {
  const llamadas = {
    create: [] as unknown[],
    enviar: [] as string[],
    /** Lo que se escribió en `commercial.store_orders`: `{ tabla, fila, merge }`. */
    anotado: [] as { tabla: string; fila: Record<string, unknown>; merge?: Record<string, unknown> }[],
  };
  const fila = opciones.previo ?? undefined;
  // knex de mentira, explícito: cada método de la cadena devuelve el constructor,
  // y `first()` resuelve la fila (o `undefined` si no hay pedido previo).
  const constructor: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['select', 'where', 'andWhere', 'whereNull', 'orderBy']) {
    constructor[m] = () => constructor;
  }
  constructor['first'] = async () => fila;
  let tabla = '';
  constructor['insert'] = (f: unknown) => {
    if (opciones.libroFalla) throw new Error(opciones.libroFalla);
    const anotacion = { tabla, fila: f as Record<string, unknown> };
    llamadas.anotado.push(anotacion);
    return {
      onConflict: () => ({
        merge: async (upd: unknown) => {
          anotacion.merge = upd as Record<string, unknown>;
        },
      }),
    };
  };
  const knex = Object.assign(
    (t: string) => {
      tabla = t;
      return constructor;
    },
    { raw: (sql: string) => ({ __raw: sql }), fn: { now: () => ({ __raw: 'now()' }) } },
  ) as unknown;
  const tk = { run: async (fn: (k: unknown) => unknown) => await fn(knex) };
  const svc = new TiendaPedidoService(
    tk as never,
    { requireTenantId: () => 't1', get: () => ({ userId: 'u1' }) } as never,
    {
      create: async (dto: unknown) => {
        llamadas.create.push(dto);
        return { id: 'q-1', code: 'COT-2026-99999' };
      },
    } as never,
    { ladders: async () => opciones.escaleras ?? new Map([['95612', escalera('PZA', 'PAQ', 'CJA')]]) } as never,
    {
      enviar: async (id: string) => {
        llamadas.enviar.push(id);
        if (opciones.enviarFalla) throw new Error(opciones.enviarFalla);
        return { ya_estaba: false, kepler: { sucursal: '01', folio: '0004360' } };
      },
    } as never,
  );
  return { svc, llamadas };
}

describe('[COT.7.50] el pedido de la tienda entra por la puerta de siempre', () => {
  it('crea la cotización contra ONLINE / 01 y la manda a Kepler', async () => {
    const { svc, llamadas } = armar();
    const r = await svc.registrar(pedido());
    expect(r.estado).toBe('creado');
    expect(r.kepler_folio).toBe('0004360');
    const dto = llamadas.create[0] as Record<string, unknown>;
    expect(dto['erp_customer_code']).toBe('ONLINE');
    expect(dto['source_branch']).toBe('01');
    expect(dto['origin']).toBe('telemarketing');
    expect(String(dto['order_notes'])).toContain('PEDIDO PAGINA WEB #11222');
    expect(llamadas.enviar).toEqual(['q-1']);
  });

  it('el peldaño sale de la escalera del SKU, no de una tabla inventada acá', async () => {
    const { svc, llamadas } = armar();
    await svc.registrar(pedido());
    const dto = llamadas.create[0] as { lines: { sku: string; quantity: number; rung: string }[] };
    expect(dto.lines).toEqual([{ sku: '95612', quantity: 18, rung: 'pack' }]);
  });

  it('un SKU de unidad única cae en `base`: no se adivina un intermedio', async () => {
    const { svc, llamadas } = armar({ escaleras: new Map([['17064', escalera('KG')]]) });
    await svc.registrar(
      pedido({ renglones: [{ sku: '17064', cantidad: 3, presentacion: 'BOLSA ROLLO ALTA 20X30', precio_tienda: 63.86, nombre: null }] }),
    );
    const dto = llamadas.create[0] as { lines: { rung: string }[] };
    expect(dto.lines[0].rung).toBe('base');
  });

  describe('⛔⛔ idempotencia: un webhook se reintenta', () => {
    it('si el pedido ya entró, NO crea ni manda nada', async () => {
      const { svc, llamadas } = armar({ previo: { id: 'q-0', code: 'COT-2026-00828', kepler_folio: '0004359' } });
      const r = await svc.registrar(pedido());
      expect(r.estado).toBe('ya_estaba');
      expect(r.quote_code).toBe('COT-2026-00828');
      expect(r.kepler_folio).toBe('0004359');
      expect(llamadas.create).toHaveLength(0);
      expect(llamadas.enviar).toHaveLength(0);
    });

    it('la marca que busca es el canal más el número, exacta', () => {
      expect(TiendaPedidoService.marcaDe('11222')).toBe('PEDIDO PAGINA WEB #11222');
    });
  });

  describe('⛔ lo que no se puede armar se RECHAZA, y no se crea nada', () => {
    const rechaza = async (p: Partial<PedidoTienda>, texto: RegExp) => {
      const { svc, llamadas } = armar();
      const r = await svc.registrar(pedido(p));
      expect(r.estado).toBe('rechazado');
      expect(String(r.motivo)).toMatch(texto);
      expect(llamadas.create).toHaveLength(0);
      expect(llamadas.enviar).toHaveLength(0);
    };

    it('sin pagar', () => rechaza({ pago: 'NOT_PAID' }, /no está pagado/));
    it('cancelado', () => rechaza({ estado: 'CANCELED' }, /cancelado/));
    it('un SKU que el mostrador de esa sucursal no conoce, y lo nombra', () =>
      rechaza({ renglones: [{ sku: '99999', cantidad: 1, presentacion: 'Paquete', precio_tienda: 1, nombre: null }] }, /99999/));
  });

  it('si Kepler falla, la cotización QUEDA y el motivo se declara', async () => {
    const { svc, llamadas } = armar({ enviarFalla: 'el interruptor de Kepler está apagado' });
    const r = await svc.registrar(pedido());
    expect(r.estado).toBe('creado');
    expect(r.quote_code).toBe('COT-2026-99999');
    expect(r.kepler_folio).toBeUndefined();
    expect(String(r.motivo)).toContain('interruptor');
    expect(llamadas.enviar).toEqual(['q-1']);
  });

  it('sin número de pedido no se hace nada', async () => {
    const { svc } = armar();
    await expect(svc.registrar(pedido({ numero: '' }))).rejects.toThrow(/número/);
  });
});

describe('[COT.7.50] ⛔⛔ dos entregas del MISMO aviso a la vez no son dos pedidos', () => {
  it('⭐ el segundo espera al primero y devuelve SU resultado: una sola cotización', async () => {
    // Wix reintenta, y un proxy lento hace que el reintento alcance al original. `yaEntro()` es
    // una lectura seguida de una escritura: sin candado, los dos pasan.
    const { svc, llamadas } = armar();
    const [a, b] = await Promise.all([svc.registrar(pedido()), svc.registrar(pedido())]);
    expect(llamadas.create).toHaveLength(1);
    expect(llamadas.enviar).toEqual(['q-1']);
    expect(a).toEqual(b);
  });

  it('y el candado se SUELTA al terminar: el pedido siguiente no queda trabado', async () => {
    const { svc, llamadas } = armar();
    await svc.registrar(pedido());
    await svc.registrar(pedido({ numero: '11223' }));
    expect(llamadas.create).toHaveLength(2);
  });

  it('⭐ se suelta incluso si la corrida FALLA: un error no traba el número para siempre', async () => {
    const { svc } = armar({ escaleras: new Map() });
    // sin escalera el productor rechaza; no lanza, pero el candado igual se tiene que soltar
    await svc.registrar(pedido());
    const r = await svc.registrar(pedido());
    expect(r.estado).toBe('rechazado');
  });

  it('pedidos DISTINTOS no se estorban entre sí', async () => {
    const { svc, llamadas } = armar();
    await Promise.all([svc.registrar(pedido()), svc.registrar(pedido({ numero: '11224' }))]);
    expect(llamadas.create).toHaveLength(2);
  });
});

describe('[COT.7.50] ⛔⛔ el libro: un pedido que NO entró tiene que dejar rastro', () => {
  /** La anotación en `commercial.store_orders`, que es la única fila que esto escribe. */
  const libro = (llamadas: { anotado: { tabla: string; fila: Record<string, unknown>; merge?: Record<string, unknown> }[] }) => {
    expect(llamadas.anotado).toHaveLength(1);
    expect(llamadas.anotado[0].tabla).toBe('commercial.store_orders');
    return llamadas.anotado[0];
  };

  it('⭐⭐ un pedido RECHAZADO deja fila, con su motivo: sin esto el cliente pagó y nadie se entera', async () => {
    const { svc, llamadas } = armar();
    const r = await svc.registrar(pedido({ renglones: [{ sku: '99999', cantidad: 1, presentacion: 'Paquete', precio_tienda: 1, nombre: null }] }));
    expect(r.estado).toBe('rechazado');
    const { fila } = libro(llamadas);
    expect(fila['estado']).toBe('rechazado');
    expect(fila['numero']).toBe('11222');
    expect(String(fila['motivo'])).toContain('99999');
    expect(fila['quote_id']).toBeNull();
  });

  it('⭐ y la carga guardada alcanza para rescatarlo a mano, sin volver a Wix', async () => {
    const { svc, llamadas } = armar();
    await svc.registrar(pedido({ renglones: [{ sku: '99999', cantidad: 7, presentacion: 'Caja', precio_tienda: 310.5, nombre: 'PALETA' }] }));
    const { fila } = libro(llamadas);
    const carga = JSON.parse(String(fila['carga']));
    expect(carga.renglones).toEqual([{ sku: '99999', cantidad: 7, presentacion: 'Caja', precio_tienda: 310.5, nombre: 'PALETA' }]);
    expect(carga.comprador).toBe('Comprador De Prueba');
    expect(fila['renglones']).toBe(1);
    expect(fila['pago']).toBe('PAID');
    expect(fila['estatus_tienda']).toBe('APPROVED');
  });

  it('un pedido que SÍ entró queda como `creado`, con su cotización y su folio', async () => {
    const { svc, llamadas } = armar();
    await svc.registrar(pedido());
    const { fila } = libro(llamadas);
    expect(fila['estado']).toBe('creado');
    expect(fila['quote_id']).toBe('q-1');
    expect(fila['quote_code']).toBe('COT-2026-99999');
    expect(fila['kepler_folio']).toBe('0004360');
    expect(fila['origen']).toBe('wix');
    expect(fila['tenant_id']).toBe('t1');
  });

  it('la cotización creada con Kepler caído queda `creado` CON el motivo: el hueco se declara', async () => {
    const { svc, llamadas } = armar({ enviarFalla: 'el interruptor de Kepler está apagado' });
    await svc.registrar(pedido());
    const { fila } = libro(llamadas);
    expect(fila['estado']).toBe('creado');
    expect(String(fila['motivo'])).toContain('interruptor');
    expect(fila['kepler_folio']).toBeNull();
  });

  it('⭐ la MISMA entrega otra vez no es un pedido más: sube `entregas` sobre la misma llave', async () => {
    const { svc, llamadas } = armar({ previo: { id: 'q-0', code: 'COT-2026-00828', kepler_folio: '0004359' } });
    const r = await svc.registrar(pedido());
    expect(r.estado).toBe('ya_estaba');
    const { fila, merge } = libro(llamadas);
    // `ya_estaba` es una entrega repetida de un pedido que SÍ está creado: así se anota.
    expect(fila['estado']).toBe('creado');
    expect(fila['quote_code']).toBe('COT-2026-00828');
    expect(merge?.['entregas']).toEqual({ __raw: 'store_orders.entregas + 1' });
  });

  it('⛔ PRUEBA NEGATIVA: un «creado» SIN cotización no se anota — la fila mentiría', async () => {
    const { svc, llamadas } = armar();
    // El único camino que devuelve `creado` sin cotización no existe hoy; se fuerza para probar
    // que la guarda está, porque `store_orders_creado_ck` lo rechazaría en la base igualmente.
    const anotar = (svc as unknown as { anotar: (p: unknown, r: unknown) => Promise<void> }).anotar.bind(svc);
    await anotar(pedido(), { estado: 'creado' });
    expect(llamadas.anotado).toHaveLength(0);
  });

  it('⛔ si el LIBRO falla, el pedido igual se contesta (falla abierto, declarado)', async () => {
    const { svc, llamadas } = armar({ libroFalla: 'permission denied for table store_orders' });
    const r = await svc.registrar(pedido());
    expect(r.estado).toBe('creado');
    expect(r.quote_code).toBe('COT-2026-99999');
    expect(llamadas.anotado).toHaveLength(0);
  });

  it('sin número no hay llave: no se anota nada suelto', async () => {
    const { svc, llamadas } = armar();
    const anotar = (svc as unknown as { anotar: (p: unknown, r: unknown) => Promise<void> }).anotar.bind(svc);
    await anotar(pedido({ numero: '  ' }), { estado: 'rechazado', motivo: 'x' });
    expect(llamadas.anotado).toHaveLength(0);
  });
});
