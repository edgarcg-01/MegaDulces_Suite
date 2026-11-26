import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `AJE-2a` — **Ninguna ruta del conteo físico queda sin candado.**
 *
 * Nace del plan de pruebas por persona
 * (`docs/MODULOS/pruebas-inventario-fisico/6-ajeno-sin-permiso.md`): de las 171 pruebas, ésta es
 * la más barata de correr y la que más cobra si falta. Un endpoint sin decorador **no se ve en
 * la pantalla** —la pantalla sólo llama a los que usa— pero se alcanza con `curl` desde
 * cualquier sesión válida, y por este controlador pasan el teórico de un inventario y el ajuste
 * que mueve existencia.
 *
 * ⚠️ **Lo que ya existía no cubría esto.** `contar-o-asignado.guard.spec.ts` afirma que las 8
 * rutas del contador llevan `ContarOAsignadoGuard` y que otras 5 NO lo llevan. Las dos cosas
 * son ciertas y **ninguna impide agregar una ruta nueva sin ningún decorador**: pasaría los 24
 * casos de aquel archivo en verde.
 *
 * ⚠️ **Alcance: nivel C.** Comprueba el DECORADOR en el fuente, no que Nest lo honre en runtime.
 * El runtime es trabajo del bloque `[B]` del plan, contra la pila levantada por el CI.
 * `@UseGuards(RolesGuard)` a nivel de clase **no cuenta como candado**: resuelve el mapa de
 * permisos, pero una ruta sin metadato de permiso queda abierta a cualquier sesión autenticada.
 */

const RUTA_DEL_CONTROLADOR = join(__dirname, 'inventory-count.controller.ts');
const CONTROLLER = readFileSync(RUTA_DEL_CONTROLADOR, 'utf8');

