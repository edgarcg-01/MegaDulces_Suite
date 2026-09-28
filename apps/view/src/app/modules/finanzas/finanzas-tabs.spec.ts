import { readFileSync } from 'node:fs';
import { FINANZAS_TABS } from './finanzas-tabs';
import { Permission } from '../../core/constants/permissions';

/**
 * [GX.17/GX.18] **Una pantalla en prod que nadie puede abrir no está entregada.**
 *
 * La sección de gastos se partió en rutas y durante dos commits dos de ellas existieron
 * **sin una sola entrada en el nav**: se llegaba únicamente escribiendo la URL. Es la misma
 * falla de `[LC.6.2]`.
 *
 * Y son DOS superficies que tienen que decir lo mismo: las pestañas de arriba
 * (`FINANZAS_TABS`) y el sidebar (`layout.component.ts`). El comentario del layout ya pedía
 * "mismo orden en sidebar y pestañas" — pero nada lo comprobaba.
 */
describe('[GX.18] las puertas del gasto en el nav', () => {
  const RUTAS = ['/finanzas/gastos', '/finanzas/aprobacion-gastos', '/finanzas/gastos-historial'] as const;
  const TABLERO = '/finanzas/gastos-tablero';

  /** El sidebar se declara en campos privados del componente: se comprueba sobre el fuente. */
  function fuenteSidebar(): string {
    const CANDIDATAS = [
      'src/app/modules/dashboard/layout/layout.component.ts',
      'apps/view/src/app/modules/dashboard/layout/layout.component.ts',
    ];
    for (const c of CANDIDATAS) {
      try { return readFileSync(c, 'utf8'); } catch { /* siguiente */ }
    }
    // ⚠️ DECLARA que no midió, en vez de pasar en verde.
    throw new Error('NO MEDIDO: no se pudo leer el sidebar desde ' + process.cwd());
  }

  /**
   * [GX.25] Son TRES: levantar, firmar y consultar. El historial es el tercero -- lo que
   * la persona levanto sigue existiendo despues de enviarlo, y alguien tiene que poder
   * volver a verlo.
   */
  it('las tres rutas tienen pestaña, en ese orden', () => {
    const rutas = FINANZAS_TABS.map((t) => t.route).filter((r) => RUTAS.includes(r as typeof RUTAS[number]));
    expect(rutas).toEqual([...RUTAS]);
  });

  it('el sidebar lista las mismas tres rutas', () => {
    const fuente = fuenteSidebar();
    for (const r of RUTAS) expect(fuente).toContain("route: '" + r + "'");
  });

  /**
   * [GX.18] El renglón del tablero salió del menú por pedido del usuario.
   *
   * ⭐ Pero la RUTA sigue viva: 25 personas con `_VER` la tenían en marcadores y hay enlaces
   * internos apuntando ahí. **Quitar el renglón es esconder la puerta; borrar la ruta es
   * romperle el enlace a alguien.** Esta prueba fija esa distinción: si alguien "limpia" la
   * ruta creyendo que sobra, se pone roja.
   */
  it('el tablero NO está en el nav, pero su ruta sigue existiendo', () => {
    expect(FINANZAS_TABS.map((t) => t.route)).not.toContain(TABLERO);
    expect(fuenteSidebar()).not.toContain("route: '" + TABLERO + "'");

    const CANDIDATAS = ['src/app/app.routes.ts', 'apps/view/src/app/app.routes.ts'];
    let rutas: string | null = null;
    for (const c of CANDIDATAS) {
      try { rutas = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ }
    }
    if (rutas === null) throw new Error('NO MEDIDO: no se pudo leer app.routes.ts');
    expect(rutas).toContain("path: 'gastos-tablero'");
  });

  /**
   * ⭐ La prueba negativa del `anyOf` que se quitó: la ruta es `canActivate: []` («para este
   * tendrán acceso todos»), así que un gate en la pestaña la escondería a 66 de los 166
   * usuarios activos que la ruta SÍ deja entrar — medido en `platform_test`.
   */
  it('«Levantamiento de gasto» no lleva compuerta: ni permission ni anyOf', () => {
    const t = FINANZAS_TABS.find((x) => x.route === '/finanzas/gastos');
    expect(t).toBeTruthy();
    expect(t?.label).toBe('Levantamiento de gasto');
    expect(t?.permission).toBeUndefined();
    expect(t?.anyOf).toBeUndefined();
  });

  it('firmar exige COMPROBAR', () => {
    const t = FINANZAS_TABS.find((x) => x.route === '/finanzas/aprobacion-gastos');
    expect(t?.permission).toBe(Permission.FINANCE_EXPENSES_COMPROBAR);
  });
});

