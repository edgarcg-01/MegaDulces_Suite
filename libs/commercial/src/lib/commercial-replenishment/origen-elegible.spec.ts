import { AutoabastoPedidoService } from './autoabasto-pedido.service';
import { ORIGEN_NO_VALIDO, ORIGEN_NO_VALIDO_MSG } from '@megadulces/contracts';

/**
 * `[PQ.139]` · D2 (Edgar, 2026-11-22) — **De qué almacén se pide.**
 *
 * *«Sí, sugiere su almacén principal por default, pero puede modificar el origen a otro almacén»*.
 * Las dos mitades de esa frase son las dos mitades de este archivo:
 *
 *  1. **El default no se teclea.** Sin `origen_code` no se consulta nada y manda el que propone el
 *     motor. Pedir el caso normal nunca cuesta una validación.
 *  2. **El otro almacén lo decide el SERVIDOR.** La pantalla puede ofrecer la lista que quiera: la
 *     lista blanca vive en el servicio, porque un cliente no es un lugar donde poner un permiso.
 *     Y un origen inválido **no se corrige en silencio**: se rechaza diciendo cuál falló.
 *
 * ⚠️ Lo que a propósito NO se valida: que el origen tenga existencia. ADR-127 §4: el CEDIS surtió
 * 1,123 SKU distintos en 30 días y sólo el 24.3 % tiene existencia hoy. La existencia se muestra.
 */
const ALMACEN = { id: 'w-07', code: '07', name: 'Morelia Madero' };

const BUENO = { id: 'w-08', code: '08', name: 'Morelia Abastos', active: true, kind: 'central', kepler_code: '08' };

/** El servicio sin Nest, con un `tk` que devuelve el almacén que le pongas (o nada). */
const svcCon = (fila: Record<string, unknown> | undefined, visto: string[] = []) => {
  const s = Object.create(AutoabastoPedidoService.prototype) as Record<string, unknown>;
  s['tk'] = {
    run: async (fn: (trx: unknown) => Promise<unknown>) => {
      const qb: Record<string, unknown> = {};
      for (const m of ['where', 'whereNull']) qb[m] = (arg: unknown) => {
        if (m === 'where' && arg && typeof arg === 'object' && 'code' in (arg as Record<string, unknown>)) {
          visto.push(String((arg as Record<string, unknown>)['code']));
        }
        return qb;
      };
      qb['first'] = async () => fila;
      return fn(() => qb);
    },
  };
  return s as unknown as AutoabastoPedidoService;
};

/** `origenElegido` es privado: se llama por su nombre, que es justo lo que se quiere congelar. */
const elegir = (svc: AutoabastoPedidoService, code: string | null | undefined) =>
  (svc as unknown as { origenElegido: (t: string, a: typeof ALMACEN, c: string | null | undefined) => Promise<unknown> })
    .origenElegido('t', ALMACEN, code);

describe('[PQ.139] el default no se teclea', () => {
  it.each([undefined, null, '', '   '])('sin origen (%s) devuelve null y NO consulta la base', async (code) => {
    const visto: string[] = [];
    expect(await elegir(svcCon(undefined, visto), code)).toBeNull();
    expect(visto).toEqual([]);
  });

  it('un origen válido se devuelve con su nombre, para que la pantalla lo pueda decir', async () => {
    expect(await elegir(svcCon(BUENO), '08')).toEqual({ id: 'w-08', code: '08', name: 'Morelia Abastos' });
  });

  it('el código se usa tal cual, sin espacios de más', async () => {
    const visto: string[] = [];
    await elegir(svcCon(BUENO, visto), '  08  ');
    expect(visto).toEqual(['08']);
  });
});

describe('[PQ.139] la lista blanca del origen', () => {
  const casos: Array<[string, Record<string, unknown> | undefined, string]> = [
    ['no existe o está borrado', undefined, 'no_existe'],
    ['está inactivo', { ...BUENO, active: false }, 'inactivo'],
    ['es un camión de ruta', { ...BUENO, kind: 'truck' }, 'es_camion'],
    ['no tiene kepler_code', { ...BUENO, kepler_code: null }, 'sin_kepler'],
    ['tiene kepler_code en blanco', { ...BUENO, kepler_code: '   ' }, 'sin_kepler'],
    ['es el MISMO almacén', { ...BUENO, id: ALMACEN.id }, 'es_el_mismo'],
  ];

  it.each(casos)('⛔ %s → se rechaza, y el motivo lo dice', async (_q, fila, clave) => {
    await expect(elegir(svcCon(fila), '08')).rejects.toThrow(
      new RegExp(ORIGEN_NO_VALIDO_MSG[clave as keyof typeof ORIGEN_NO_VALIDO_MSG].slice(0, 20)),
    );
  });

  it('⛔ el mensaje nombra el almacén que la persona eligió, no un código interno', async () => {
    await expect(elegir(svcCon(undefined), 'ZZ')).rejects.toThrow(/ZZ/);
  });

  it('CONTROL: los 5 motivos de la lista tienen mensaje, y ninguno es el código', () => {
    for (const k of ORIGEN_NO_VALIDO) {
      expect(ORIGEN_NO_VALIDO_MSG[k]).toBeTruthy();
      expect(ORIGEN_NO_VALIDO_MSG[k]).not.toBe(k);
    }
  });

  it('CONTROL: un almacén activo, central, con kepler y distinto NO se rechaza', async () => {
    await expect(elegir(svcCon(BUENO), '08')).resolves.toBeTruthy();
  });
});