/** Los tres decoradores que SÍ cierran una ruta. */
const CANDADOS = /@RequirePermissions\(|@RequireAnyPermission\(|@UseGuards\(/;

type Ruta = { metodo: string; ruta: string; bloque: string };

/**
 * Parte el fuente en un bloque por ruta: desde su decorador de verbo hasta el siguiente.
 * El `@UseGuards(RolesGuard)` de la clase queda ANTES del primer verbo, así que no entra en
 * ningún bloque — que es justo lo que se quiere.
 */
function rutasDe(fuente: string): Ruta[] {
  const verbo = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
  const marcas: { metodo: string; ruta: string; i: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = verbo.exec(fuente)) !== null) {
    marcas.push({ metodo: m[1], ruta: m[2] ?? '', i: m.index });
  }
  return marcas.map((x, k) => ({
    metodo: x.metodo,
    ruta: x.ruta,
    bloque: fuente.slice(x.i, k + 1 < marcas.length ? marcas[k + 1].i : fuente.length),
  }));
}

const RUTAS = rutasDe(CONTROLLER);

describe('AJE-2a · el instrumento antes que la medición', () => {
  /**
   * ⭐ Control: una pregunta cuya respuesta ya se conoce por otro camino. Si el extractor no
   * acierta esto, se tira el extractor, no la medición.
   */
  it('CONTROL — encuentra las rutas conocidas y les arma un bloque con contenido', () => {
    const porNombre = (metodo: string, ruta: string) =>
      RUTAS.find((r) => r.metodo === metodo && r.ruta === ruta);

    // Tres que existen con certeza, una de cada familia de candado.
    expect(porNombre('Post', 'open')?.bloque).toContain('COMMERCIAL_INVENTORY_SUPERVISAR');
    expect(porNombre('Post', ':id/count')?.bloque).toContain('ContarOAsignadoGuard');
    expect(porNombre('Post', ':id/cancel')?.bloque).toContain('RequireAnyPermission');

    // Y una que NO existe: el extractor no debe inventarla.
    expect(porNombre('Get', ':id/no-existe')).toBeUndefined();
  });

  it('CONTROL — el bloque de una ruta NO se come el de la siguiente', () => {
    const open = RUTAS.find((r) => r.metodo === 'Post' && r.ruta === 'open')!;
    // `open` y `open-cycle` son contiguas: si el corte fallara, el bloque de la primera
    // contendría el nombre del método de la segunda.
    expect(open.bloque).not.toContain('openCycle(');
  });

  it('CONTROL — el @UseGuards de la clase no se cuela en ningún bloque', () => {
    expect(CONTROLLER).toContain('@UseGuards(RolesGuard)');
    expect(RUTAS.some((r) => r.bloque.includes('@UseGuards(RolesGuard)'))).toBe(false);
  });
});

describe('AJE-2a · ninguna ruta sin candado', () => {
  it('el controlador declara las rutas que decimos (si cambia el número, se revisa a mano)', () => {
    // No es un número mágico: es el testigo de que alguien agregó o quitó una puerta.
    expect(RUTAS.length).toBe(29);
  });

  it.each(RUTAS.map((r) => [`${r.metodo} /${r.ruta}`, r] as const))(
    '%s lleva candado',
    (_etiqueta, r) => {
      expect(CANDADOS.test(r.bloque)).toBe(true);
    },
  );

  /**
   * ⛔ **La prueba negativa**: sin esto, lo de arriba es una intención. Se le quita el decorador
   * a una ruta sobre una COPIA del fuente y se verifica que la comprobación se ponga roja.
   */
  it('PRUEBA NEGATIVA — quitarle el candado a una ruta pone la comprobación en rojo', () => {
    // ⚠️ El fuente viene con finales de línea de Windows (`\r\n`). Buscar con `\n` literal
    // NO reemplaza nada y la mutación no ocurre: la primera vez que se escribió esta prueba
    // salió roja justo por eso, y el `expect` de abajo es lo que lo destapó. Por eso el
    // reemplazo va por expresión regular y por eso ese `expect` se queda.
    const mutante = CONTROLLER.replace(
      /@Post\('open'\)\s*@RequirePermissions\(Permission\.COMMERCIAL_INVENTORY_SUPERVISAR\)/,
      "@Post('open')",
    );
    expect(mutante).not.toBe(CONTROLLER); // el reemplazo de verdad ocurrió

    const rutasMutadas = rutasDe(mutante);
    const open = rutasMutadas.find((r) => r.metodo === 'Post' && r.ruta === 'open')!;
    expect(CANDADOS.test(open.bloque)).toBe(false);
    expect(rutasMutadas.filter((r) => !CANDADOS.test(r.bloque))).toHaveLength(1);
  });
});

/**
 * El inventario congelado de quién abre cada puerta. **No es decoración**: medido en prod el
 * 2026-11-25, `marketing` (5 personas) puede abrir y congelar un almacén y NO puede cerrarlo, y
 * `encargado_tienda` (19) puede asignar y NO puede cancelar. Si alguien cambia uno de estos
 * renglones, tiene que ser a propósito y con el reparto de `MATRIZ_ACCESOS.md` en la mano.
 */
describe('AJE-2a · quién abre cada puerta, congelado', () => {
  const ESPERADO: Array<[string, string, RegExp]> = [
    ['Get', '', /COMMERCIAL_INVENTORY_VER/],
    ['Get', 'assignable-users', /COMMERCIAL_INVENTORY_ASIGNAR/],
    ['Get', 'variance-reasons', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Get', 'ira', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', 'open', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', 'open-cycle', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Get', ':id/sessions', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', ':id/advance-pass', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Get', ':id/interruptions', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', ':id/assignments', /COMMERCIAL_INVENTORY_ASIGNAR/],
    ['Get', ':id/aisle-progress', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Get', ':id/items', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', ':id/compute', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', ':id/items/:itemId/resolve', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Get', ':id/kepler-export', /COMMERCIAL_INVENTORY_RECONCILIAR/],
    ['Post', ':id/kepler-export/ack', /COMMERCIAL_INVENTORY_RECONCILIAR/],
    ['Get', ':id/kepler-export/status', /COMMERCIAL_INVENTORY_SUPERVISAR/],
    ['Post', ':id/reconcile', /COMMERCIAL_INVENTORY_RECONCILIAR/],
  ];

  it.each(ESPERADO)('%s /%s exige %s', (metodo, ruta, llave) => {
    const r = RUTAS.find((x) => x.metodo === metodo && x.ruta === ruta);
    expect(r, `no existe @${metodo}('${ruta}')`).toBeDefined();
    expect(r!.bloque).toMatch(llave);
  });

  /** Las dos puertas que aceptan CUALQUIERA de dos llaves, y por qué. */
  it(':id/assignments y :id/progress los lee quien SUPERVISA o quien ASIGNA', () => {
    for (const ruta of [':id/assignments', ':id/progress']) {
      const r = RUTAS.find((x) => x.metodo === 'Get' && x.ruta === ruta)!;
      expect(r.bloque).toContain('RequireAnyPermission');
      expect(r.bloque).toContain('COMMERCIAL_INVENTORY_SUPERVISAR');
      expect(r.bloque).toContain('COMMERCIAL_INVENTORY_ASIGNAR');
    }
  });

  /**
   * ⭐ Cancelar NO exige el poder de ajustar. *Cifra: `INV-2026-00009` congeló Padre Hidalgo
   * **101 días** (19-jun → 28-sep de 2026) porque abandonar el folio estaba encerrado detrás de
   * la misma llave que aplica el ajuste. Ese folio tenía 8 escaneos sobre 2,094 artículos:
   * reconciliarlo habría puesto la sucursal casi en cero.*
   */
  it('cancelar acepta CANCELAR_CONTEO además de RECONCILIAR, y reconciliar NO se abre', () => {
    const cancel = RUTAS.find((x) => x.metodo === 'Post' && x.ruta === ':id/cancel')!;
    expect(cancel.bloque).toContain('COMMERCIAL_INVENTORY_CANCELAR_CONTEO');
    expect(cancel.bloque).toContain('COMMERCIAL_INVENTORY_RECONCILIAR');

    const reconcile = RUTAS.find((x) => x.metodo === 'Post' && x.ruta === ':id/reconcile')!;
    expect(reconcile.bloque).toContain('RequirePermissions');
    expect(reconcile.bloque).not.toContain('CANCELAR_CONTEO');
  });

  /**
   * ⛔ La línea que no se cruza: el teórico fila por fila nunca se abre a quien cuenta ni a
   * quien asigna. Si `:id/items` cambiara de llave, el conteo deja de ser ciego sin que ninguna
   * pantalla cambie de aspecto.
   */
  it(':id/items (el teórico) exige SUPERVISAR a secas', () => {
    const items = RUTAS.find((x) => x.metodo === 'Get' && x.ruta === ':id/items')!;
    expect(items.bloque).toContain('RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)');
    expect(items.bloque).not.toContain('RequireAnyPermission');
    expect(items.bloque).not.toContain('ContarOAsignadoGuard');
  });
});
