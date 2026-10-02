import io from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.59]` **La lectura del comprobante COMPRUEBA; no decide ni firma.**
 *
 * Al subir la evidencia de un gasto, el servidor lee el monto del vale y lo compara con el
 * importe. Eso es todo lo que puede hacer: el expediente queda esperando a una persona.
 *
 * ## ⛔ Por qué esto necesita un candado
 * Antes, si los dos números coincidían, el expediente cerraba solo (`validada`) firmado
 * `validated_by: 'Claude Vision'`. Son dos problemas distintos:
 *
 *  1. **Quien gastó cerraba su propio expediente.** Esta evidencia la sube la misma persona
 *     que hizo el gasto. Que el monto cuadre dice que dos números coinciden — no dice que el
 *     gasto proceda, ni que el comprobante sea de ese gasto, ni que no esté duplicado.
 *  2. **Firmaba con un nombre que no es de nadie.** `validated_by` es el rastro de QUIÉN
 *     autorizó; ponerle el nombre de un modelo deja un expediente sin responsable humano.
 *
 * `[GX.32]` ya había cerrado exactamente este agujero en el módulo hermano
 * (`expense-proofs`). Acá sobrevivió. Este candado existe para que no vuelva por tercera vez.
 *
 * ## Por qué se lee el ARCHIVO y no se monta el servicio
 * El servicio necesita knex, el contexto de tenant, el almacenamiento y el lector LLM. Lo que
 * se afirma acá no es el comportamiento de una consulta: es que **en el código no exista** la
 * rama que cierra sola. Un grep es la forma honesta de comprobar una ausencia — y falla en
 * cuanto alguien la vuelva a escribir, que es justo cuando hace falta.
 */

const RUTA = join(__dirname, 'expense-comprobaciones.service.ts');
const codigo = io.readFileSync(RUTA, 'utf8');

/** El cuerpo, sin comentarios: lo que el programa HACE, no lo que cuenta de sí mismo. */
const soloCodigo = codigo
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

describe('[GX.59] al subir la evidencia, la máquina comprueba pero no decide', () => {
  /** ⭐ El candado central: ningún camino escribe el nombre de un modelo como validador. */
  it('⛔ NADIE firma como «Claude Vision»', () => {
    expect(soloCodigo).not.toContain("'Claude Vision'");
    expect(soloCodigo).not.toContain('"Claude Vision"');
  });

  it('⛔ no hay ninguna rama que cierre en «validada» por el cuadre', () => {
    // La forma vieja era `const status = cuadra ? 'validada' : 'revision'`.
    expect(soloCodigo).not.toMatch(/status\s*=\s*cuadra\s*\?/);
    expect(soloCodigo).not.toMatch(/\?\s*['"]validada['"]\s*:/);
  });

  it('el expediente queda SIEMPRE esperando a una persona', () => {
    expect(soloCodigo).toMatch(/const status = 'revision';/);
  });

  it('⛔ `validated_by` y `validated_at` se escriben en null, no con un veredicto', () => {
    expect(soloCodigo).toMatch(/validated_by:\s*null/);
    expect(soloCodigo).toMatch(/validated_at:\s*null/);
  });

  /**
   * Lo que SÍ se conserva: la lectura. «No decidir» no es «no mirar» — si dejara de leer,
   * quien revisa perdería el único aviso de que el comprobante no cuadra.
   */
  it('sigue leyendo el monto y comparándolo contra el importe', () => {
    expect(soloCodigo).toContain('this.montoCuadra(importe, srv.total, srv.subtotal)');
    expect(soloCodigo).toMatch(/monto_ocr:\s*usado/);
  });

  /** ⚠️ La lectura va del SERVIDOR (`srv`), no del cliente: si no, se falsea desde el navegador. */
  it('el monto comparado es el que leyó el servidor, no el que manda el cliente', () => {
    expect(soloCodigo).toContain('srv.total');
    expect(soloCodigo).not.toMatch(/montoCuadra\(importe,\s*dto\./);
  });

  /**
   * ⛔ Las tres salidas se distinguen. «No se pudo leer» NO es «no cuadra»: la primera la
   * arregla quien sube una foto mejor, la segunda es un problema con el gasto (ADR-056).
   */
  it('distingue «no se pudo leer» de «no cuadra» y de «cuadra»', () => {
    expect(soloCodigo).toContain('No se pudo leer el comprobante');
    expect(soloCodigo).toContain('Monto NO cuadra');
    expect(soloCodigo).toContain('El monto cuadra');
  });

  /** Aun cuando cuadra, la leyenda dice que falta el paso humano: si no, se lee como cerrado. */
  it('cuando cuadra, igual dice que falta aprobarlo', () => {
    const i = soloCodigo.indexOf('El monto cuadra');
    expect(soloCodigo.slice(i, i + 200)).toContain('Falta que alguien lo apruebe');
  });
});
