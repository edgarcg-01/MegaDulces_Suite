import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[EX.7]` — **El buscador por proveedor de `/compras/existencia`.**
 *
 * Pedido de Edgar (2026-10-08). Lo que protege este archivo son las dos formas en que un filtro
 * nuevo se rompe **sin que nadie lo note**:
 *
 * ⛔ **1. El orden de las rutas.** `GET :productId` casa cualquier palabra, así que si
 * `GET filtros` quedara después, Nest serviría `/existencia/filtros` como *«dame el detalle del
 * producto cuyo id es "filtros"»* — que no es un uuid, así que devuelve `{product: null, rows: []}`
 * **con HTTP 200**. El selector llegaría vacío y la pantalla diría «no hay proveedores». Este repo
 * ya pagó exactamente eso en la Fase LC con `no-asociados`, y el propio controlador lo advierte
 * en un comentario desde antes de esta fase.
 *
 * ⛔ **2. El permiso.** La pantalla la abren DOS proyectos (`/compras/existencia` y
 * `/almacen/inventory/existencia`) con **un solo permiso**, `EXISTENCIA_VER`. Si el endpoint de
 * filtros pidiera otro —por ejemplo el `/filters` de Compras, que era lo que estaba a la mano—
 * un almacenista vería el selector vacío sin ningún error. Vacío por permiso y vacío por falta de
 * datos se ven idénticos.
 *
 * ⚠️ **Qué NO afirma este archivo.** Lee el FUENTE: comprueba el orden y el decorador, no que el
 * guard lo honre en runtime ni que la consulta devuelva filas. Mismo alcance que
 * `inventory-count.asignar.spec.ts`, de donde sale el molde.
 */

const CTRL = readFileSync(join(__dirname, 'existencia.controller.ts'), 'utf8');
const SVC = readFileSync(join(__dirname, 'existencia.service.ts'), 'utf8');

/** Posición del decorador de una ruta dentro del fuente. −1 si no existe. */
function pos(ruta: string): number {
  return CTRL.indexOf(ruta === '' ? '@Get()' : `@Get('${ruta}')`);
}

/** El bloque de UNA ruta: hasta el decorador de la siguiente, nunca por longitud fija. */
function bloqueDe(ruta: string): string {
  const i = pos(ruta);
  if (i < 0) throw new Error(`No existe la ruta @Get('${ruta}')`);
  const resto = CTRL.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? CTRL.slice(i) : CTRL.slice(i, i + 1 + siguiente);
}

function permisoDe(ruta: string): string {
  const m = /@RequirePermissions\(([^)]*)\)/.exec(bloqueDe(ruta));
  if (!m) throw new Error(`La ruta @Get('${ruta}') no declara @RequirePermissions`);
  return m[1];
}

describe('[EX.7] el arnés del candado', () => {
  it('el extractor encuentra las rutas que dice encontrar', () => {
    expect(pos('filtros')).toBeGreaterThan(0);
    expect(pos(':productId')).toBeGreaterThan(0);
    expect(pos('export')).toBeGreaterThan(0);
  });

  it('y falla fuerte si una ruta se renombra', () => {
    expect(() => bloqueDe('no-existe')).toThrow(/No existe la ruta/);
  });

  it('⚠️ el extractor NO se come el DECORADOR del vecino', () => {
    // ⛔ Se compara contra el decorador y no contra la cadena `:productId` a secas: el bloque de
    // `filtros` llega hasta el decorador siguiente y por el camino se traga el COMENTARIO que
    // explica a `:productId` — y ese comentario la nombra. La primera versión de esta aserción
    // salió roja con el código correcto, igual que en `requisicion.autorizar.spec.ts`.
    // Un candado que se cae con prosa no mide rutas, mide redacción.
    expect(bloqueDe('filtros')).not.toContain(`@Get(':productId')`);
  });

  it('⭐ y lo de arriba no es teórico: el bloque SÍ trae el comentario del vecino', () => {
    expect(bloqueDe('filtros')).toContain(':productId');
  });
});

describe('[EX.7] el orden de las rutas — la trampa que devuelve 200 vacío', () => {
  it('⛔ `filtros` va ANTES que `:productId`, o la ruta comodín se lo come', () => {
    expect(pos('filtros')).toBeLessThan(pos(':productId'));
  });

  it('⛔ y `export` también sigue antes — no se arregla una rompiendo la otra', () => {
    expect(pos('export')).toBeLessThan(pos(':productId'));
  });
});

describe('[EX.7] el permiso: el mismo que la pantalla', () => {
  it('filtros pide EXISTENCIA_VER, igual que la matriz', () => {
    expect(permisoDe('filtros')).toContain('EXISTENCIA_VER');
    expect(permisoDe('')).toContain('EXISTENCIA_VER');
  });

  it('⭐ NEGATIVA: NO pide un permiso de Compras — la pantalla también la abre Almacén', () => {
    // Si alguien reusa el `/filters` de Compras «porque ya existe», el almacenista se queda sin
    // proveedores y sin ningún mensaje que lo explique.
    expect(permisoDe('filtros')).not.toContain('COMPRAS');
  });

  it('⛔ y NO pide EXISTENCIA_GESTIONAR, que es el del export (dataset completo valuado)', () => {
    expect(permisoDe('filtros')).not.toContain('GESTIONAR');
    expect(permisoDe('export')).toContain('GESTIONAR');   // el de al lado sí, y así se queda
  });
});

describe('[EX.7] la cobertura viaja — un filtro no puede parecer exhaustivo', () => {
  it('el servicio publica cuántos productos activos NO tienen proveedor', () => {
    // Son los que se caen de la tabla al filtrar. Medido en prod: 1,617 de 11,090 (14.6 %).
    expect(SVC).toContain('sin_proveedor');
  });

  it('⭐ y los cuenta de verdad, no lo deja en un cero fijo', () => {
    expect(SVC).toMatch(/count\(\*\)\s*FILTER\s*\(WHERE\s+supplier_id\s+IS\s+NULL\)/i);
  });

  it('la lista trae sólo proveedores con producto ACTIVO', () => {
    // 375 de 1,321: ofrecer los 946 sin catálogo vivo es ruido que no puede dar resultado.
    expect(SVC).toMatch(/p\.activo\s*=\s*true/);
  });
});
