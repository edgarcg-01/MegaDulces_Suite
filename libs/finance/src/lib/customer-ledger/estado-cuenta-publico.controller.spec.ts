import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '@megadulces/platform-core';
import { CustomerDepositsService } from '../collection-deposits/customer-deposits.service';
import { EstadoCuentaClienteDocument } from './estado-cuenta-cliente.document';
import { EstadoCuentaPublicoController } from './estado-cuenta-publico.controller';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';

/**
 * `[CC.20.2]` El cliente descarga su estado de cuenta desde su enlace. Lo que importa: la cuenta sale del TOKEN (nunca de
 * la URL), un token que no sirve no genera PDF, y el grafo del módulo cierra (vitest no emite `design:paramtypes`:
 * se lee el grafo de los decoradores, como en `cartera-por-evento.arranque.spec.ts`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  return out;
}

function armar(tokenValido: string) {
  const render = vi.fn(async (s: string, c: string) => ({ pdf: Buffer.from(`PDF ${s}/${c}`), nombre: `estado-de-cuenta-${c}.pdf` }));
  const depositos = {
    conCuentaDelEnlace: vi.fn(async (token: string, fn: (s: string, c: string) => Promise<unknown>) => {
      if (token !== tokenValido) throw new ForbiddenException('Este enlace ya no sirve.');
      return fn('01', 'C1093');
    }),
  };
  const ctrl = new EstadoCuentaPublicoController(depositos as unknown as CustomerDepositsService, { render } as unknown as EstadoCuentaClienteDocument);
  const headers: Record<string, string> = {};
  const res = { setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }), send: vi.fn() };
  return { ctrl, render, depositos, res, headers };
}

describe('[CC.20.2] EstadoCuentaPublicoController', () => {
  it('la cuenta sale del token: render con la sucursal y el cliente del enlace, y responde un PDF', async () => {
    const { ctrl, render, res, headers } = armar('TK');
    await ctrl.pdf('TK', res as never, { headers: { host: 'megadulcessuite.com', 'x-forwarded-proto': 'https' } });
    expect(render).toHaveBeenCalledWith('01', 'C1093', 'https://megadulcessuite.com');
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toContain('estado-de-cuenta-C1093.pdf');
    expect(String(res.send.mock.calls[0][0])).toBe('PDF 01/C1093');
  });

  it('⛔ NEGATIVA: un token que no sirve no genera PDF ni responde', async () => {
    const { ctrl, render, res } = armar('TK');
    await expect(ctrl.pdf('OTRO', res as never, { headers: {} })).rejects.toBeInstanceOf(ForbiddenException);
    expect(render).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('es pública (sin sesión): lleva la marca de @Public()', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, EstadoCuentaPublicoController.prototype.pdf)).toBe(true);
  });

  it('el grafo cierra: el controlador está en el módulo y sus dos dependencias están al alcance', () => {
    expect(EstadoCuentaPublicoController.length).toBe(2);
    expect(meta<unknown>('controllers', FinanceCustomerLedgerModule)).toContain(EstadoCuentaPublicoController);
    const alcance = alcanceDe(FinanceCustomerLedgerModule);
    expect(alcance.has(CustomerDepositsService)).toBe(true);
    expect(alcance.has(EstadoCuentaClienteDocument)).toBe(true);
  });
});