describe('[PQ.139] el origen elegido manda sobre los renglones de SUCURSAL, y sólo sobre ésos', () => {
  const P1 = '11111111-1111-1111-1111-111111111111';
  const P2 = '22222222-2222-2222-2222-222222222222';
  const P3 = '33333333-3333-3333-3333-333333333333';

  const linea = (id: string, tipo: 'matriz' | 'proveedor', clave: string) => ({
    linea: {
      product_id: id, estado: 'falta', surte: { tipo, clave, nombre: clave },
      a_pedir: { cantidad: 2, cantidad_base: 24 }, ajuste: null,
    },
    fila: {}, cf: 12, efectivo_base: 24,
  });

  /** Devuelve los DTO que `enviar()` mandó a crear: ahí se ve de qué origen salió cada pedido. */
  const armar = (renglones: unknown[], dtosVistos: Array<Record<string, unknown>>) => {
    const svc = Object.create(AutoabastoPedidoService.prototype) as Record<string, unknown>;
    svc['logger'] = { warn: () => undefined };
    svc['tenantCtx'] = { requireTenantId: () => 't', get: () => ({ userId: null, username: null }) };
    svc['armarAlmacen'] = async () => ({ renglones });
    svc['borradorDe'] = async () => 'ped-1';
    svc['huella'] = async () => undefined;
    svc['origenElegido'] = async (_t: string, _a: unknown, code: string | null | undefined) =>
      (code ? { id: 'w-08', code: String(code), name: 'Morelia Abastos' } : null);
    const qb = (filas: unknown[]): Record<string, unknown> => {
      const b = Promise.resolve(filas) as unknown as Record<string, unknown>;
      for (const m of ['where', 'whereIn', 'whereNull', 'select', 'first', 'insert', 'update']) b[m] = () => b;
      return b;
    };
    // Las dos matrices posibles existen: lo que se mide es cuál se usó, no si se encontró.
    const trx = Object.assign((tabla: string) => qb(tabla === 'commercial.warehouses'
      ? [{ id: 'w-08', code: '08' }, { id: 'w-01', code: '01' }] : []), { raw: async () => ({ rows: [] }) });
    svc['tk'] = { run: async (fn: (t: unknown) => Promise<unknown>) => fn(trx) };
    svc['motor'] = {
      crearRequisicionesDeSucursal: async (_w: string, dtos: Array<Record<string, unknown>>) => {
        dtosVistos.push(...dtos);
        return { creadas: dtos.map((_d, i) => ({ id: `req-${i}`, folio: `RQ-${i}`, indice: i, renglones: 1, total_units: 2 })), ya_pedidos: [] };
      },
      soltarPedidoDeSucursal: async (ids: string[]) => new Map(ids.map((id) => [id, { estado: 'entregada', sucursal: '08', folio: '1' }])),
    };
    return svc as unknown as AutoabastoPedidoService;
  };

  const enviar = (svc: AutoabastoPedidoService, ids: string[], origen_code?: string) =>
    svc.enviar(ALMACEN, 'almacen', { warehouse_id: ALMACEN.id, product_ids: ids, ...(origen_code ? { origen_code } : {}) });

  it('sin elegir origen, cada renglón va a la matriz que propuso el motor: DOS pedidos', async () => {
    const dtos: Array<Record<string, unknown>> = [];
    await enviar(armar([linea(P1, 'matriz', '01'), linea(P2, 'matriz', '08')], dtos), [P1, P2]);
    expect(dtos).toHaveLength(2);
    expect(dtos.map((d) => d['source_warehouse_id']).sort()).toEqual(['w-01', 'w-08']);
  });

  /** ⛔ LA REGLA: un `U-D-40` sale de UNA sucursal. Elegir origen funde los dos en un solo pedido. */
  it('⛔ al elegir origen, los renglones de sucursal se funden en UN pedido, desde ese origen', async () => {
    const dtos: Array<Record<string, unknown>> = [];
    await enviar(armar([linea(P1, 'matriz', '01'), linea(P2, 'matriz', '08')], dtos), [P1, P2], '08');
    expect(dtos).toHaveLength(1);
    expect(dtos[0]['source_warehouse_id']).toBe('w-08');
    expect((dtos[0]['lines'] as unknown[])).toHaveLength(2);
  });

  it('⛔ el renglón de PROVEEDOR no cambia de origen: a un proveedor se le pide donde se le pide', async () => {
    const dtos: Array<Record<string, unknown>> = [];
    await enviar(armar([linea(P1, 'matriz', '01'), linea(P3, 'proveedor', 'prov-1')], dtos), [P1, P3], '08');
    const compra = dtos.find((d) => d['source_type'] === 'supplier');
    expect(compra).toBeTruthy();
    expect(compra!['supplier_id']).toBe('prov-1');
    expect(compra!['source_warehouse_id']).toBeNull();
    expect(dtos.find((d) => d['source_type'] === 'branch')!['source_warehouse_id']).toBe('w-08');
  });
});
