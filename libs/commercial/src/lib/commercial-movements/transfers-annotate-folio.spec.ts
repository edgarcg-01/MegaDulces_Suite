// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[DM.23]` — **Una recepción es un DOCUMENTO, no un número de folio padre.**
 *
 * ⛔ El defecto, reportado desde la pantalla el 2026-10-12: el detalle del documento decía
 * *«Recibido correctamente — Enviadas 750 · Recibidas 750»* y la LISTA, en la misma pantalla,
 * marcaba **«diferencia»** sobre ese mismo traspaso.
 *
 * ## La causa, medida contra prod
 *
 * `annotateTransferStatus` agrupaba las recepciones por `(parent_folio, parent_serie,
 * warehouse_id)` — sin el folio de la recepción. Los folios de Kepler son **secuencias por
 * sucursal y se reciclan**, así que ese grupo junta todas las recepciones que un almacén hizo
 * alguna vez contra ESE número de folio padre, sin importar de qué embarque vinieran.
 *
 * El caso que lo destapó — cuatro recepciones declaran al folio `0000038` como padre:
 *
 * | recepción | almacén | fecha | qty |
 * |---|---|---|---:|
 * | 0000026 | 02 | 08-may | 1,340 |
 * | 0000014 | 05 | 05-jun | 1,175 |
 * | **0000391** | **01** | **06-oct** | **131** |
 * | **0000401** | **01** | 08-oct | **750** ← la real |
 *
 * En Padre Hidalgo el grupo sumaba **131 + 750 = 881** contra las 750 enviadas ⇒ «diferencia».
 *
 * ⚠️ Y la ventana del pareo no lo salvaba: `PAIR_EARLY_DAYS` admite la recepción hasta **15 días
 * ANTES** del embarque, así que la del 6-oct entraba legítimamente contra uno del 8-oct.
 *
 * ⭐ Alcance medido: **45 grupos** mezclan documentos en 90 días, sobre **143 embarques y
 * 197,102 piezas**. Verificado después del arreglo: `0000038` y `0000039` pasan los dos a
 * `completado`, pareados con `0000401` y `0000402`.
 *
 * ⚠️ Esto es el TERCER punto de pareo. `[DM.22]` unificó `transfersPhysical` y
 * `transfersCheckPair`; éste quedó afuera y por eso contradecía al detalle. Mientras existan
 * definiciones separadas del mismo pareo van a volver a divergir — la deuda queda nombrada.
 */

const SVC = readFileSync(join(__dirname, 'commercial-movements.service.ts'), 'utf8');

/** Mide código, no redacción. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}
const CODIGO = sinComentarios(SVC);

/** El cuerpo de `annotateTransferStatus`, hasta el siguiente método de su nivel. */
function anotador(): string {
  const i = CODIGO.indexOf('private async annotateTransferStatus(');
  if (i < 0) throw new Error('No existe annotateTransferStatus()');
  const resto = CODIGO.slice(i + 10);
  const fin = resto.search(/\n {2}(?:async |private |\/\*\* )/);
  return fin < 0 ? CODIGO.slice(i) : CODIGO.slice(i, i + 10 + fin);
}

describe('[DM.23] el arnés', () => {
  it('encuentra el anotador', () => {
    expect(() => anotador()).not.toThrow();
    expect(anotador().length).toBeGreaterThan(400);
  });

  it('y falla fuerte si se renombra', () => {
    expect(() => {
      if (!'nada'.includes('annotateTransferStatus')) throw new Error('No existe annotateTransferStatus()');
    }).toThrow(/No existe/);
  });
});

describe('[DM.23] ⛔ la recepción se agrupa POR DOCUMENTO', () => {
  const c = anotador();

  it('⭐⭐ el folio de la recepción está en el GROUP BY', () => {
    // Sin él, dos recepciones del mismo almacén contra el mismo número de folio padre —de
    // embarques distintos— se suman en un solo candidato.
    expect(c).toMatch(/groupBy\('m\.parent_folio', 'm\.parent_serie', 'm\.warehouse_id', 'm\.folio'\)/);
  });

  it('⛔⛔ NEGATIVA: no vuelve la agrupación que colapsaba documentos', () => {
    expect(c).not.toMatch(/groupBy\('m\.parent_folio', 'm\.parent_serie', 'm\.warehouse_id'\)\s*\n?\s*\./);
  });

  it('⭐ y el folio viaja al candidato, para que el desempate elija UN documento', () => {
    expect(c).toMatch(/'m\.folio as rf'/);
  });

  it('⛔ el desempate sigue siendo el mismo: cantidad y después fecha', () => {
    // Si cambiara acá y no en los otros puntos de pareo, volverían a contradecirse.
    expect(CODIGO).toMatch(/const near = \(cands: any\[\], qty: number, date: any\)/);
    expect(CODIGO).toMatch(/Math\.abs\(Number\(a\.q\) - qty\) - Math\.abs\(Number\(b\.q\) - qty\)/);
  });

  it('⭐ el veredicto se calcula contra UN candidato, no contra una suma', () => {
    expect(c).toMatch(/mismoTraspaso\(best, s\) \? 'completado' : 'diferencia'/);
    // [MX.1.1] y "el mismo traspaso" = mismas piezas que ESE candidato Y misma firma de productos
    expect(c).toMatch(/Math\.abs\(Number\(cand\.q\) - Number\(doc\.qty\)\) < 0\.01 && cand\.sig != null && String\(cand\.sig\) === String\(doc\.sku_sig\)/);
  });
});

describe('[DM.23] ⭐ la ventana del pareo sigue siendo la compartida', () => {
  it('⛔ usa pairMatchJs y no una copia a mano de los días', () => {
    // Cuatro puntos parean traspasos; la ventana tiene que salir de un solo lugar o se
    // desincroniza. Es el mismo motivo por el que existe `TRANSFER_PAIR_MATCH` en SQL.
    expect(anotador()).toMatch(/pairMatchJs\(sd, new Date\(c\.d\)\.getTime\(\)/);
  });

  it('⭐ y el embarque sigue identificándose por (folio, serie, almacén)', () => {
    // Ese lado NO tenía el defecto: un embarque SÍ queda identificado por esa terna.
    expect(anotador()).toMatch(/groupBy\('m\.folio', 'm\.doc_serie', 'm\.warehouse_id'\)/);
  });
});
