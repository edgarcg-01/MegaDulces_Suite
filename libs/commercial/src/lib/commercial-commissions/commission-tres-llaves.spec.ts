import { ForbiddenException } from '@nestjs/common';
import { Permission, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommercialCommissionsController } from './commercial-commissions.controller';

/**
 * `[RD.101]` (D6, firmada por Edgar) — **calcula Comercial, aprueba Dirección, paga Finanzas, y
 * nadie aprueba lo que calculó.**
 *
 * Medido en prod el 2026-10-30: las tres cosas colgaban de una sola llave (GESTIONAR) que tenían
 * 11 personas. Quien calculaba podía aprobarse y pagarse solo.
 *
 * ⚠️ El doble no ejecuta SQL: lo que se prueba es a quién se le niega el acto. La llave de cada
 * endpoint se lee de la metadata del decorador, que es lo que consulta `RolesGuard`.
 */

function servicio(run: Record<string, unknown>, userId: string | null) {
  const actualizados: Record<string, unknown>[] = [];
  const qb: Record<string, (...a: unknown[]) => unknown> = {
    where: () => qb, whereNull: () => qb,
    first: async () => run,
    update: async (p: unknown) => { actualizados.push(p as Record<string, unknown>); return 1; },
  };
  const trx = Object.assign(() => qb, { fn: { now: () => 'now()' } });
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(trx) } as never;
  const tenantCtx = { get: () => ({ userId }), requireTenantId: () => 't1' } as never;
  const svc = new CommercialCommissionsService(tk, tenantCtx);
  // getRunInTrx relee la corrida con su detalle; acá basta con saber que se llegó a escribir.
  (svc as unknown as { getRunInTrx: () => Promise<unknown> }).getRunInTrx = async () => ({ ok: true });
  return { svc, actualizados };
}

describe('[RD.101] nadie aprueba lo que calculó', () => {
  it('quien calculó la corrida no la puede aprobar', async () => {
    const { svc, actualizados } = servicio({ id: 'r1', status: 'borrador', created_by: 'ana' }, 'ana');
    await expect(svc.setStatus('r1', 'aprobado')).rejects.toBeInstanceOf(ForbiddenException);
    expect(actualizados).toHaveLength(0);
  });

  it('control: otra persona sí la aprueba, y queda su sello', async () => {
    const { svc, actualizados } = servicio({ id: 'r1', status: 'borrador', created_by: 'ana' }, 'beto');
    await svc.setStatus('r1', 'aprobado');
    expect(actualizados[0]).toMatchObject({ status: 'aprobado', approved_by: 'beto' });
  });

  it('la que dejó el cron (sin created_by) la aprueba quien tenga la llave', async () => {
    const { svc, actualizados } = servicio({ id: 'r1', status: 'borrador', created_by: null }, 'beto');
    await svc.setStatus('r1', 'aprobado');
    expect(actualizados).toHaveLength(1);
  });

  it('anular una APROBADA exige poder aprobar; un borrador no', async () => {
    const a = servicio({ id: 'r1', status: 'aprobado', created_by: 'ana' }, 'ana');
    await expect(a.svc.setStatus('r1', 'anulado')).rejects.toBeInstanceOf(ForbiddenException);
    const b = servicio({ id: 'r1', status: 'aprobado', created_by: 'ana' }, 'beto');
    await b.svc.setStatus('r1', 'anulado', { puedeDesaprobar: true });
    expect(b.actualizados).toHaveLength(1);
    const c = servicio({ id: 'r1', status: 'borrador', created_by: 'ana' }, 'ana');
    await c.svc.setStatus('r1', 'anulado');
    expect(c.actualizados).toHaveLength(1);
  });
});

describe('[RD.101] cada acto pide SU llave', () => {
  const llave = (metodo: keyof CommercialCommissionsController, clave = PERMISSIONS_KEY) =>
    Reflect.getMetadata(clave, CommercialCommissionsController.prototype[metodo] as object);

  it('calcular = GESTIONAR · aprobar = APROBAR · pagar = PAGAR', () => {
    expect(llave('compute')).toEqual([Permission.COMMERCIAL_COMMISSIONS_GESTIONAR]);
    expect(llave('approve')).toEqual([Permission.COMMERCIAL_COMMISSIONS_APROBAR]);
    expect(llave('pay')).toEqual([Permission.COMMERCIAL_COMMISSIONS_PAGAR]);
  });

  it('anular acepta cualquiera de las dos que pueden anular algo', () => {
    expect(llave('voidRun', ANY_PERMISSIONS_KEY)).toEqual([
      Permission.COMMERCIAL_COMMISSIONS_GESTIONAR, Permission.COMMERCIAL_COMMISSIONS_APROBAR,
    ]);
  });

  it('el controlador deja desaprobar sólo a quien tiene APROBAR o es admin', async () => {
    const llamados: unknown[] = [];
    const ctl = Object.create(CommercialCommissionsController.prototype) as CommercialCommissionsController;
    (ctl as unknown as { service: unknown }).service = {
      setStatus: async (...a: unknown[]) => { llamados.push(a[2]); return null; },
    };
    await ctl.voidRun('r1', { user: { permissions: { [Permission.COMMERCIAL_COMMISSIONS_GESTIONAR]: true } } });
    await ctl.voidRun('r1', { user: { permissions: { [Permission.COMMERCIAL_COMMISSIONS_APROBAR]: true } } });
    await ctl.voidRun('r1', { user: { permissions: {}, roles_frescos: ['superadmin'] } });
    expect(llamados).toEqual([{ puedeDesaprobar: false }, { puedeDesaprobar: true }, { puedeDesaprobar: true }]);
  });
});
