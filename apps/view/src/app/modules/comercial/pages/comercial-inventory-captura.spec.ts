import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `[IC.F7][IC.F8][IC.F9][IC.F14]` — **Frente E de la auditoría del inventario físico**
 * (`docs/MODULOS/inventario-fisico-SOLUCION.md`).
 *
 * ## Qué protege y qué NO afirma
 *
 * El comportamiento de F8 y F9 lo prueba de verdad
 * `shared/directives/cantidad-fisica.directive.spec.ts`, con su control y su prueba negativa. Acá
 * se protege lo otro, que es donde se rompe en silencio: **que el arreglo siga CONECTADO**. Una
 * directiva perfecta que alguien saca de un `imports` deja la pantalla exactamente como estaba, y
 * ninguna prueba de la directiva se entera.
 *
 * ⛔ Lee el fuente. **No monta las pantallas** —arrastran `@zxing/browser`, Capacitor y un socket—,
 * así que no afirma «la captura funciona»: afirma que el freno está puesto y en el orden correcto.
 */

const DIR = __dirname;

/**
 * ⚠️ **Se quita el retorno de carro.** Los componentes están guardados con CRLF, y un ancla
 * escrita acá con salto de línea no macha ni una vez: la prueba negativa sale VERDE porque la
 * mutación no aplicó, o sea sin probar nada. Ya pasó con el candado de `reconcile()`, y volvió a
 * pasar al escribir éste — lo atrapó su propio control, que es para lo que está.
 */
const RETORNO = String.fromCharCode(13);
const leer = (archivo: string): string =>
  readFileSync(join(DIR, archivo), 'utf8').split(RETORNO).join('');

const CONTEO = leer('comercial-inventory-count.component.ts');
const DETALLE = leer('comercial-inventory-session-detail.component.ts');

/** El `error:` de `resolveCode()`, que es donde se decide qué pasa con un código no reconocido. */
function ramaNoReconocido(src: string): string {
  const desde = src.indexOf('private resolveCode()');
  if (desde < 0) return '';
  const hasta = src.indexOf('onQtyKey(', desde);
  if (hasta <= desde) return '';
  return src.slice(desde, hasta);
}

describe('[IC.F7] tras un código no reconocido, el foco vuelve al código', () => {
  const rama = ramaNoReconocido(CONTEO);

  it('CONTROL — el bloque existe, no viene vacío y es UN método, no medio archivo', () => {
    expect(rama, 'no se encontró resolveCode()').not.toBe('');
    expect(rama).toContain('this.notFound.set(true);');
    expect(rama.length, 'el bloque es sospechosamente grande: el ancla falló').toBeLessThan(2500);
  });

  it('⛔ el foco se devuelve DESPUÉS de declarar que no se reconoció', () => {
    const posDeclara = rama.indexOf('this.notFound.set(true);');
    const posFoco = rama.indexOf('this.devolverFocoAlCodigo();');
    expect(posDeclara, 'falta la declaración').toBeGreaterThan(-1);
    expect(posFoco, 'el código no reconocido deja el foco en Cantidad: vuelve F7').toBeGreaterThan(-1);
    expect(posDeclara).toBeLessThan(posFoco);
  });

  it('⛔ SIN RED no se devuelve: ahí «no reconocido» significa «todavía no lo sé»', () => {
    const metodo = CONTEO.slice(CONTEO.indexOf('private devolverFocoAlCodigo()'));
    const posRed = metodo.indexOf('if (!this.offline.online()) return;');
    const posFoco = metodo.indexOf('this.focusCode();');
    expect(posRed, 'falta el freno por red').toBeGreaterThan(-1);
    expect(posFoco).toBeGreaterThan(-1);
    expect(posRed).toBeLessThan(posFoco);
  });

  it('no le arrebata el foco a quien ya está tecleando una cantidad', () => {
    const metodo = CONTEO.slice(CONTEO.indexOf('private devolverFocoAlCodigo()'));
    expect(metodo).toContain('if (this.qty() !== null && this.qty() !== undefined) return;');
    expect(metodo).toContain('document.activeElement !== campo');
  });

  it('PRUEBA NEGATIVA — sin la llamada, el candado se pone ROJO', () => {
    const mutante = rama.split('this.devolverFocoAlCodigo();').join('');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(rama);
    expect(mutante).not.toContain('this.devolverFocoAlCodigo();');
  });
});

describe('[IC.F8][IC.F9] el arreglo de la cantidad sigue CONECTADO en las dos pantallas', () => {
  for (const [pantalla, src] of [['conteo (contador)', CONTEO], ['detalle (supervisor)', DETALLE]] as const) {
    it(`${pantalla}: el campo de cantidad lleva appCantidadFisica y la directiva está declarada`, () => {
      expect(src).toContain('appCantidadFisica');
      expect(src).toContain("from '../../../shared/directives/cantidad-fisica.directive'");
      // Importar sin declarar no hace nada: Angular ignora la directiva en silencio.
      expect(src).toContain('CantidadFisicaDirective,');
    });
  }
});

describe('[IC.F14] la misma cantidad se lee con UN solo formato', () => {
  it('el teórico ya no sale crudo de Postgres (5.000 se leía CINCO MIL)', () => {
    expect(DETALLE).not.toContain('{{ it.expected_qty }}');
    expect(DETALLE).toContain("{{ it.expected_qty | number: '1.0-3' }}");
  });

  it('y los tres conteos, el final y la varianza van con el mismo formato', () => {
    for (const campo of ['count_1', 'count_2', 'count_3', 'final_qty', 'variance']) {
      expect(DETALLE, `${campo} quedó con otro formato`).toContain(`${campo} | number: '1.0-3'`);
    }
  });
});
