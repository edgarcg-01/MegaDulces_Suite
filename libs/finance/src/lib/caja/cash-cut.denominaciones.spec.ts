import { denomKeyDeValor } from '@megadulces/contracts';
import {
  DenominacionFueraDeCatalogo,
  filasDenominacion,
  type FilaDenominacion,
} from './cash-cut.engine';

/**
 * ⛔⛔ `[CG.155]` **El candado que faltaba las dos veces que se cayó producción.**
 *
 * 2026-10-13: `POST /cortes/:id/contar` → 500, `null value in column "denom_key"`.
 * 2026-10-14: `POST /cortes/:id/cerrar` → **el error idéntico**, un día después de arreglar
 * `contar`. Eran tres caminos de escritura y la migración actualizó uno.
 *
 * ⚠️ Lo que NO alcanzaba: `test-newdb-cash-ledger-cuts.js` estaba verde **porque escribe el conteo
 * directo a la tabla y nunca llama al servicio**. Un candado que no pasa por el código que falla
 * mide otra cosa.
 *
 * Acá se prueba la función pura que arma los renglones; el otro medio del par —que esos renglones
 * los acepte la base real, con sus `CHECK` y su llave primaria— se ejerció contra producción
 * dentro de una transacción revertida el 2026-10-14, incluida la prueba negativa que reprodujo
 * `23502` con el payload viejo.
 */
describe('[CG.155] filasDenominacion', () => {
  const T = '00000000-0000-0000-0000-00000000d01c';
  const C = '11111111-1111-1111-1111-111111111111';
  const armar = (
    conteo: Array<{ denominacion: number; piezas: number; denom_key?: string | null }> | null | undefined,
    momento: 'apertura' | 'cierre' = 'cierre',
  ) => filasDenominacion(T, C, momento, conteo, denomKeyDeValor);

  it('⛔ PRUEBA NEGATIVA: ninguna fila sale sin `denom_key` ni sin `momento`', () => {
    // Es la aserción que da sentido a todas las demás: el payload viejo de `cerrar()` mandaba
    // sólo `{denominacion, piezas}` y la base lo rechazaba con 23502. Si esta prueba puede pasar
    // con una fila incompleta, no está midiendo el defecto que tiró producción.
    const filas = armar([
      { denominacion: 500, piezas: 2 },
      { denominacion: 0.5, piezas: 10 },
    ]);
    expect(filas).toHaveLength(2);
    for (const f of filas) {
      expect(f.denom_key).toBeTruthy();
      expect(f.momento).toBe('cierre');
      expect(f.tenant_id).toBe(T);
      expect(f.cut_id).toBe(C);
    }
  });

  it('⭐ el billete de $20 y la moneda de $20 son DOS renglones, no una colisión de llave', () => {
    // `denominacion` sola no identifica. Si los dos derivaran a la misma llave, el insert violaría
    // la PK `(tenant_id, cut_id, momento, denom_key)` y el arqueo volvería a caerse — esta vez con
    // 23505 en vez de 23502.
    const filas = armar([
      { denominacion: 20, piezas: 3, denom_key: '20' },
      { denominacion: 20, piezas: 4, denom_key: '20m' },
    ]);
    const llaves = filas.map((f) => f.denom_key);
    expect(new Set(llaves).size).toBe(2);
    expect(llaves).toEqual(['20', '20m']);
  });

  it('un $20 SIN llave se deriva a billete — se asume y por eso se declara en el docstring', () => {
    expect(armar([{ denominacion: 20, piezas: 1 }])[0].denom_key).toBe('20');
  });

  it('las piezas en cero no se guardan: no se contó ≠ se contó cero', () => {
    expect(armar([{ denominacion: 100, piezas: 0 }, { denominacion: 50, piezas: 2 }])).toHaveLength(1);
  });

  it('una denominación fuera del catálogo PARA, no inventa una llave', () => {
    expect(() => armar([{ denominacion: 37, piezas: 1 }])).toThrow(DenominacionFueraDeCatalogo);
  });

  it('un conteo vacío o ausente no produce renglones (y no revienta)', () => {
    expect(armar([])).toEqual([]);
    expect(armar(null)).toEqual([]);
    expect(armar(undefined)).toEqual([]);
  });

  it('la apertura y el cierre se marcan distinto: son dos momentos de la misma caja', () => {
    const ap: FilaDenominacion[] = armar([{ denominacion: 500, piezas: 2 }], 'apertura');
    expect(ap[0].momento).toBe('apertura');
    // Y por eso el borrado del cierre tiene que ir acotado por `momento`: sin eso, guardar el
    // cierre se lleva el desglose con el que arrancó la caja. Verificado contra la base real.
    expect(armar([{ denominacion: 500, piezas: 2 }], 'cierre')[0].momento).toBe('cierre');
  });
});
