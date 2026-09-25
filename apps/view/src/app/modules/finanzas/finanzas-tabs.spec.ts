import { readFileSync } from 'node:fs';
import { FINANZAS_TABS } from './finanzas-tabs';
import { Permission } from '../../core/constants/permissions';

/**
 * `[GX.17]` **Una pantalla en prod que nadie puede abrir no está entregada.**
 *
 * La sección de gastos se partió en tres rutas (`/finanzas/gastos` capturar ·
 * `/finanzas/aprobacion-gastos` firmar · `/finanzas/gastos-tablero` consultar) y durante
 * dos commits las dos últimas existieron **sin una sola entrada en el nav**: se llegaba
 * únicamente escribiendo la URL. Es la misma falla de `[LC.6.2]`.
 *
 * Y son DOS superficies que tienen que decir lo mismo: las pestañas de arriba
 * (`FINANZAS_TABS`) y el sidebar (`layout.component.ts`). El comentario del layout ya
 * pedía "mismo orden en sidebar y pestañas" — pero nada lo comprobaba.
 */
describe('[GX.17] las tres puertas del gasto están en el nav', () => {
  const RUTAS = [
    '/finanzas/gastos',
    '/finanzas/aprobacion-gastos',
    '/finanzas/gastos-tablero',
  ] as const;

  it('las tres rutas tienen pestaña, en ese orden', () => {
    const rutas = FINANZAS_TABS.map((t) => t.route).filter((r) => RUTAS.includes(r as typeof RUTAS[number]));
    expect(rutas).toEqual([...RUTAS]);
  });

  /**
   * ⭐ La prueba negativa del `anyOf` que se quitó: la ruta es `canActivate: []` («para
   * este tendrán acceso todos»), así que un gate en la pestaña la escondería a 66 de los
   * 166 usuarios activos que la ruta SÍ deja entrar — medido en `platform_test`.
   */
  it('«Gastos» no lleva compuerta: ni permission ni anyOf', () => {
    const t = FINANZAS_TABS.find((x) => x.route === '/finanzas/gastos');
    expect(t).toBeTruthy();
    expect(t?.permission).toBeUndefined();
    expect(t?.anyOf).toBeUndefined();
  });

  it('firmar exige COMPROBAR y el tablero exige VER', () => {
    const por = (r: string) => FINANZAS_TABS.find((x) => x.route === r);
    expect(por('/finanzas/aprobacion-gastos')?.permission).toBe(Permission.FINANCE_EXPENSES_COMPROBAR);
    expect(por('/finanzas/gastos-tablero')?.permission).toBe(Permission.FINANCE_EXPENSES_VER);
  });

  /**
   * El sidebar se declara con campos privados dentro del componente, así que no se puede
   * importar: se comprueba sobre el fuente. Es tosco, pero cubre justo lo que se rompe —
   * que una superficie se actualice y la otra no.
   *
   * ⚠️ Si el archivo no se puede leer, esto DECLARA que no midió en vez de pasar en verde.
   */
  it('el sidebar lista las mismas tres rutas', () => {
    // ⚠️ Dos intentos fallidos antes de esto: la ruta de repo no resuelve (vitest corre
    // con el cwd en `apps/view`) y `import.meta.url` acá NO es un `file://` — el spec va
    // transformado y su base es la raíz servida. Se prueban las dos bases reales.
    const CANDIDATAS = [
      'src/app/modules/dashboard/layout/layout.component.ts',
      'apps/view/src/app/modules/dashboard/layout/layout.component.ts',
    ];
    let fuente: string | null = null;
    for (const c of CANDIDATAS) {
      try { fuente = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ }
    }
    if (fuente === null) throw new Error('NO MEDIDO: no se pudo leer el sidebar desde ' + process.cwd());
    for (const r of RUTAS) expect(fuente).toContain("route: '" + r + "'");
  });
});
