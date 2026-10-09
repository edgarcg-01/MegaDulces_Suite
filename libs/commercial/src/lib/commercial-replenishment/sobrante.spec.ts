// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSoloQuedado } from './commercial-replenishment.service';

/**
 * `[RA.SOB]` — El candado del Sobrante (punto 2 de los tres de Edgar).
 *
 * ⚠️ **Qué NO afirma este archivo.** Un doble de Knex no ejecuta SQL, así que acá no se puede
 * comprobar que la consulta devuelva las cifras correctas. Eso se midió contra **prod** y quedó
 * escrito en `FASE_RA` con fecha. Lo que este archivo protege son las decisiones que, si alguien
 * las deshace, **no fallan: mienten**.
 */

const SVC = readFileSync(join(__dirname, 'commercial-replenishment.service.ts'), 'utf8');
const CTRL = readFileSync(join(__dirname, 'commercial-replenishment.controller.ts'), 'utf8');

/** El cuerpo del método `sobrante`, para no medir contra el resto del archivo (4,500 líneas). */
function cuerpoSobrante(): string {
  const i = SVC.indexOf('async sobrante(');
  if (i < 0) throw new Error('No existe el método sobrante()');
  // Hasta el siguiente `async ` de nivel de método, o el fin del archivo.
  const resto = SVC.slice(i + 10);
  const fin = resto.search(/\n {2}(?:async |private |\/\*\* )/);
  return fin < 0 ? SVC.slice(i) : SVC.slice(i, i + 10 + fin);
}

describe('[RA.SOB] el arnés', () => {
  it('encuentra el método y su cuerpo, no el archivo entero', () => {
    const c = cuerpoSobrante();
    expect(c).toContain('async sobrante(');
    expect(c.length).toBeGreaterThan(500);
    expect(c.length).toBeLessThan(SVC.length / 2);
  });

  it('y falla fuerte si el método se renombra', () => {
    const i = SVC.indexOf('async noExisteEsteMetodo(');
    expect(i).toBe(-1);
  });
});

describe('[RA.SOB] qué cuenta como COMPRA — el error que ya cometí midiendo', () => {
  const c = cuerpoSobrante();

  it('⛔ NO usa `qty > 0` para seleccionar entradas', () => {
    // `stock_movements.qty` es la cantidad ABSOLUTA: las SALIDAS también la traen positiva.
    // Filtrar por el signo mete 40,073 "Traspaso a sucursal" del lado de las compras — medido
    // el 2026-10-09, y es exactamente el error que invalidó mi primera medición.
    expect(/qty\s*>\s*0/.test(c)).toBe(false);
  });

  it('⭐ clasifica por `movement_kind`, que es el campo que de verdad lo dice', () => {
    expect(c).toContain(`movement_kind = 'entrada'`);
    expect(c).toContain(`movement_kind = 'salida'`);
  });

  it('la compra son los TRES documentos de compra, ni uno más', () => {
    expect(c).toContain(`'Orden de entrada'`);
    expect(c).toContain(`'Compra'`);
    expect(c).toContain(`'Compra (pedido)'`);
  });

  it('⛔ NEGATIVA: el traspaso recibido NO cuenta como compra', () => {
    // Es mercancía que ya estaba en la red; contarla diría que "compramos" lo que sólo movimos.
    expect(c).not.toContain(`'Recepción de traspaso'`);
  });

  it('⛔ NEGATIVA: la entrada por inventario físico tampoco', () => {
    // Es un ajuste de conteo, no una compra.
    expect(c).not.toContain(`'Inventario físico (entrada)'`);
  });
});

