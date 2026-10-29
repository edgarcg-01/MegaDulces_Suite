import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExpenseProofsService } from './expense-proofs.service';
import { ExpenseProofsController } from './expense-proofs.controller';

/**
 * `[GX.87]` Evidencia adicional: se SUMA al expediente con su porqué, sin cambiar el estado.
 * Pueden agregar el dueño del vale y quien aprueba. Base simulada: lo que se prueba es la regla
 * del servicio (quién, qué estado, qué se escribe), no SQL.
 */
type Vale = { id: string; status: string; files: unknown; created_by: string | null; evidencia_por: string | null };

function montar(vale: Vale | undefined) {
  const escrito: Record<string, unknown>[] = [];
  const tabla = () => {
    const q: Record<string, unknown> = {};
    q['where'] = () => q;
    q['forUpdate'] = () => q;
    q['first'] = async () => vale;
    q['update'] = async (v: Record<string, unknown>) => { escrito.push(v); return 1; };
    return q;
  };
  const trx = Object.assign(() => tabla(), { fn: { now: () => 'NOW()' } });
  const svc = Object.create(ExpenseProofsService.prototype) as ExpenseProofsService;
  Object.assign(svc, {
    tenantCtx: { requireTenantId: () => 't' },
    tk: { run: (fn: (t: unknown) => unknown) => fn(trx) },
    logger: { log: () => undefined, warn: () => undefined },
    storage: { signFiles: async (l: { url: string }[]) => l.map((x) => ({ ...x, url: 'firmada:' + x.url })) },
  });
  // El nombre real del padrón no viaja en el token: el servicio lo busca. Acá se fija.
  vi.spyOn(svc as never, 'identidadConNombre' as never).mockImplementation((async (_t: unknown, q: { username?: string }) =>
    ({ username: q.username, full_name: q.username === 'leonardo_cazares' ? 'LEONARDO CAZARES' : '' })) as never);
  return { svc, escrito };
}

const VALE = (over: Partial<Vale> = {}): Vale => ({
  id: 'v1', status: 'validada', created_by: 'leonardo_cazares', evidencia_por: null,
  files: [{ role: 'comprobante_1', url: 'k/comp.jpg' }], ...over,
});
const ARCH = [{ role: 'adicional', url: 'k/nueva.pdf', kind: 'pdf', motivo: 'lo manda el cliente', agregado_por: 'hacker' }];
const MOTIVO = 'Llegó la factura definitiva del proveedor';

describe('[GX.87] agregarEvidenciaAdicional', () => {
  it('el dueño agrega: se SUMA al expediente, el estado no cambia y el porqué lo pone el servidor', async () => {
    const { svc, escrito } = montar(VALE());
    const r = await svc.agregarEvidenciaAdicional('v1', { files: ARCH as never, motivo: MOTIVO }, { username: 'leonardo_cazares' }, false);
    expect(r.agregados).toBe(1);
    // Devuelve el expediente COMPLETO y firmado: lo viejo y lo nuevo.
    expect(r.files.map((x) => x.url)).toEqual(['firmada:k/comp.jpg', 'firmada:k/nueva.pdf']);
    expect(escrito).toHaveLength(1);
    expect(Object.keys(escrito[0]).sort()).toEqual(['files', 'updated_at']); // ni status ni validated_*
    const files = JSON.parse(String(escrito[0]['files']));
    expect(files[0]).toEqual({ role: 'comprobante_1', url: 'k/comp.jpg' }); // lo anterior intacto
    expect(files[1]).toMatchObject({ role: 'adicional', url: 'k/nueva.pdf', kind: 'pdf', motivo: MOTIVO, agregado_por: 'LEONARDO CAZARES' });
    expect(typeof files[1].agregado_at).toBe('string');
  });

  it('alguien ajeno, sin ser aprobador, NO puede', async () => {
    const { svc, escrito } = montar(VALE());
    await expect(svc.agregarEvidenciaAdicional('v1', { files: ARCH as never, motivo: MOTIVO }, { username: 'otra_persona' }, false))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(escrito).toHaveLength(0);
  });

  it('quien aprueba sí, aunque el vale no sea suyo', async () => {
    const { svc, escrito } = montar(VALE());
    await svc.agregarEvidenciaAdicional('v1', { files: ARCH as never, motivo: MOTIVO }, { username: 'maria_gutierrez' }, true);
    expect(escrito).toHaveLength(1);
  });

  it('un vale rechazado no acepta evidencia', async () => {
    const { svc, escrito } = montar(VALE({ status: 'rechazada' }));
    await expect(svc.agregarEvidenciaAdicional('v1', { files: ARCH as never, motivo: MOTIVO }, { username: 'leonardo_cazares' }, false))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(escrito).toHaveLength(0);
  });

  it('sin porqué no entra, y no toca la base', async () => {
    const { svc, escrito } = montar(VALE());
    await expect(svc.agregarEvidenciaAdicional('v1', { files: ARCH as never, motivo: '  ' }, { username: 'leonardo_cazares' }, false))
      .rejects.toThrow(/por qué/);
    expect(escrito).toHaveLength(0);
  });

  it('un archivo con otro rol no se cuela por acá', async () => {
    const { svc } = montar(VALE());
    await expect(svc.agregarEvidenciaAdicional('v1', { files: [{ role: 'comprobante_1', url: 'k/x.jpg' }] as never, motivo: MOTIVO },
      { username: 'leonardo_cazares' }, false)).rejects.toThrow(/no es evidencia adicional/);
  });

  it('un vale que no existe da 404', async () => {
    const { svc } = montar(undefined);
    await expect(svc.agregarEvidenciaAdicional('nada', { files: ARCH as never, motivo: MOTIVO }, { username: 'x' }, true))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('[GX.87] el controller decide quién aprueba con el token', () => {
  const llamar = (user: Record<string, unknown>) => {
    const agregarEvidenciaAdicional = vi.fn().mockResolvedValue({ id: 'v1', agregados: 1 });
    const ctl = new ExpenseProofsController({ agregarEvidenciaAdicional } as never);
    ctl.agregarEvidenciaAdicional('v1', { files: [], motivo: 'x' }, { user } as never);
    return agregarEvidenciaAdicional.mock.calls[0][3] as boolean;
  };
  it('COMPROBAR = aprobador', () => expect(llamar({ username: 'a', permissions: { FINANCE_EXPENSES_COMPROBAR: true } })).toBe(true));
  it('sólo CAPTURAR = no aprobador (el servicio exige que sea el dueño)', () =>
    expect(llamar({ username: 'c', permissions: { FINANCE_EXPENSES_CAPTURAR: true } })).toBe(false));
});
