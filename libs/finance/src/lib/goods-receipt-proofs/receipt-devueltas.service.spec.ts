import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { ReceiptDevueltasService } from './receipt-devueltas.service';
import { GoodsReceiptProofsController } from './goods-receipt-proofs.controller';
import { FinanceGoodsReceiptProofsModule } from './finance-goods-receipt-proofs.module';

/** Un query builder de knex que se puede encadenar y se resuelve con `filas`. */
function builder(filas: unknown) {
  const b: any = {};
  for (const m of ['where', 'whereNull', 'whereRaw', 'select']) b[m] = () => b;
  b.first = async () => filas;
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, ko);
  return b;
}

const TENANT = '00000000-0000-0000-0000-00000000d01c';

function armar(opts: {
  usuarios: { id: string; username: string; role_name: string }[];
  escribe: Record<string, string[]>; // userId → sucursales donde puede subir ('*' = todas)
  proof?: Record<string, unknown> | null;
}) {
  const notify = vi.fn(async () => undefined);
  const tk = {
    run: async (_t: unknown, fn?: (trx: unknown) => unknown) => {
      const trx = (tabla: string) => builder(tabla.startsWith('identity.users') ? opts.usuarios : opts.proof ?? null);
      return (fn ?? (_t as (trx: unknown) => unknown))(trx);
    },
  };
  const scope = {
    forUser: async (_t: string, id: string) => ({ id, dims: { warehouse: { modeWrite: (opts.escribe[id] ?? []).includes('*') ? 'all' : 'some' } } }),
    canWrite: (s: { id: string }, _d: string, suc: string) => (opts.escribe[s.id] ?? []).some((x) => x === '*' || x === suc),
  };
  const ctx = { requireTenantId: () => TENANT };
  const svc = new ReceiptDevueltasService(tk as any, ctx as any, scope as any, { notifyCritical: async () => undefined, notify } as any);
  return { svc, notify };
}

describe('[RE.83] la devolución le llega a quien puede subir en la sucursal', () => {
  // ⚠️ Vitest (esbuild) no emite `design:paramtypes`: esto mide el contrato que sí se ve, igual que
  // `finance-goods-receipt-proofs.module.arranque.spec.ts`. El arranque real de Nest no se prueba acá.
  it('el servicio está en el módulo y los constructores piden lo de siempre (si cambian, revisar el arranque)', () => {
    expect(ReceiptDevueltasService.length).toBe(4);
    expect(GoodsReceiptProofsController.length).toBe(5);
    expect(Reflect.getMetadata('providers', FinanceGoodsReceiptProofsModule)).toContain(ReceiptDevueltasService);
    // Las tres dependencias de clase ya las resuelve el módulo para el servicio hermano.
    expect([TenantKnexService, TenantContextService, ScopeService].every(Boolean)).toBe(true);
  });

  it('avisa a cada capturista DE la sucursal (escribe ahí y no en todas), y a nadie más', async () => {
    const { svc, notify } = armar({
      usuarios: [
        { id: 'a', username: 'ana', role_name: 'encargado_tienda' },     // sube en 07
        { id: 'b', username: 'beto', role_name: 'encargado_tienda' },    // sube en 01, no en 07
        { id: 'c', username: 'carla', role_name: 'compras' },            // sube en todas (oficina): fuera
        { id: 'd', username: 'root', role_name: 'superadmin' },          // god-mode: fuera
      ],
      escribe: { a: ['07'], b: ['01'], c: ['*'], d: ['*'] },
      proof: { sucursal: '07', folio: '0000157', proveedor_nombre: 'LA ROSA', motivo_rechazo: 'Es la hoja de Kepler' },
    });
    const r = await svc.alDevolver('p1');
    expect(r.destinatarios).toBe(1);
    const para = notify.mock.calls.map((c: any[]) => c[1].para_usuario).sort();
    expect(para).toEqual(['ana']);
    const aviso = (notify.mock.calls[0] as any[])[1];
    expect(aviso.type).toBe('entradas_devuelta');
    expect(aviso.route).toContain('bandeja=devueltas');
    expect(aviso.title).not.toMatch(/\b07\b/); // la sucursal se nombra, no se numera
  });

  it('sin nadie que pueda subir ahí, lo dice: 0 destinatarios y ningún envío', async () => {
    const { svc, notify } = armar({
      usuarios: [{ id: 'b', username: 'beto', role_name: 'encargado_tienda' }],
      escribe: { b: ['01'] },
      proof: { sucursal: '07', folio: '1', proveedor_nombre: null, motivo_rechazo: null },
    });
    expect((await svc.alDevolver('p1')).destinatarios).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('nunca tumba la devolución: un fallo deja destinatarios en null (no medido)', async () => {
    const { svc } = armar({ usuarios: [], escribe: {}, proof: null });
    (svc as any).tk.run = async () => { throw new Error('base caída'); };
    expect(await svc.alDevolver('p1')).toEqual({ destinatarios: null });
  });

  it('el aviso manual exige al menos una sucursal', async () => {
    const { svc } = armar({ usuarios: [], escribe: {} });
    await expect(svc.avisarSucursales([], 'edgar')).rejects.toThrow(/sucursal/);
  });
});
