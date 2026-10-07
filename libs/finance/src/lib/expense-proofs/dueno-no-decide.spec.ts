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

  /**
   * ⚠️ `[GX.68]` Antes esto contaba usos de `quienDecide(req)` y exigía **exactamente 3**. Se
   * cambió porque el conteo medía la cosa equivocada: `GET :id` pasó a usar las mismas dos
   * identidades para resolver de quién es el vale, y el candado se puso rojo por un uso
   * LEGÍTIMO de más. Un número clavado convierte cualquier uso nuevo en una falla.
   *
   * Lo que importa no es cuántas veces aparece, sino que **las tres rutas que deciden** lo
   * manden. Eso es lo que se afirma ahora, ruta por ruta.
   */
  it('el controller manda las DOS identidades en las tres rutas que deciden', () => {
    expect(CONTROLLER).toContain('const quienDecide = (req?: AuthedRequest) => ({ username: req?.user?.username, full_name: req?.user?.full_name })');
    for (const ruta of ['approve', 'validate', 'reject']) {
      const i = CONTROLLER.indexOf(`/${ruta}'`);
      expect(i).toBeGreaterThan(-1);
      // El `quienDecide(req)` de esa ruta cae dentro de su propio handler.
      expect(CONTROLLER.slice(i, i + 700)).toContain('quienDecide(req)');
    }
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
  /**
   * `[GX.68]` La resolución salió de adentro de la guarda a `identidadConNombre()`, porque
   * ahora la usan DOS caminos: ésta (nadie decide su propio vale) y el alcance con que se
   * abre el expediente. Dos copias de esta resolución se desincronizan a la primera.
   */
  const resolutor = SERVICIO.slice(SERVICIO.indexOf('private async identidadConNombre('),
    SERVICIO.indexOf('private async asegurarQueNoEsSuyo('));

  it('si el token no trae nombre, lo busca en el padrón por username', () => {
    expect(resolutor).toContain("trx('users')");
    expect(resolutor).toContain(".whereRaw('lower(username) = lower(?)', [usuario])");
    expect(resolutor).toContain(".first('nombre')");
  });

  it('compara con el nombre resuelto, no con el que vino en el token', () => {
    expect(guarda).toContain('const yo = await this.identidadConNombre(trx, quien)');
    expect(guarda).toContain('esDuenoDelVale(vale, yo)');
  });

  /**
   * ⭐ `[GX.68]` El candado que el extracto hace necesario: la resolución tiene que ser **una
   * sola**. Si alguien vuelve a escribirla inline en cualquiera de los dos caminos, acá se ve.
   */
  it('⭐ la resolución del padrón vive en UN solo lugar', () => {
    expect((SERVICIO.match(/\.first\('nombre'\)/g) || []).length).toBe(1);
    expect((SERVICIO.match(/this\.identidadConNombre\(/g) || []).length).toBe(2);
  });
});
