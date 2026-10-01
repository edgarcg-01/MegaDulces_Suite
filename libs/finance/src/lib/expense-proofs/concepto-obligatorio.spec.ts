import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { faltaParaMandar } from '@megadulces/contracts';

/**
 * `[GX.57]` — **El concepto del gasto es obligatorio, y el servidor lo exige.**
 *
 * Pedido textual del usuario (2026-10-01): *«aqui en donde dice concepto opcional, debe ser
 * obligatorio escribir concepto»*.
 *
 * ## Qué cubre este archivo que NO cubre la prueba del contrato
 * La regla vive en `faltaParaMandar()` y ahí se prueba sola. Lo que puede fallar de este lado
 * es el **cableado**: que `create()` le pase el concepto al estado que arma. Son dos líneas, y
 * las dos tienen una forma de romperse que no se ve:
 *
 *  1. **Si NO se lo pasa**, el estado llega sin concepto y el faltante sale SIEMPRE → todo
 *     POST muere en un 400. Ruidoso, pero sólo contra la API real: ninguna prueba de unidad
 *     del servicio lo ejercía.
 *  2. **Si vuelve el `if` suelto** que exigía el motivo nada más al gasto no comprobable, hay
 *     otra vez dos reglas — y la de acá volvería a ser más floja que la del contrato para
 *     todo lo que la captura genera hoy, que es `no_comprobable` por GX.19.
 *
 * ## Por qué es un candado de TEXTO
 * Igual que `dueno-del-vale.spec.ts`, `respaldo-autorizacion.spec.ts` y
 * `provisional-vuelve.spec.ts`: la línea vive en medio de `create()`, que arma el documento
 * contra knex. Montar eso probaría a knex. Lo que hay que impedir es que alguien «limpie» el
 * cableado y la compuerta quede encendida en el contrato y apagada en el servidor.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));

const BRK = String.fromCharCode(10);
const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};

describe('[GX.57] el servidor exige el concepto', () => {
  /** ⭐ Sin esta línea, la compuerta nueva rebota TODO alta. */
  it('`create()` le pasa el concepto a la compuerta compartida', () => {
    const cuerpo = metodo(SERVICIO, 'async create(');
    expect(cuerpo).toContain('faltaParaMandar({');
    expect(cuerpo).toContain('concepto: motivo,');
  });

  /**
   * ⛔ La regla vieja de la CAPTURA: el motivo exigido sólo al gasto no comprobable. Si
   * vuelve, hay dos reglas otra vez y ésta es la floja.
   *
   * ⚠️ **Acotado a `create()` a propósito, y lo encontró esta prueba.** Escrita contra el
   * archivo entero salía roja: el mismo mensaje existe DOS veces más, en `approve()` y en
   * `validate()`. No son copias de ésta — son el guard de quien FIRMA, para cuando el
   * aprobador reclasifica el gasto a `no_comprobable` y entonces tiene que decir por qué.
   * Otro momento, otro actor, otra regla: borrarlas de arrastre habría abierto un hueco en
   * la aprobación por «ordenar» la captura.
   */
  it('ya no queda un segundo candado del motivo en la CAPTURA', () => {
    const cuerpo = metodo(SERVICIO, 'async create(');
    expect(cuerpo).not.toContain('un gasto no comprobable exige un motivo');
    expect(cuerpo).not.toMatch(/if\s*\(!llevaEvidencia\s*&&\s*!motivo\)/);
  });

  /** ⭐ Y los otros dos SIGUEN en pie: esta fase no los tocó. */
  it('el guard de quien firma no se perdió al mudar la regla de la captura', () => {
    for (const m of ['async approve(', 'async validate(']) {
      expect(metodo(SERVICIO, m), m).toContain('un gasto no comprobable exige un motivo');
    }
  });

  /**
   * El estado que arma `create()` tiene que producir el faltante cuando el concepto viene
   * vacío. Se ejercita la función REAL —no una copia— con la misma forma de estado.
   */
  it('con el concepto vacío, la compuerta que lee el servidor devuelve el faltante', () => {
    const base = {
      forma_pago: 'efectivo',
      forma_pago_detalle: 'Caja chica',
      archivos: [{ role: 'comprobante_1', live: true }],
      exige_evidencia: true,
    };
    expect(faltaParaMandar({ ...base, concepto: '' }).map((f) => f.id)).toEqual(['concepto']);
    // ⭐ Prueba negativa: con concepto NO sobra ningún faltante. Sin esto, una compuerta que
    // devuelve algo siempre pasaría este archivo en verde.
    expect(faltaParaMandar({ ...base, concepto: 'Garrafones para la oficina' })).toEqual([]);
  });

  /**
   * ⚠️ `addEvidence()` filtra la lista a los faltantes de evidencia, así que el concepto no
   * puede colarse ahí y trabar la subida del comprobante de un vale YA aprobado — que no
   * tiene por qué volver a escribirlo.
   */
  it('subir la evidencia después NO queda trabado por el concepto', () => {
    const cuerpo = metodo(SERVICIO, 'async addEvidence(');
    expect(cuerpo).toContain("f.id === 'evidencia'");
    expect(cuerpo).not.toContain("f.id === 'concepto'");
  });
});
