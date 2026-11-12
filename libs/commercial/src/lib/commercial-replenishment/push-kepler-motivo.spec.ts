// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).
import { BadRequestException } from '@nestjs/common';
import { CommercialReplenishmentService, motivoSinRespuesta } from './commercial-replenishment.service';

/**
 * `[PQ.109]` Un envío a Kepler que no sale deja su motivo en `kepler_error`.
 *
 * Medido el 2026-11-11: RQ-2026-02505 (Padre Hidalgo) y RQ-2026-02507 (CEDIS) fallaron en cada
 * reintento con «Connection terminated due to connection timeout» —el túnel a esos dos servidores
 * estaba caído— y «Lo pedido» decía «por enviar». El adapter abre la conexión fuera de su try y
 * LANZA; `pushKeplerTrasAprobar` atrapa sin anotar. Lo mismo con los frenos de la Suite.
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ID = '11111111-2222-4333-8444-555555555555';

const CAB = {
  id: ID, folio: 'RQ-2026-02507', estado: 'approved', source_type: 'supplier', total_cost: 1000,
  kepler_sucursal: null, kepler_folio: null as string | null, wcode: '00', kepler_code: '00',
  prov_code: 'P1' as string | null, prov_name: 'THE KLASS', origen_kepler_code: null,
  wname: 'CEDIS', origen_name: null, approved_at: '2026-11-11T16:55:00Z',
};

function armar(opts: { cab?: Partial<typeof CAB>; entregar?: () => Promise<unknown> } = {}) {
  const updates: Array<{ tabla: string; set: Record<string, unknown>; nulos: string[] }> = [];
  const cab = { ...CAB, ...opts.cab };
  const lineas = [{ sku: '99064', nombre: 'MINI PAY', final_qty: '2', unit_cost: '80', line_cost: '160', box_factor: '1' }];
  // Un builder de knex que acepta cualquier cadena; sólo `first`, `update`, `whereNull` y el
  // `await` de los renglones devuelven algo.
  const trx: any = (tabla: string) => {
    const nulos: string[] = [];
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'first') return async () => (tabla.startsWith('commercial.purchase_requisitions as r') ? cab
          : tabla === 'commercial.kepler_push_switch' ? { encendida: true, tope_dia: null, genera_orden: false } : undefined);
        if (prop === 'update') return async (set: Record<string, unknown>) => { updates.push({ tabla, set, nulos: [...nulos] }); return 1; };
        if (prop === 'whereNull') return (c: string) => { nulos.push(c); return b; };
        if (prop === 'then') return tabla.startsWith('commercial.purchase_requisition_lines') ? (ok: (v: unknown) => unknown) => ok(lineas) : undefined;
        return () => b;
      },
    });
    return b;
  };
  trx.fn = { now: () => 'NOW()' };
  trx.raw = (sql: string) => Promise.resolve({ rows: [sql.includes('to_regclass') ? { a: 'analytics.mv_warehouse_box_factor' } : { t: true }] });
  const tk = { run: async (fn: (t: unknown) => unknown) => fn(trx) };
  const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ tenantId: TENANT, userId: null }) };
  const entregar = vi.fn(opts.entregar ?? (async () => ({ estado: 'entregada', kepler: { sucursal: '00', folio: '0003172', renglones: 1 } })));
  const svc = new CommercialReplenishmentService(tk as never, tenantCtx as never, {} as never, {} as never, { entregar, disponible: async () => true } as never);
  return { svc, updates, entregar };
}

describe('[PQ.109] el envío a Kepler que no sale deja su motivo', () => {
  it('⭐ un Kepler que no contesta (el sink LANZA) se anota con el nombre de la sucursal, y se avisa', async () => {
    const { svc, updates } = armar({ entregar: async () => { throw new Error('Connection terminated due to connection timeout'); } });
    const err = await svc.pushToKepler(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const motivo = 'El Kepler de CEDIS no contestó (Connection terminated due to connection timeout); la Suite la reintenta sola cada 30 min.';
    expect((err as Error).message).toBe(motivo);
    expect(updates).toEqual([{ tabla: 'commercial.purchase_requisitions', set: { kepler_error: motivo }, nulos: ['kepler_folio'] }]);
  });

  it('un freno de la Suite (proveedor sin clave de Kepler) también queda escrito, y no se le habla al ERP', async () => {
    const { svc, updates, entregar } = armar({ cab: { prov_code: null } });
    await expect(svc.pushToKepler(ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(entregar).not.toHaveBeenCalled();
    expect(updates[0].set['kepler_error']).toBe('El proveedor no tiene código Kepler cargado (kdm1.c10 es obligatorio).');
    expect(updates[0].nulos).toEqual(['kepler_folio']);
  });

  it('CONTROL: lo que sale limpia el motivo y guarda el folio', async () => {
    const { svc, updates } = armar();
    const r = await svc.pushToKepler(ID);
    expect(r.kepler?.folio).toBe('0003172');
    expect(updates[0].set).toMatchObject({ kepler_folio: '0003172', kepler_error: null });
  });

  it('NEGATIVA: la que ya salió no se vuelve a enviar ni se le escribe motivo', async () => {
    const { svc, updates, entregar } = armar({ cab: { kepler_folio: '0003172' } });
    expect((await svc.pushToKepler(ID)).ya_estaba).toBe(true);
    expect(entregar).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe('[PQ.109] el motivo no promete lo que no pasa', () => {
  const cab = { estado: 'approved', wname: 'CEDIS', origen_name: 'Padre Hidalgo', approved_at: '2026-11-11T16:55:00Z' };
  const timeout = new Error('Connection terminated due to connection timeout');

  it('el traspaso nombra la sucursal ORIGEN y no promete reintento solo (no lo tiene)', () => {
    expect(motivoSinRespuesta(cab, 'traspaso', '01', timeout))
      .toBe('El Kepler de Padre Hidalgo no contestó (Connection terminated due to connection timeout); reintenta desde la ficha.');
  });

  it('una compra aprobada antes de que existiera la escritura no entra al reintento solo', () => {
    expect(motivoSinRespuesta({ ...cab, approved_at: '2026-10-20T16:00:00Z' }, 'compra', '00', timeout)).toMatch(/reintenta desde la ficha\.$/);
  });

  it('una falla que no es de conexión no se rotula «no contestó»', () => {
    expect(motivoSinRespuesta(cab, 'compra', '00', new Error('valor nulo en kdm1.c10')))
      .toBe('Falló el envío al Kepler de CEDIS (valor nulo en kdm1.c10); la Suite la reintenta sola cada 30 min.');
  });

  it('sin nombre de sucursal dice su clave, no se queda en blanco', () => {
    expect(motivoSinRespuesta({ ...cab, wname: null }, 'compra', '00', timeout)).toMatch(/^El Kepler de la sucursal 00 no contestó/);
  });
});
