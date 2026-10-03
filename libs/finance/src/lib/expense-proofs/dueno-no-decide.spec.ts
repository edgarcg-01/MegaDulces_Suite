import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.65.4a]` Cableado de «nadie decide sobre su propio vale» en el servicio y el controller.
 * La regla en sí se prueba en `libs/contracts/src/finance/dueno-del-vale.spec.ts`.
 */
/** Que el servicio y el controller de verdad lo apliquen en las TRES decisiones. */
describe('[GX.65.4a] la guarda está en aprobar, validar y rechazar', () => {
  const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
  const CONTROLLER = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.controller.ts'), 'utf8'));

  const cuerpo = (decl: string) => {
    const i = SERVICIO.indexOf(decl);
    return i < 0 ? '' : SERVICIO.slice(i, i + 1800);
  };

  for (const decl of ['async approve(', 'async validate(', 'async reject(']) {
    it(`${decl} llama a la guarda`, () => {
      expect(cuerpo(decl)).toContain('this.asegurarQueNoEsSuyo(trx, id, quien)');
    });
  }

  /** ⛔ Sin identidad, NO pasa: el lado seguro. */
  it('⛔ sin identidad la guarda niega', () => {
    const g = SERVICIO.slice(SERVICIO.indexOf('private async asegurarQueNoEsSuyo('));
    expect(g).toContain("throw new ForbiddenException('No se pudo identificar quién decide sobre el vale.')");
  });

  it('el controller manda las DOS identidades en las tres rutas', () => {
    expect(CONTROLLER).toContain('const quienDecide = (req?: AuthedRequest) => ({ username: req?.user?.username, full_name: req?.user?.full_name })');
    expect((CONTROLLER.match(/quienDecide\(req\)/g) || []).length).toBe(3);
  });
});

/**
 * ⛔ `[GX.65.4a]` **El bug que encontró la simulación por niveles.** El token de sesión NO trae
 * `full_name` y `req.user` ES el token: comparando sólo lo que llega, el dueño de un vale
 * guardado con su NOMBRE se colaba. La guarda tiene que leer el nombre real del padrón.
 */
describe('[GX.65.4a] la guarda lee el nombre del padrón', () => {
  const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
  const guarda = SERVICIO.slice(SERVICIO.indexOf('private async asegurarQueNoEsSuyo('),
    SERVICIO.indexOf('async reject(id: string'));

  it('si el token no trae nombre, lo busca en identity.users por username', () => {
    expect(guarda).toContain("trx('users')");
    expect(guarda).toContain(".whereRaw('lower(username) = lower(?)', [usuario])");
    expect(guarda).toContain(".first('nombre')");
  });

  it('compara con el nombre resuelto, no con el que vino en el token', () => {
    expect(guarda).toContain('esDuenoDelVale(vale, { username: usuario, full_name: nombre })');
  });
});
