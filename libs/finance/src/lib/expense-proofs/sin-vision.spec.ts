import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.32]` — Candado de **la visión fuera del camino de la evidencia**.
 *
 * ## Qué se retiró, y por qué esto es un candado y no una prueba de comportamiento
 * Claude Vision leía la foto del comprobante y **decidía**: si el monto cuadraba contra la
 * solicitud, el expediente cerraba solo en `validada` y quedaba firmado
 * `validated_by: 'Claude Vision'`. Se retiró por pedido del usuario (2026-09-28).
 *
 * Lo que hay que impedir no es un cálculo mal hecho: es que alguien **vuelva a cablearlo**.
 * Eso no lo ve ninguna prueba de comportamiento —el módulo funciona igual de bien con la
 * visión adentro— así que se vigila sobre el texto, como `respaldo-autorizacion.spec.ts`.
 *
 * ## ⛔ Lo que NO se tocó, a propósito
 * · `leerTicketPreview()` de la captura por link: **prellena campos** para el trabajador.
 *   Es una propuesta editable, no una regla que decida sobre dinero.
 * · El módulo hermano `expense-comprobaciones` (GX.8) conserva su propio `validate-photo`.
 * · Las columnas `monto_ocr`, `monto_match` y `revision_nota`: hay expedientes cerrados con
 *   esos números. Se conservan y dejan de escribirse — borrarlas reescribiría el historial.
 */

/**
 * ⚠️ **Se mira el CÓDIGO, no los comentarios** — y esto costó una corrida en rojo.
 *
 * La primera versión de este candado buscaba `'Claude Vision'` y `serverReadReceipt` en el
 * archivo entero, y se puso roja contra un servicio del que ya se habían ido las dos cosas:
 * lo que encontraba eran **los comentarios que explican que se fueron**. Un candado de texto
 * que lee los comentarios se dispara justo cuando el trabajo está bien hecho, y la salida
 * para eso es borrar la explicación — o sea, lo contrario de lo que se quiere.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // bloques /* … */ y JSDoc
  .replace(/^\s*\/\/.*$/gm, '');       // líneas // …

const leer = (f: string) => soloCodigo(readFileSync(join(__dirname, f), 'utf8'));
const SERVICIO = leer('expense-proofs.service.ts');
const CONTROLLER = leer('expense-proofs.controller.ts');
const LINKS = leer('expense-capture-links.service.ts');

describe('[GX.32] ninguna decisión sobre el gasto la firma una máquina', () => {
  /**
   * ⭐ La que más importa. `validated_by: 'Claude Vision'` quedaba escrito en la fila: el
   * expediente decía que lo había cerrado un modelo. Ahora cierra la persona que aprueba.
   */
  it('nadie vuelve a escribir «Claude Vision» como quien validó', () => {
    for (const [nombre, src] of [['servicio', SERVICIO], ['links', LINKS]] as const) {
      expect([nombre, src.includes("validated_by: cuadra ? 'Claude Vision'")]).toEqual([nombre, false]);
      expect([nombre, /validated_by:[^\n]*'Claude Vision'/.test(src)]).toEqual([nombre, false]);
    }
  });

  it('el servicio ya no inyecta el lector de visión', () => {
    expect(SERVICIO).not.toContain('LlmExtractorService');
    expect(SERVICIO).not.toContain('this.ocr.');
  });

  /** Las cuatro piezas del cuadre. Un método sin quien lo llame invita a recablearlo. */
  it('las piezas del cuadre no volvieron', () => {
    for (const pieza of ['serverReadReceipt', 'montoCuadra', 'async validatePhoto', 'private tolerancia']) {
      expect([pieza, SERVICIO.includes(pieza)]).toEqual([pieza, false]);
    }
  });

  /** Su endpoint tampoco: llamarlo daría 404, y un endpoint muerto se lee como vivo. */
  it('el endpoint de la vista previa no existe en expense-proofs', () => {
    expect(CONTROLLER).not.toContain("@Post('validate-photo')");
  });

  /**
   * ⚠️ El camino por link NUNCA cerró solo (superficie pública), pero sí escribía el cuadre.
   * Si vuelve, esas tres columnas las llenaría un camino y ningún otro — y `revision_nota`
   * diría «el monto no cuadra» sólo para los gastos que entraron por ahí.
   */
  it('la captura por link tampoco cuadra por visión', () => {
    expect(LINKS).not.toContain('private async leerTicket(');
    expect(LINKS).not.toContain('monto_match: ocr');
  });

  /** ⛔ Prueba de lo que se CONSERVA: sin esto, «quitar la visión» se lee como quitarla toda. */
  it('el prellenado de campos por visión sigue en pie', () => {
    expect(LINKS).toContain('leerTicketPreview');
  });
});

describe('[GX.32] lo que el cuadre decidía, ahora lo decide una persona', () => {
  /**
   * La evidencia que llega DESPUÉS de aprobar no la miró nadie. Cerrarla sola dejaría que
   * quien gastó cierre su propio expediente, que es justo lo que la visión tapaba.
   */
  it('la evidencia posterior a la aprobación queda en revision, siempre', () => {
    const i = SERVICIO.indexOf('async addEvidence(');
    expect(i).toBeGreaterThan(0);
    const cuerpo = SERVICIO.slice(i, i + 3000);
    expect(cuerpo).toContain("const status = 'revision';");
    expect(cuerpo).toContain('validated_by: null,');
  });

  /** Y al aprobar con la evidencia a la vista, cierra quien firma — con su nombre. */
  it('aprobar con evidencia cierra en validada, por el actor', () => {
    const i = SERVICIO.indexOf('async approve(');
    const cuerpo = SERVICIO.slice(i, i + 4000);
    expect(cuerpo).toContain('validated_by: cierra ? (actor || null) : null,');
  });
});
