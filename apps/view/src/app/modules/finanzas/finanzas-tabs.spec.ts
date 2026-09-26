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
