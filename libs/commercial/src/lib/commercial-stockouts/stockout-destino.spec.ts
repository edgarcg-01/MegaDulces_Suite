import { destinoDe, STOCKOUT_KINDS, type StockoutKind } from './stockout-destino';

/**
 * `[FLT.21]` La regla que decide A QUIÉN le llega cada faltante.
 *
 * Se prueba acá y no contra la base a propósito: es una función pura, y el smoke de DB no puede
 * correr en esta sesión (ninguna base escribible alcanzable). Lo que sí se puede medir, se mide.
 */
describe('destinoDe — a quién le toca un faltante de piso', () => {
  it('no estaba en el anaquel => PISO: la venta todavía no se perdió', () => {
    // Es el caso que justificó el motivo nuevo: hay existencia, sólo falta surtir el anaquel.
    expect(destinoDe('no_en_anaquel', 12)).toBe('piso');
  });

  it('no estaba en el anaquel => PISO aunque la existencia no se haya podido medir', () => {
    // El motivo ya lo dice todo: quien reporta AFIRMA que sí hay en la tienda. No depende del ERP.
    expect(destinoDe('no_en_anaquel', null)).toBe('piso');
    expect(destinoDe('no_en_anaquel', 0)).toBe('piso');
  });

  it('agotado con existencia > 0 => INVENTARIO, no Compras', () => {
    // La persona fue a buscarlo y no estaba; el sistema dice que hay. Eso es un descuadre
    // AFIRMADO. Mandarlo a Compras haría comprar mercancía que ya está en la tienda.
    expect(destinoDe('agotado', 8)).toBe('inventario');
  });

  it('agotado sin existencia => COMPRAS', () => {
    expect(destinoDe('agotado', 0)).toBe('compras');
  });

  it('⚠️ agotado con existencia NO MEDIDA => COMPRAS, nunca inventario', () => {
    // `null` es "no se pudo medir" (ADR-056), no cero y tampoco "hay". Sin el chequeo explícito
    // de `!= null` un `null` compararía `null > 0 === false` y llegaría a 'compras' por accidente
    // aritmético, no por regla. Se fija acá para que el día que se toque, el rojo lo diga.
    expect(destinoDe('agotado', null)).toBe('compras');
  });

  it('el código no pasa => CATÁLOGO aunque haya existencia (no es un descuadre)', () => {
    // El producto ESTÁ en la tienda; lo que falla es el dato maestro. Lo que lo protege no es el
    // orden de las ramas (se probó invirtiéndolas y no cambia nada) sino que la rama de existencia
    // esté guardada por `kind === 'agotado'`. Ese guard es lo que fija el caso de abajo.
    expect(destinoDe('codigo_no_pasa', 40)).toBe('catalogo');
    expect(destinoDe('codigo_no_pasa', 0)).toBe('catalogo');
    expect(destinoDe('codigo_no_pasa', null)).toBe('catalogo');
  });

  it('no se maneja aquí / no lo trabajamos => COMPRAS', () => {
    expect(destinoDe('no_en_sucursal', 0)).toBe('compras');
    expect(destinoDe('no_en_catalogo', null)).toBe('compras');
  });

  it('⚠️ «no se maneja aquí» CON existencia sigue siendo COMPRAS, no inventario', () => {
    // Este es el caso que sostiene el guard por motivo de la rama de existencia.
    // Sin él, cualquier motivo con existencia > 0 se iría a inventario: «no lo trabajamos» sobre
    // algo que el ERP tiene no es un descuadre, es una decisión de surtido, y le toca a Compras.
    // Verificado quitando el guard a propósito: sin esta línea el rojo no aparece.
    expect(destinoDe('no_en_sucursal', 7)).toBe('compras');
    expect(destinoDe('no_en_catalogo', 7)).toBe('compras');
  });

  it('el KPI «Buscado y no estaba» equivale exactamente a destino === inventario', () => {
    // El resumen cuenta ese KPI en SQL, que no puede llamar a esta funcion. Esa condicion es la
    // UNICA copia de la regla que vive fuera de TypeScript, asi que se fija acá la equivalencia:
    // si alguien cambia una y no la otra, el KPI de arriba deja de cuadrar con la columna
    // "Le toca a" de la misma pantalla, y no hay error que lo avise.
    const comoLoCuentaElSql = (kind: StockoutKind, onHand: number | null) =>
      kind === 'agotado' && onHand != null && onHand > 0;
    for (const k of STOCKOUT_KINDS) {
      for (const onHand of [null, 0, 1, 7] as (number | null)[]) {
        expect(comoLoCuentaElSql(k, onHand)).toBe(destinoDe(k, onHand) === 'inventario');
      }
    }
  });

  it('todos los motivos resuelven a un destino conocido (ninguno cae fuera)', () => {
    const destinos = new Set(['piso', 'compras', 'inventario', 'catalogo']);
    for (const k of STOCKOUT_KINDS) {
      for (const onHand of [null, 0, 7] as (number | null)[]) {
        expect(destinos.has(destinoDe(k, onHand))).toBe(true);
      }
    }
  });

  it('la lista de motivos es la MISMA que acepta el CHECK de la base', () => {
    // Si alguien agrega un motivo acá y olvida la migración, el INSERT revienta en runtime con un
    // 23514 que nadie relaciona con este archivo. Esta línea es el recordatorio con nombre.
    const enMigracion: StockoutKind[] = [
      'agotado', 'no_en_anaquel', 'no_en_sucursal', 'no_en_catalogo', 'codigo_no_pasa',
    ];
    expect([...STOCKOUT_KINDS].sort()).toEqual([...enMigracion].sort());
  });
});
