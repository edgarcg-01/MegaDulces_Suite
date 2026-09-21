import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * **Quien RECIBE tiene que poder acomodar** (WMS-REC.9).
 *
 * El gate de ubicaciones estaba partido por dominio (layout = `ASIGNAR`, lecturas
 * = `VER`, put-away = `RECIBIR`) y eso le negaba el trabajo a quien lo hace.
 *
 * Medido en PRODUCCIÓN, no en staging — la diferencia importa y ya me costó una
 * afirmación falsa en un PR:
 *
 * | rol           | RECIBIR | VER   | ASIGNAR | usuarios |
 * |---------------|---------|-------|---------|----------|
 * | `almacenista` | sí      | **no**| **no**  | **4**    |
 * | `supervisor`  | sí      | sí    | sí      | 1        |
 *
 * O sea que **4 de los 5 usuarios** que pueden entrar al Andén recibían un 403 en
 * la sección de Ubicación entera: no podían leer su propia cola de pendientes, ni
 * saber si un rack existe, ni darlo de alta. Es el 403 que el bodeguero reportó
 * como *"No tienes los permisos dinámicos necesarios"*.
 *
 * Se abren **sólo las cuatro rutas que el Andén usa**. Repartir
 * `COMMERCIAL_INVENTORY_VER` entero era la alternativa fácil y abría 14 endpoints
 * en tres controladores —conteo físico y existencia incluidos— a quien sólo tiene
 * que acomodar una tarima.
 *
 * **`DELETE /bins` se queda en `ASIGNAR` a propósito**, y este candado lo fija:
 * crear la ubicación es parte de acomodar, borrar el layout no.
 */
const FUENTE = readFileSync(join(__dirname, 'bin-location.controller.ts'), 'utf8');

/**
 * El bloque de UNA ruta: desde su decorador de metodo hasta el de la siguiente.
 *
 * El corte por longitud fija (400 caracteres) que tenia esto se contaminaba con
 * la ruta de abajo: al abrir `bins/:id/contents`, el bloque de `DELETE bins/:id`
 * se comia su decorador y el candado de "el borrado no se abre" salia rojo con
 * el borrado intacto. Un candado que se rompe por su propia ventana ensena a
 * ignorarlo.
 */
function gateDe(metodo: string, ruta: string): string {
  const i = FUENTE.indexOf(`@${metodo}('${ruta}')`);
  if (i < 0) throw new Error(`No existe la ruta @${metodo}('${ruta}')`);
  const resto = FUENTE.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? FUENTE.slice(i) : FUENTE.slice(i, i + 1 + siguiente);
}

describe('bins · quien recibe puede acomodar', () => {
  const abiertasALectura = [
    ['Get', 'bins'],
    ['Get', 'unlocated'],
    ['Get', 'pick-suggestion'],
    // WMS-REC.10 — la pantalla de Ubicaciones: que hay en ESTE rack, y donde esta
    // un producto. Sin estas dos, el bodeguero acomoda la tarima y no puede volver
    // a mirar donde la dejo.
    ['Get', 'bins/:id/contents'],
    ['Get', 'locations'],
  ] as const;

  it.each(abiertasALectura)('%s /%s acepta al que sólo tiene RECIBIR', (metodo, ruta) => {
    const g = gateDe(metodo, ruta);
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain('COMMERCIAL_INVENTORY_VER');
    expect(g).toContain('COMMERCIAL_INVENTORY_RECIBIR');
  });

  it('POST /bins acepta al que sólo tiene RECIBIR: crear el rack es parte de acomodar', () => {
    const g = gateDe('Post', 'bins');
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain('COMMERCIAL_INVENTORY_ASIGNAR');
    expect(g).toContain('COMMERCIAL_INVENTORY_RECIBIR');
  });

  it('DELETE /bins/:id NO se abre: borrar el layout no es trabajo del andén', () => {
    const g = gateDe('Delete', 'bins/:id');
    expect(g).toContain('RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)');
    expect(g).not.toContain('RequireAnyPermission');
  });

  it('el put-away sigue exigiendo RECIBIR y nada más', () => {
    const g = gateDe('Post', 'put-away');
    expect(g).toContain('RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)');
  });

  it('ninguna ruta quedó sin gate', () => {
    // Un endpoint sin decorador pasa el guard entero (`if (!hasAnd && !hasAny) return true`),
    // así que olvidarse uno acá no da 403: da acceso abierto.
    const rutas = FUENTE.match(/@(Get|Post|Delete|Put|Patch)\(/g) ?? [];
    const gates = FUENTE.match(/@Require(Permissions|AnyPermission)\(/g) ?? [];
    expect(rutas.length).toBeGreaterThan(0);
    expect(gates.length).toBe(rutas.length);
  });
});
