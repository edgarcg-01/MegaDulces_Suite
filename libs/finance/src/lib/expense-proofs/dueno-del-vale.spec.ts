import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.34]` — Candado de **quién es dueño de un vale**, que es lo que decide qué ve cada
 * persona en «Mis gastos».
 *
 * ## La regla, textual del usuario
 * *«el usuario que suba la evidencia de un vale lo hará como de su propiedad y es cuando
 * aparece en la sección de mis gastos, no deben aparecer los de todos»*.
 *
 * ## Los dos huecos que `created_by` no cubría
 *  · **Evidencia posterior** (`addEvidence`): el gasto se aprueba sin comprobante y lo sube
 *    alguien después — puede no ser quien lo levantó, y esa persona no lo veía en ningún lado.
 *  · **Captura por link**: `created_by` queda como `link:JUAN PEREZ`, que no es un usuario.
 *    Ese expediente no aparecía en «Mis gastos» de nadie.
 *
 * ## ⛔ Lo que NO puede pasar, y es lo que este archivo vigila
 * Que el recorte se afloje. «Mis gastos» **no puede** devolver la bandeja de la empresa: si
 * el filtro desaparece, la pantalla se ve igual de bien y nadie se entera — sólo que ahora
 * cada cajero lee el gasto de todos.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const BRK = String.fromCharCode(10);
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
const CONTROLLER = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.controller.ts'), 'utf8'));

const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};

describe('[GX.34] «Mis gastos» no puede devolver los de todos', () => {
  /**
   * ⭐ La prueba que sostiene todo. Si alguien quita este `where`, la ruta sigue
   * respondiendo 200 y con datos — pero con los de la empresa entera.
   */
  it('la lista filtra por persona cuando se pide «lo mío»', () => {
    expect(SERVICIO).toContain("if (q.mine) b.where(");
    expect(SERVICIO).toContain("w.where('created_by', q.mine).orWhere('evidencia_por', q.mine)");
  });

  it('el calendario usa EL MISMO criterio que la lista', () => {
    expect(SERVICIO).toContain("w.where('created_by', opts.mine).orWhere('evidencia_por', opts.mine)");
  });

  /**
   * ⛔ Sin actor NO se cae a sin-filtro. Un `where('created_by', '')` devolvería cero, pero
   * un `if` que no se ejecuta devuelve TODO — y ésa es la diferencia entre una lista vacía
   * y una fuga.
   */
  it('sin actor devuelve vacío, no la bandeja entera', () => {
    const cuerpo = metodo(CONTROLLER, 'async mine(');
    expect(cuerpo).toContain('if (!actor) return');
    expect(cuerpo).toContain('rows: []');
  });

  /** El recorte vive en el SERVIDOR: el cliente no manda a quién mirar. */
  it('el alcance no viaja como parámetro', () => {
    const cuerpo = metodo(CONTROLLER, 'async mine(');
    expect(cuerpo).toContain("req?.user?.full_name || req?.user?.username");
    expect(cuerpo).not.toContain("@Query('mine')");
  });
});

describe('[GX.34] quien sube la evidencia se queda con el vale', () => {
  /** El camino que `created_by` no cubría: la evidencia que llega después de aprobar. */
  it('subir la evidencia posterior marca al dueño', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).toContain('evidencia_por: actor || null,');
    expect(cuerpo).toContain('evidencia_at: trx.fn.now(),');
  });

  /**
   * ⛔ **`created_by` NO se reescribe.** Sería más corto y destruiría el rastro: es quién
   * levantó el gasto, que es lo que una auditoría busca cuando pregunta de dónde salió el
   * expediente. Dos hechos distintos, dos columnas.
   */
  it('NO se pisa quién levantó el gasto', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).not.toContain('created_by:');
  });

  /** En el alta también se escribe, para que la regla sea UNA sola y no «según por dónde entró». */
  it('el alta con evidencia también marca al dueño', () => {
    const cuerpo = metodo(SERVICIO, 'async create(');
    expect(cuerpo).toContain("files.some((f) => String(f.role).startsWith('comprobante'))");
    expect(cuerpo).toContain('evidencia_por: actor || null,');
  });

  /**
   * ⚠️ Un alta SIN comprobante no marca dueño de evidencia — porque no hubo evidencia. El
   * vale sigue siendo visible por `created_by`; lo que no se hace es afirmar que alguien
   * subió algo que no subió.
   */
  it('sin comprobante no se inventa un dueño de evidencia', () => {
    const cuerpo = metodo(SERVICIO, 'async create(');
    expect(cuerpo).toContain('            : {}),');
  });
});
