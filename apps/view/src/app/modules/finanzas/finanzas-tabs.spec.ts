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
  const RUTAS = ['/finanzas/aprobacion-gastos', '/finanzas/gastos-historial'] as const;
  const TABLERO = '/finanzas/gastos-tablero';
  /** `[GX.42]` La captura salió del nav; su ruta no. Se comprueba igual que el tablero. */
  const CAPTURA = '/finanzas/gastos';

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
   * `[GX.42]` Eran TRES (levantar, firmar, consultar). **Levantar salió del nav** por pedido
   * del usuario: el gasto ya no se busca, LLEGA — Kepler lo asigna por la caja «Solicita» y
   * aparece en «Mis gastos» con su botón para subirle la evidencia.
   */
  it('las rutas del gasto tienen pestaña, en ese orden', () => {
    const rutas = FINANZAS_TABS.map((t) => t.route).filter((r) => RUTAS.includes(r as typeof RUTAS[number]));
    expect(rutas).toEqual([...RUTAS]);
  });

  it('el sidebar lista las mismas rutas', () => {
    const fuente = fuenteSidebar();
    for (const r of RUTAS) expect(fuente).toContain("route: '" + r + "'");
  });

  /**
   * ⭐ **La misma distinción que el tablero: se esconde la puerta, NO se borra la ruta.**
   * A `/finanzas/gastos` lleva el botón «Subir evidencia» de «Mis gastos», con el folio y la
   * sucursal en la URL. Si alguien «limpia» la ruta creyendo que sobra, ese botón deja de
   * llevar a ningún lado — y la pantalla se ve igual de bien.
   */
  it('[GX.42] la captura NO está en el nav, pero su ruta sigue existiendo', () => {
    expect(FINANZAS_TABS.map((t) => t.route)).not.toContain(CAPTURA);
    expect(fuenteSidebar()).not.toContain("route: '" + CAPTURA + "'");

    const CANDIDATAS = ['src/app/app.routes.ts', 'apps/view/src/app/app.routes.ts'];
    let rutas: string | null = null;
    for (const c of CANDIDATAS) {
      try { rutas = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ }
    }
    if (rutas === null) throw new Error('NO MEDIDO: no se pudo leer app.routes.ts');
    expect(rutas).toContain("path: 'gastos'");
  });

  /**
   * ⛔ Y el botón que la usa tiene que seguir apuntándole. Sin esto, quitar la pestaña deja
   * la ruta viva pero sin nadie que la abra — que es lo mismo que haberla borrado.
   */
  it('[GX.42] «Mis gastos» sigue teniendo el botón que lleva a la captura', () => {
    const CANDIDATAS = [
      'src/app/modules/finanzas/pages/finanzas-mis-gastos.component.ts',
      'apps/view/src/app/modules/finanzas/pages/finanzas-mis-gastos.component.ts',
    ];
    let src: string | null = null;
    for (const c of CANDIDATAS) { try { src = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ } }
    if (src === null) throw new Error('NO MEDIDO: no se pudo leer finanzas-mis-gastos.component.ts');
    expect(src).toContain("routerLink]=\"['" + CAPTURA + "']\"");
    // ⛔ Y con el folio Y la sucursal: 373 folios viven en más de una plaza.
    expect(src).toContain('folio: v.folio');
    expect(src).toContain('sucursal: v.sucursal');
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
   * `[GX.42]` Acá vivía la prueba negativa del `anyOf` de «Levantamiento de gasto». Se retiró
   * con la pestaña. Lo que cuidaba —que la ruta es `canActivate: []` y un gate en la pestaña
   * la escondería a 66 de los 166 activos— ya no aplica: sin pestaña no hay gate que poner.
   *
   * ⚠️ Lo que sí quedó vigilado es lo otro: que la RUTA siga viva y que el botón le apunte.
   */
  it('ya no hay pestaña de «Levantamiento de gasto»', () => {
    expect(FINANZAS_TABS.some((x) => x.label === 'Levantamiento de gasto')).toBe(false);
  });

  it('firmar exige COMPROBAR', () => {
    const t = FINANZAS_TABS.find((x) => x.route === '/finanzas/aprobacion-gastos');
    expect(t?.permission).toBe(Permission.FINANCE_EXPENSES_COMPROBAR);
  });

  /**
   * `[GX.33]` **El reparto entre las dos pantallas de consulta.** Medido en prod antes de
   * moverlo: el Historial lo veían 80 personas y 57 sólo capturan — a ésas el servidor ya
   * les acotaba a lo suyo, así que la pantalla prometía el historial de la empresa y
   * entregaba el propio. Esas 57 pasan a «Mis gastos».
   */
  describe('[GX.33] Mis gastos vs Historial', () => {
    const mis = () => FINANZAS_TABS.find((x) => x.route === '/finanzas/mis-gastos');
    const hist = () => FINANZAS_TABS.find((x) => x.route === '/finanzas/gastos-historial');

    it('quien sólo captura tiene «Mis gastos»', () => {
      expect(mis()?.label).toBe('Mis gastos');
      expect(mis()?.anyOf).toContain(Permission.FINANCE_EXPENSES_CAPTURAR);
    });

    /** ⛔ La razón de ser del cambio: CAPTURAR ya no abre el Historial. */
    it('CAPTURAR ya NO abre el Historial', () => {
      expect(hist()?.anyOf).not.toContain(Permission.FINANCE_EXPENSES_CAPTURAR);
      expect(hist()?.anyOf).toContain(Permission.FINANCE_EXPENSES_COMPROBAR);
    });

    /**
     * ⛔ Y `VER` se queda. Con COMPROBAR a secas el Historial quedaba en UNA persona, y
     * `credito_cobranza`, `direccion` y `finanzas` (4 usuarios medidos en prod) se quedaban
     * sin ninguna de las dos: no capturan, así que «Mis gastos» tampoco los cubre.
     */
    it('quien sólo consulta (VER) NO se queda sin pantalla', () => {
      expect(hist()?.anyOf).toContain(Permission.FINANCE_EXPENSES_VER);
    });

    /** Ninguna de las dos lleva `permission` suelto: con `anyOf` el filtro devuelve antes
     *  y esa clave es letra muerta — se leía como una segunda compuerta que no existía. */
    it('no arrastran un permission muerto junto al anyOf', () => {
      expect(mis()?.permission).toBeUndefined();
      expect(hist()?.permission).toBeUndefined();
    });
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
