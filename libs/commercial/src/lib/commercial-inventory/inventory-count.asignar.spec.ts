import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[IC.23]` — **Quien ASIGNA ve el equipo y el avance; el TEÓRICO sigue siendo de SUPERVISAR.**
 *
 * Nace de una decisión de negocio (2026-10-06): *el encargado de sucursal asigna quién cuenta*.
 * Para que eso sea posible hubo que abrir tres puertas que estaban cerradas — y el valor de este
 * archivo está tanto en lo que exige abierto como en lo que exige **cerrado**.
 *
 * ⛔ **La línea que separa las dos facultades es `:id/items`**, que devuelve `expected_qty` fila
 * por fila. Es la puerta que `[IC.2]` le quitó al `almacenista` para no romper el conteo ciego.
 * Si algún día se abre a `ASIGNAR` «por simetría», el encargado pasa a saber el número antes que
 * quien cuenta, y el conteo deja de ser ciego sin que ninguna pantalla cambie de aspecto.
 *
 * ⚠️ **Qué NO afirma este archivo.** Lee el FUENTE de los controladores: comprueba qué decorador
 * tiene cada ruta, no que el guard lo honre en runtime (eso es `RolesGuard`, probado aparte).
 * Es el mismo alcance —y la misma limitación— que `inventory-count.cancelar.spec.ts`.
 */

const COUNTS = readFileSync(join(__dirname, 'inventory-count.controller.ts'), 'utf8');
const TEAMS = readFileSync(join(__dirname, 'inventory-team.controller.ts'), 'utf8');

/**
 * El bloque de UNA ruta: desde su decorador de método hasta el de la siguiente.
 *
 * Se corta en el próximo decorador de ruta y NO por longitud fija: un corte por caracteres se
 * come el decorador del vecino y pone el candado en rojo con el código intacto (ya pasó en
 * `bin-location.permisos.spec.ts`).
 */
function gateDe(fuente: string, metodo: string, ruta: string): string {
  const i = fuente.indexOf(`@${metodo}('${ruta}')`);
  if (i < 0) throw new Error(`No existe la ruta @${metodo}('${ruta}')`);
  const resto = fuente.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? fuente.slice(i) : fuente.slice(i, i + 1 + siguiente);
}

const SUPERVISAR = 'COMMERCIAL_INVENTORY_SUPERVISAR';
const ASIGNAR = 'COMMERCIAL_INVENTORY_ASIGNAR';

describe('inventario · el arnés del candado', () => {
  /**
   * Sin esto, un extractor que devolviera cadena vacía pondría en verde TODOS los `not.toContain`
   * de abajo — que son justamente las aserciones que protegen el teórico.
   */
  it('el extractor devuelve el bloque de la ruta, no una cadena vacía', () => {
    const g = gateDe(COUNTS, 'Get', ':id/items');
    expect(g.length).toBeGreaterThan(40);
    expect(g).toContain('items');
  });

  it('y falla fuerte si la ruta no existe (una ruta renombrada no pasa en silencio)', () => {
    expect(() => gateDe(COUNTS, 'Get', ':id/no-existe')).toThrow(/No existe la ruta/);
  });
});

describe('inventario · lo que ASIGNAR necesita para trabajar', () => {
  /**
   * Los tres gates mal partidos. Estaban LATENTES: medido en prod el 2026-10-06, los 5 roles con
   * `ASIGNAR` (compras, gerente_compras, marketing, supervisor, superadmin) tienen también
   * `SUPERVISAR`, así que nadie los había pisado. Se rompen en el momento en que
   * `encargado_tienda` recibe `ASIGNAR` — que es lo que hace la migración de esta fase.
   */
  it('LEER a quién se asignó: no se puede asignar a ciegas sobre la lista que uno mismo escribe', () => {
    const g = gateDe(COUNTS, 'Get', ':id/assignments');
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain(SUPERVISAR);
    expect(g).toContain(ASIGNAR);
  });

  it('VER EL AVANCE: quien arma el equipo tiene que saber si alguien contó', () => {
    const g = gateDe(COUNTS, 'Get', ':id/progress');
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain(ASIGNAR);
  });

  it('VER EL TABLERO de equipos: antes podía auto-generarlo sin poder mirarlo', () => {
    const g = gateDe(TEAMS, 'Get', 'counts/:id/aisle-teams');
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain(ASIGNAR);
  });

  it('ESCRIBIR la lista sigue siendo ASIGNAR (no se endureció de paso)', () => {
    const g = gateDe(COUNTS, 'Post', ':id/assignments');
    expect(g).toContain(ASIGNAR);
  });

  it('el catálogo de gente asignable sigue siendo ASIGNAR', () => {
    const g = gateDe(COUNTS, 'Get', 'assignable-users');
    expect(g).toContain(ASIGNAR);
  });
});

describe('inventario · ⛔ lo que ASIGNAR NO puede abrir', () => {
  /**
   * **La aserción central del archivo.** `:id/items` es el teórico. Que las otras tres se
   * pudieran abrir depende enteramente de que ésta siga cerrada: es lo que convierte a `ASIGNAR`
   * en «armo el equipo y miro el avance» en vez de «veo contra qué se está contando».
   */
  it('el TEÓRICO por SKU sigue exigiendo SUPERVISAR a secas', () => {
    const g = gateDe(COUNTS, 'Get', ':id/items');
    expect(g).toContain('RequirePermissions');
    expect(g).not.toContain('RequireAnyPermission');
    expect(g).not.toContain(ASIGNAR);
  });

  it('abrir un folio (total o cíclico) no se abre a ASIGNAR: congela el almacén', () => {
    for (const ruta of ['open', 'open-cycle']) {
      const g = gateDe(COUNTS, 'Post', ruta);
      expect(g).toContain('RequirePermissions');
      expect(g).not.toContain(ASIGNAR);
    }
  });

  it('calcular discrepancias y resolver un item no se abren a ASIGNAR', () => {
    for (const ruta of [':id/compute', ':id/items/:itemId/resolve']) {
      const g = gateDe(COUNTS, 'Post', ruta);
      expect(g).not.toContain(ASIGNAR);
    }
  });

  /**
   * Reconciliar MUEVE EL SALDO. Que el encargado de sucursal pueda armar el equipo no lo
   * convierte en quien autoriza el ajuste: eso sigue siendo `RECONCILIAR` (separación de
   * funciones — la misma razón por la que `[WMS-REC.16]` NO abrió esta puerta al abrir `cancel`).
   */
  it('reconciliar sigue siendo RECONCILIAR a secas', () => {
    const g = gateDe(COUNTS, 'Post', ':id/reconcile');
    expect(g).toContain('RequirePermissions');
    expect(g).toContain('COMMERCIAL_INVENTORY_RECONCILIAR');
    expect(g).not.toContain(ASIGNAR);
  });

  it('el export a Kepler y su acuse siguen siendo RECONCILIAR', () => {
    expect(gateDe(COUNTS, 'Get', ':id/kepler-export')).not.toContain(ASIGNAR);
    expect(gateDe(COUNTS, 'Post', ':id/kepler-export/ack')).not.toContain(ASIGNAR);
  });
});