describe('[RA.SOB] el tramo `no_vende` — medir con una vara que no aplica', () => {
  const c = cuerpoSobrante();

  it('⭐⭐ `no_vende` se evalúa ANTES que `sin_venta`', () => {
    // Si el orden se invirtiera, los 259 pares del CEDIS ($10,565,227 medidos el 2026-10-09)
    // volverían a caer en "sin venta" y el tramo publicaría $14.7 M donde en los almacenes que
    // SÍ venden son $4.1 M. No falla: miente, y con una cifra creíble.
    const iNoVende = c.indexOf(`THEN 'no_vende'`);
    const iSinVenta = c.indexOf(`THEN 'sin_venta'`);
    expect(iNoVende).toBeGreaterThan(0);
    expect(iSinVenta).toBeGreaterThan(0);
    expect(iNoVende).toBeLessThan(iSinVenta);
  });

  it('⭐ sale del DATO (`sells_to_public`), no de una lista de códigos de almacén', () => {
    expect(c).toContain('sells_to_public');
    // Un almacén nuevo que no venda entra solo; con una lista habría que acordarse de editarla.
    expect(/code\s*(=|IN)\s*'?\(?'00'/.test(c)).toBe(false);
  });

  it('⛔ y sólo aplica cuando NO hay cobertura: un hub con demanda derivada sí se mide', () => {
    // El CEDIS tiene demanda dependiente en el DRP (RA-PRO.6). Si algún día se puebla, su
    // cobertura es medible y tiene que caer en su tramo real, no en la declaración.
    expect(c).toContain('IS NULL AND');
  });

  it('el tramo viaja con etiqueta, y la etiqueta dice que NO se midió', () => {
    expect(c).toMatch(/no_vende:\s*'[^']*sin medir[^']*'/);
  });
});

describe('[RA.SOB] la cobertura usa la expresión del motor, no una nueva', () => {
  const c = cuerpoSobrante();

  it('divide por `display_bf` con caída a `bf`, como ADR-055', () => {
    expect(c).toContain('display_bf');
  });

  it('⭐ y multiplica por `suf × bf` para pasar la demanda a cajas', () => {
    // Si faltara, la cobertura saldría en una unidad y la existencia en otra: el clásico de esta
    // casa (ADR-055 costó $866,805 de sobre-pedido por exactamente eso).
    expect(c).toMatch(/suf.*\*.*bf/s);
  });

  it('⛔ una cobertura no medible es NULL, nunca 0', () => {
    expect(c).toContain('NULLIF(rp.daily_pieces, 0)');
  });
});

describe('[RA.SOB] una sola consulta, y el CTE materializado', () => {
  const c = cuerpoSobrante();

  it('⭐ el CTE compartido es MATERIALIZED', () => {
    // Sin esto Postgres puede inlinearlo y rebarrer 90 días de movimientos una vez por
    // consumidor: 1.2 s medidos contra los ~400 ms de la versión materializada.
    expect(c).toContain('q AS MATERIALIZED');
  });

  it('el total de la paginación sale de la MISMA consulta', () => {
    expect(c).toContain('count(*) OVER ()');
  });

  it('⛔ y con CERO renglones el resumen se pide aparte — la tira no desaparece', () => {
    // Es justo cuando el comprador filtró y quiere saber por qué no hay nada.
    expect(c).toContain('if (raw.length)');
  });

  it('⚠️ el WHERE del detalle NO se arma con un replace sobre el SQL', () => {
    // `cover` aparece dentro del CASE del tramo; un `.replace()` lo tocaba también.
    expect(c).not.toMatch(/whereDet\.replace/);
    expect(c).toContain(`condDe('q.')`);
  });
});

describe('[RA.SOB] el query param booleano', () => {
  it('ausente → undefined, para que el default lo ponga el servicio y no se repita', () => {
    expect(parseSoloQuedado(undefined)).toBeUndefined();
    expect(parseSoloQuedado(null)).toBeUndefined();
    expect(parseSoloQuedado('')).toBeUndefined();
  });

  it('⛔ "false" y "0" lo APAGAN — `Boolean("false")` es true, y ésa es la trampa', () => {
    expect(parseSoloQuedado('false')).toBe(false);
    expect(parseSoloQuedado('False')).toBe(false);
    expect(parseSoloQuedado('0')).toBe(false);
    expect(parseSoloQuedado('no')).toBe(false);
  });

  it('cualquier otra cosa lo prende', () => {
    expect(parseSoloQuedado('1')).toBe(true);
    expect(parseSoloQuedado('true')).toBe(true);
    expect(parseSoloQuedado('si')).toBe(true);
  });
});

describe('[RA.SOB] la ruta', () => {
  it('existe y pide el permiso del Pedido, no uno nuevo sin repartir', () => {
    const i = CTRL.indexOf(`@Get('sobrante')`);
    expect(i).toBeGreaterThan(0);
    const bloque = CTRL.slice(i, i + 400);
    expect(bloque).toContain('COMPRAS_PEDIDO_VER');
  });

  it('⛔ y el controlador no reimplementa la lectura del booleano', () => {
    // Si la reimplementara, el test de arriba estaría probando una función que nadie usa.
    expect(CTRL).toContain('parseSoloQuedado(solo_quedado)');
  });
});
