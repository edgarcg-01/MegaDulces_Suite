import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.33]` — Candado de **la visión que avisa pero no manda**.
 *
 * ## Las dos versiones de este archivo, y por qué cambió
 * En `[GX.32]` este candado vigilaba que Claude Vision estuviera **fuera**. El usuario pidió
 * después que volviera, con tres condiciones: que **avise**, que **nunca frene** y que el
 * gasto se pueda mandar **aunque la visión no lo pueda leer**. Así que lo que se vigila ya
 * no es la ausencia: es el **contrato**.
 *
 * Lo que NO vuelve, y es la mitad que importa:
 *  · la visión **no decide el estado** — quién cierra y en qué estado lo resuelve una persona;
 *  · **no firma** — `validated_by: 'Claude Vision'` fue una decisión sobre dinero firmada por
 *    una máquina, y eso quedó retirado para siempre;
 *  · **no bloquea** — ni falta de API key, ni archivo ilegible, ni una excepción del modelo
 *    pueden impedir levantar un gasto.
 *
 * ## Por qué sobre el TEXTO
 * Lo que hay que impedir es que alguien **vuelva a darle la decisión**, y eso no lo ve
 * ninguna prueba de comportamiento: el módulo funciona igual de bien con la visión mandando.
 *
 * ⚠️ Se mira el CÓDIGO, no los comentarios — la primera versión de este archivo se puso roja
 * contra un servicio ya limpio porque encontraba **la explicación** de lo que se había ido.
 * Un candado de texto que lee comentarios se dispara justo cuando el trabajo está bien hecho,
 * y la salida para eso es borrar la explicación.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // bloques /* … */ y JSDoc
  .replace(/^\s*\/\/.*$/gm, '');      // líneas // …

const leer = (f: string) => soloCodigo(readFileSync(join(__dirname, f), 'utf8'));
const SERVICIO = leer('expense-proofs.service.ts');

/**
 * El cuerpo de UN método, de su declaración a su llave de cierre (la que está a dos
 * espacios). ⚠️ Antes esto cortaba «los próximos 3000 caracteres» y se pasaba de largo:
 * la prueba de que el lector no lanza excepciones encontraba el `throw` del método
 * siguiente y se ponía roja con el código bien.
 */
const BRK = String.fromCharCode(10);   // el salto, sin escaparlo dentro del literal
const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};
const LINKS = leer('expense-capture-links.service.ts');

describe('[GX.33] la visión avisa', () => {
  it('existe un único lector, y su nombre dice para qué es', () => {
    expect(SERVICIO).toContain('private async leerParaAvisar(');
    // Devuelve una leyenda o nada: no un veredicto, no un estado.
    expect(SERVICIO).toContain('Promise<string | null>');
  });

  /** Se la llama en los DOS momentos en que entra la evidencia, no en uno. */
  it('se consulta al aprobar y al subir la evidencia', () => {
    const usos = SERVICIO.match(/this\.leerParaAvisar\(/g) || [];
    expect(usos.length).toBe(2);
  });

  /**
   * ⭐ Lo que no se puede leer se DECLARA. Devolver `null` en silencio haría que el
   * expediente llegue sin aviso, y un expediente sin aviso se lee como «lo miraron y estaba
   * bien» — cuando nadie lo miró (ADR-056).
   */
  it('cuando no puede leer, lo dice en vez de callarse', () => {
    expect(SERVICIO).toContain('const AVISO_ILEGIBLE =');
    const cuerpo = metodo(SERVICIO, 'private async leerParaAvisar(');
    // En el catch y cuando el archivo no se pudo traer.
    expect((cuerpo.match(/AVISO_ILEGIBLE/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  /** ⛔ Que la visión falle no puede tumbar el alta: la excepción se traga y se sigue. */
  it('una excepción del modelo NO frena el gasto', () => {
    const cuerpo = metodo(SERVICIO, 'private async leerParaAvisar(');
    expect(cuerpo).toContain('} catch (e) {');
    expect(cuerpo).not.toContain('throw');
  });
});

describe('[GX.33] pero NO manda', () => {
  /** ⭐ La regla que da nombre a todo esto. Si vuelve, una máquina firma dinero. */
  it('nadie vuelve a escribir «Claude Vision» como quien validó', () => {
    for (const [nombre, src] of [['servicio', SERVICIO], ['links', LINKS]] as const) {
      expect([nombre, /validated_by:[^\n]*'Claude Vision'/.test(src)]).toEqual([nombre, false]);
    }
  });

  /**
   * El estado se decide ANTES de consultar a la visión. Si alguien mueve la llamada arriba
   * y le deja tocar `nextStatus`, esto se cae.
   */
  it('el estado se resuelve sin la visión', () => {
    const cuerpo = metodo(SERVICIO, 'async approve(');
    const posEstado = cuerpo.indexOf("nextStatus = 'validada';");
    const posVision = cuerpo.indexOf('this.leerParaAvisar(');
    expect(posEstado).toBeGreaterThan(0);
    expect(posVision).toBeGreaterThan(posEstado);   // primero la persona, después el aviso
    expect(cuerpo).toContain('validated_by: cierra ? (actor || null) : null,');
  });

  /** La evidencia posterior a la aprobación la mira una persona, diga lo que diga la visión. */
  it('la evidencia posterior queda en revision, siempre', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).toContain("const status = 'revision';");
    expect(cuerpo).toContain('validated_by: null,');
  });

  /** ⛔ Las cuatro piezas que DECIDÍAN no volvieron con el lector. */
  it('el cuadre que decidía no volvió', () => {
    for (const pieza of ['serverReadReceipt', 'montoCuadra', 'async validatePhoto']) {
      expect([pieza, SERVICIO.includes(pieza)]).toEqual([pieza, false]);
    }
  });

  /** La captura por link sigue sin cuadre: es superficie pública, siempre la ve un humano. */
  it('la captura por link no recupera el cuadre', () => {
    expect(LINKS).not.toContain('private async leerTicket(');
    expect(LINKS).toContain('leerTicketPreview');   // el prellenado sí sigue
  });
});

describe('[GX.33] el tipo de archivo se deduce del archivo', () => {
  /**
   * ⚠️ `putFile` sólo sabe de pdf e imagen: todo lo demás volvía como `image` y el visor lo
   * pintaba con `<img>` — un recuadro roto, que se lee como «el archivo no está».
   */
  it('hay un resolvedor propio con los tres casos', () => {
    expect(SERVICIO).toContain("function tipoDeArchivo(dataUri: string): 'pdf' | 'image' | 'otro'");
    expect(SERVICIO).toContain('kind: tipoDeArchivo(dataUri)');
  });

  /** ⛔ A un `.docx` no se le pide visión: no es ilegible, es otra cosa. */
  it('la visión sólo se le pide a una imagen o un PDF', () => {
    const cuerpo = metodo(SERVICIO, 'private async leerParaAvisar(');
    expect(cuerpo).toContain("comp.kind !== 'image' && comp.kind !== 'pdf'");
  });
});
