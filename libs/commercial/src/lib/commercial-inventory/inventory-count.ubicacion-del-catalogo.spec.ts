import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[IC.UB1]` — **La ubicación que publica el conteo sale del catálogo de `/almacen/ubicaciones`.**
 *
 * ## Qué protege
 *
 * La columna «Ubic.» del supervisor, el renglón que confirma el contador y el catálogo que se
 * lleva offline mostraban `public.products.location`. Esa columna **no es una ubicación**: tiene
 * **un solo valor distinto** en los 11,816 productos que la traen — la cadena `Z000` — y el folio
 * la copiaba al abrir, así que **3,005 de los 3,364 artículos de `INV-2026-00010`** la decían.
 *
 * Es el defecto más difícil de ver de su familia: la columna se veía **llena**. Un hueco se
 * cuestiona; un relleno uniforme se lee como dato y nadie lo audita.
 *
 * ## La medición que lo cierra (prod, 2026-11-27)
 *
 * El catálogo real existe desde la fase UB (ADR-090): **476 ubicaciones** en
 * `commercial.warehouse_bins` —471 de Padre Hidalgo— y **52 asignaciones** producto↔ubicación en
 * `commercial.bin_assignments`. De las 51 vivas, **ninguna** coincidía con `p.location` y **50**
 * discrepaban (`Z000` contra `TA011`): no eran dos versiones del mismo dato, eran un dato y un
 * relleno. Con el catálogo real, `INV-2026-00010` pasa de 3,005 ubicaciones dibujadas a **39
 * medidas**, y un producto puede traer varias (`TA011 · TA012 · TA013`).
 *
 * ⭐ Que la cobertura **baje** de 3,005 a 39 es el resultado correcto (regla 11): lo que no está
 * asignado se declara vacío, y recién entonces se puede ver cuánto falta por asignar.
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ Lee el fuente: no ejerce los endpoints, que piden Postgres con `warehouse_bins` y
 * `bin_assignments` sembrados. Afirma que **ningún camino de lectura publica `p.location`** y que
 * los tres que publican ubicación la resuelven contra el catálogo de UB, por almacén. NO afirma
 * «hay 39 con ubicación»: ése es un dato de prod y se vuelve a medir, no se congela acá.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales y el import explícito
 * deja el archivo sin cargar.
 */

const FUENTE = readFileSync(join(__dirname, 'inventory-count.service.ts'), 'utf8')
  .split(String.fromCharCode(13))
  .join('');

/** El cuerpo de un método del servicio, del `async <nombre>(` al `async ` siguiente. */
function metodo(src: string, nombre: string): string {
  const desde = src.indexOf(`async ${nombre}(`);
  if (desde < 0) return '';
  const hasta = src.indexOf('\n  async ', desde + 10);
  return src.slice(desde, hasta > desde ? hasta : undefined);
}

/** El fuente sin comentarios de bloque ni de línea: lo que de verdad corre. */
const CODIGO = FUENTE.split('\n')
  .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'))
  .join('\n');

describe('[IC.UB1] la ubicación sale del catálogo de /almacen/ubicaciones', () => {
  it('CONTROL — el instrumento encuentra los métodos y no se trae medio archivo', () => {
    for (const n of ['listItems', 'counterCatalog', 'getProgress', 'submitCount']) {
      expect(metodo(FUENTE, n), `no se encontró ${n}()`).not.toBe('');
    }
    expect(metodo(FUENTE, 'listItems').length, 'el ancla de listItems falló').toBeLessThan(4000);
    // Y el filtro de comentarios no se comió el código: lo que queda sigue teniendo los métodos.
    expect(CODIGO).toContain('async listItems(');
  });

  it('⛔ NINGÚN camino de lectura publica public.products.location', () => {
    expect(CODIGO).not.toContain('p.location');
    expect(CODIGO).not.toContain('prod.location');
    expect(CODIGO).not.toContain('prodInfo?.location');
    expect(CODIGO).not.toMatch(/location\s*:\s*\w+\.location/);
  });

  it('la fuente de la ubicación es bin_assignments + warehouse_bins, por almacén', () => {
    expect(FUENTE).toContain('const UBICACION_DEL_PRODUCTO');
    expect(FUENTE).toContain('commercial.bin_assignments');
    expect(FUENTE).toContain('commercial.warehouse_bins');
    // Por almacén: una ubicación de Padre Hidalgo no vale para La Piedad.
    expect(FUENTE).toContain('a.warehouse_id = ?::uuid');
    // Lo borrado no cuenta como asignado.
    expect(FUENTE).toContain('a.deleted_at IS NULL');
  });

  it('los TRES caminos que publican ubicación usan el mismo resolvedor', () => {
    for (const n of ['listItems', 'counterCatalog', 'getProgress']) {
      expect(metodo(FUENTE, n), `${n}() no usa el catálogo de UB`).toContain(
        'UBICACION_DEL_PRODUCTO',
      );
    }
    // submitCount lo usa por el helper, no por el LATERAL.
    expect(metodo(FUENTE, 'submitCount')).toContain('this.ubicacionDe(');
  });

  it('el folio ya no SIEMBRA la constante al abrirse', () => {
    const seed = metodo(FUENTE, 'createCount') || CODIGO;
    expect(seed).not.toContain('p.location');
    // Las dos ramas que sembraban desde public.products ahora siembran vacío.
    expect(CODIGO.split('NULL::text, e.qty_stock_units').length - 1).toBe(1);
    expect(CODIGO.split('NULL::text, s.quantity').length - 1).toBe(1);
  });

  it('un producto en varias ubicaciones las devuelve todas, en orden de recorrido', () => {
    expect(FUENTE).toContain('string_agg(b.code');
    expect(FUENTE).toContain('ORDER BY b.pick_sequence');
  });

  it('PRUEBA NEGATIVA — si alguien reinstala la constante, el candado se pone ROJO', () => {
    const mutante = CODIGO.split('location: null,').join('location: prod.location ?? null,');
    expect(mutante, 'la mutación no aplicó: el candado no probaría nada').not.toBe(CODIGO);
    expect(mutante).toContain('prod.location');
    expect(mutante).toMatch(/location\s*:\s*\w+\.location/);
  });
});