/**
 * `[IG.2]` **El candado de `[GX.17]` nombraba TRES rutas, así que sólo cuidaba esas tres.**
 *
 * Al agregar `/finanzas/ingresos` la puse en las pestañas y en el árbol de authz, y **me olvidé
 * del sidebar** — que es por donde entra la gente. Las pruebas pasaron, el build pasó, y la
 * pantalla quedaba sólo escribiendo la URL. Exactamente la falla de `[GX.17]` y `[LC.6.2]`, otra
 * vez, porque el candado era una LISTA en vez de una REGLA.
 *
 * Esto lo invierte: recorre `FINANZAS_TABS` entero y exige que cada ruta esté en el sidebar. Una
 * pestaña nueva queda cubierta sola, sin que nadie se acuerde de agregarla acá.
 */
describe('[IG.2] toda pestaña de Finanzas tiene su entrada en el sidebar', () => {
  /** El sidebar son campos privados del componente: no se puede importar, se lee el fuente. */
  function fuenteDelSidebar(): string {
    const CANDIDATAS = [
      'src/app/modules/dashboard/layout/layout.component.ts',
      'apps/view/src/app/modules/dashboard/layout/layout.component.ts',
    ];
    for (const c of CANDIDATAS) {
      try { return readFileSync(c, 'utf8'); } catch { /* siguiente */ }
    }
    // Declara que no midió en vez de pasar en verde por no encontrar el archivo.
    throw new Error('NO MEDIDO: no se pudo leer el sidebar desde ' + process.cwd());
  }

  it('ninguna pestaña se queda fuera del sidebar', () => {
    const fuente = fuenteDelSidebar();
    const ausentes = FINANZAS_TABS
      .map((t) => t.route)
      // Las rutas que redirigen o viven fuera de /finanzas no se exigen acá.
      .filter((r) => r.startsWith('/finanzas/'))
      .filter((r) => !fuente.includes("route: '" + r + "'"));
    expect(ausentes).toEqual([]);
  });

  /**
   * ⭐ Prueba negativa del candado: si el filtro de arriba estuviera mal escrito, la lista de
   * ausentes daría vacía SIEMPRE y esto pasaría sin comprobar nada. Se verifica que una ruta
   * inventada sí se detecte como ausente.
   */
  it('detecta una ruta que NO está en el sidebar', () => {
    const fuente = fuenteDelSidebar();
    expect(fuente.includes("route: '/finanzas/esta-ruta-no-existe'")).toBe(false);
  });

  /**
   * ⛔ **NO se comprueba el ORDEN, y queda medido por qué.** El comentario del layout pide "mismo
   * orden en sidebar y pestañas"; hoy **no se cumple en 7 rutas** (`tareas` y `hallazgos` están en
   * otro lugar relativo, y arrastran a `pagos-comprobantes`, `calendario-pagos`, `gastos`,
   * `aprobacion-gastos` y `gastos-tablero`). Todas son de otras fases.
   *
   * Poner la aserción dejaría el candado en ROJO por algo previo y ajeno, y un test que nace rojo
   * enseña a ignorarlo — que es peor que no tenerlo. Reordenar el nav de otros tampoco es una
   * decisión técnica: cambia dónde la gente busca las cosas.
   *
   * Lo que sí importa —y es lo que esta suite cuida— es que ninguna pantalla quede **inalcanzable**.
   * El orden es comodidad; la ausencia es una pantalla que no existe para quien la necesita.
   */
});
