import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esDuenoDelVale } from '@megadulces/contracts';

/**
 * `[PC.4]` Cableado de «nadie valida ni rechaza el comprobante que él mismo adjuntó» en pagos a
 * proveedor. La regla de identidad es la de GX.65.4a (`libs/contracts`, probada allá); aquí se
 * prueba que el servicio y el controller de verdad la aplican.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.service.ts'), 'utf8'));
const CONTROLLER = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.controller.ts'), 'utf8'));

describe('[PC.4] la guarda está en validar y rechazar', () => {
  const cuerpo = (decl: string) => {
    const i = SERVICIO.indexOf(decl);
    return i < 0 ? '' : SERVICIO.slice(i, i + 900);
  };

  for (const decl of ['async validate(', 'async reject(']) {
    it(`${decl} llama a la guarda ANTES de escribir`, () => {
      const c = cuerpo(decl);
      const guarda = c.indexOf('this.asegurarQueNoEsSuyo(trx, id, quien)');
      expect(guarda).toBeGreaterThan(0);
      expect(guarda).toBeLessThan(c.indexOf('.update('));
    });
  }

  const guarda = SERVICIO.slice(SERVICIO.indexOf('private async asegurarQueNoEsSuyo('), SERVICIO.indexOf('async validate('));

  it('⛔ sin identidad la guarda niega', () => {
    expect(guarda).toContain("throw new ForbiddenException('No se pudo identificar quién decide sobre el comprobante.')");
  });

  it('el dueño es quien adjuntó (created_by) y el nombre sale del padrón si el token no lo trae', () => {
    expect(guarda).toContain(".first('created_by')");
    expect(guarda).toContain("trx('users')");
    expect(guarda).toContain(".whereRaw('lower(username) = lower(?)', [usuario])");
    expect(guarda).toContain('esDuenoDelVale({ created_by: proof.created_by }, { username: usuario, full_name: nombre })');
  });

  it('el controller manda las dos identidades en las dos rutas', () => {
    expect(CONTROLLER).toContain('const quienDecide = (req?: AuthedRequest) => ({ username: req?.user?.username, full_name: req?.user?.full_name })');
    expect((CONTROLLER.match(/quienDecide\(req\)/g) || []).length).toBe(2);
  });
});

/** La regla compartida aplicada al caso de pagos: el comprobante sólo tiene un dueño. */
describe('[PC.4] la regla con el dueño de un comprobante', () => {
  it('quien adjuntó con su username y decide ya con nombre cargado → es suyo', () => {
    expect(esDuenoDelVale({ created_by: 'david_cisneros' }, { username: 'david_cisneros', full_name: 'David Cisneros' })).toBe(true);
  });
  it('quien adjuntó con su nombre y el token sólo trae username, pero el padrón da el nombre → es suyo', () => {
    expect(esDuenoDelVale({ created_by: 'David  Cisneros' }, { username: 'dcis', full_name: 'david cisneros' })).toBe(true);
  });
  it('otra persona → no es suyo', () => {
    expect(esDuenoDelVale({ created_by: 'David Cisneros' }, { username: 'felipe', full_name: 'Felipe Ruiz' })).toBe(false);
  });
  it('comprobante sin created_by (legacy) → nadie es dueño de «nada»', () => {
    expect(esDuenoDelVale({ created_by: null }, { username: 'felipe', full_name: 'Felipe Ruiz' })).toBe(false);
  });
});
