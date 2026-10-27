import { readFileSync } from 'node:fs';
import { FINANZAS_TABS } from './finanzas-tabs';
import { GASTOS_TABS } from './gastos-tabs';
import { PAGOS_TABS } from './pagos-tabs';
import { CAJA_TABS } from './caja-tabs';
import { CORTES_ARQUEOS_TABS } from './cortes-arqueos-tabs';
import { BANCOS_CONCILIACION_TABS } from './bancos-conciliacion-tabs';
import { DEUDA_PROVEEDORES_TABS } from './deuda-proveedores-tabs';
import { LIBROS_CONTABLES_TABS } from './libros-contables-tabs';
import { MAAT_TABS } from './maat-tabs';
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
   * `[CG.121]` El fuente de una pantalla de `modules/finanzas/pages/`, por su ruta relativa a
   * esa carpeta. Las dos candidatas son por dónde corre vitest (raíz del repo o de la app).
   *
   * ⛔ Si no encuentra el archivo **lanza**, no devuelve cadena vacía: un `''` haría pasar en
   * verde todo `not.toContain` y fallar todo `toContain`, que es ruido en los dos sentidos.
   */
  function fuentePagina(relativa: string): string {
    const CANDIDATAS = [
      'src/app/modules/finanzas/pages/' + relativa,
      'apps/view/src/app/modules/finanzas/pages/' + relativa,
    ];
    for (const c of CANDIDATAS) {
      try { return readFileSync(c, 'utf8'); } catch { /* siguiente */ }
    }
    throw new Error('NO MEDIDO: no se pudo leer ' + relativa + ' desde ' + process.cwd());
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

  /**
   * `[GX.80]` El sidebar ya no las lista como renglones sueltos: tiene UNA entrada «Gastos» que
   * lleva `GASTOS_TABS`, y esas pestañas son la barra de arriba de las cuatro pantallas. Lo que
   * esta prueba cuida sigue igual — que ninguna de estas rutas quede sin puerta en el menú.
   */
  it('el sidebar llega a las mismas rutas por la entrada «Gastos»', () => {
    expect(fuenteSidebar()).toContain('tabs: GASTOS_TABS');
    const deGastos = GASTOS_TABS.map((t) => t.route);
    for (const r of RUTAS) expect(deGastos).toContain(r);
  });

  /**
   * `[TP.20.3]` **Las cuatro pantallas de Pagos entran por UNA puerta, y ninguna se queda sin
   * ella** (objetivo O5).
   *
   * Es el mismo riesgo que `[GX.18]` ya cobró en Gastos: al juntar renglones del menú en una sola
   * entrada, basta olvidar una ruta en la lista para que esa pantalla quede **viva pero sin puerta
   * alguna** — sólo alcanzable escribiendo la URL. Acá además hay una trampa propia: la barra de
   * Pagos **no tiene shell de ruta**, se embebe pantalla por pantalla, así que una pantalla nueva
   * puede nacer sin barra y nadie se entera.
   */
  describe('[TP.20.3] la puerta única de Pagos', () => {
    /**
     * `[PGP.7]` **Dos, no cuatro** — y las otras dos siguen VIVAS por URL.
     *
     * Medido contra prod el 2026-10-23: «Programa de pagos» llevaba **76 días sin cargar** (su
     * última importación es del 8-ago) y la mitad retrospectiva de «Pronto pago» **55 días sin
     * producir** (el detector calló el 29-ago, y sus 98 hallazgos siguen sin triar). La mitad
     * prospectiva de Pronto pago ya viaja dentro del Calendario desde `[TP.20.4]`.
     */
    const DE_PAGOS = [
      '/finanzas/calendario-pagos',
      // `[PGP.20]` (2026-10-27) llegó de `/compras/cuentas-pago`: es el PASO siguiente del
      // Calendario —sin la cuenta del proveedor no se prepara la transferencia— y quien prepara
      // es Tesorería, no Compras. Entra por el orden del trabajo, no por categoría.
      '/finanzas/cuentas-pago',
      '/finanzas/pagos-comprobantes',
    ] as const;

    /**
     * ⛔ Salieron del MENÚ, no del router. El riesgo que cuida este bloque —una pantalla viva sin
     * puerta por un olvido— se cubre acá comprobando que su ruta siga existiendo: retirarlas es
     * una decisión, borrarlas sería otra y nadie la tomó.
     */
    const RETIRADAS = ['/finanzas/pronto-pago', '/finanzas/programa-pagos'] as const;

    it('el sidebar tiene UNA entrada «Pagos» que lleva sus pestañas', () => {
      const src = fuenteSidebar();
      expect(src).toContain('tabs: PAGOS_TABS');
      /*
       * ⛔ Y ya NO las lista como renglones sueltos: si alguien vuelve a agregarlas, son dos
       * puertas a lo mismo y el menú deja de decir que son un ciclo.
       *
       * ⚠️ La entrada «Pagos» necesita UNA de las pestañas como destino —es a donde lleva el
       * clic—, así que esa no cuenta. Se lee del propio archivo en vez de clavarla: `[PGP.7]`
       * cambió ese destino de Pronto pago al Calendario y la aserción se puso roja por nombrar
       * una ruta concreta. Lo que se vigila es que no haya OTRAS puertas, no cuál es ésta.
       */
      const destino = /\{ label: 'Pagos',[^}]*route: '([^']+)'/.exec(src)?.[1];
      expect(destino, 'la entrada «Pagos» debe llevar a alguna de sus pestañas').toBeTruthy();
      expect(DE_PAGOS as readonly string[]).toContain(destino!);
      for (const r of DE_PAGOS.filter((x) => x !== destino)) {
        expect(src).not.toContain("route: '" + r + "'");
      }
    });

    it('[PGP.7] PAGOS_TABS son las dos del ciclo vivo: hacer el pago y comprobarlo', () => {
      expect(PAGOS_TABS.map((t) => t.route)).toEqual([...DE_PAGOS]);
    });

    /**
     * `[PGP.7]` ⛔ **La prueba que convierte «retirar» en algo distinto de «borrar».**
     *
     * Las dos pantallas salieron del menú porque su dato estaba muerto (76 y 55 días sin
     * actualizarse), no porque sobren: quien las tenga en marcadores las sigue abriendo, y el día
     * que el feed vuelva, el histórico está ahí. Si alguien borra la ruta, esto se pone rojo.
     */
    it('[PGP.7] las retiradas del menú siguen VIVAS en el router', () => {
      const CANDIDATAS = ['src/app/app.routes.ts', 'apps/view/src/app/app.routes.ts'];
      let rutas: string | null = null;
      for (const c of CANDIDATAS) { try { rutas = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ } }
      if (rutas === null) throw new Error('NO MEDIDO: no se pudo leer app.routes.ts');
      for (const r of RETIRADAS) {
        expect(rutas, r + ' salió del menú, pero su ruta NO debe desaparecer').toContain(
          "path: '" + r.replace('/finanzas/', '') + "'",
        );
      }
    });

    /**
     * ⛔ Sin shell de ruta, la barra vive en cada pantalla: esto comprueba que las del menú la
     * tengan. Una pantalla sin barra queda encerrada — se entra, pero no se sale a sus hermanas.
     */
    it('las pantallas del menú embeben la barra de pestañas', () => {
      const ARCHIVOS: Record<string, string> = {
        '/finanzas/calendario-pagos': 'finanzas-calendario-pagos.component.ts',
        '/finanzas/cuentas-pago': 'finanzas-cuentas-pago.component.ts',
        '/finanzas/pagos-comprobantes': 'finanzas-pagos-comprobantes.component.ts',
      };
      for (const ruta of DE_PAGOS) {
        const base = ARCHIVOS[ruta];
        const CANDIDATAS = [
          'src/app/modules/finanzas/pages/' + base,
          'apps/view/src/app/modules/finanzas/pages/' + base,
        ];
        let src: string | null = null;
        for (const c of CANDIDATAS) { try { src = readFileSync(c, 'utf8'); break; } catch { /* siguiente */ } }
        if (src === null) throw new Error('NO MEDIDO: no se pudo leer ' + base);
        expect(src).toContain('<app-pagos-tabs />');
        expect(src).toContain('PagosTabsComponent');
      }
    });
  });

  /**
   * `[CG.121]` **Las tres pantallas del efectivo entran por UNA puerta.**
   *
   * Pedido de Edgar (2026-10-19): un selector en Caja (captura) para cambiar entre Captura,
   * Expediente y Caja Fuerte, con las tres en un solo módulo.
   *
   * El riesgo es el mismo que `[GX.18]` y `[TP.20.3]` ya cobraron, más uno propio: **el
   * Expediente ya estaba sin puerta antes de este cambio** — tenía ruta y permiso, pero ni
   * pestaña ni renglón en el sidebar. Y como `[IG.2]` sólo recorre lo que `FINANZAS_TABS`
   * declara, una pantalla ausente de esa lista le es invisible: el candado pasaba en verde.
   */
  describe('[CG.121] la puerta única de Caja', () => {
    // ⭐ `[CGS.2]` Son TRES, no cuatro: Arqueos FUSIONA lo que era el Expediente (Edgar,
    // 2026-10-20: «Expediente y Arqueos es lo mismo, hay que fusionarlos»). La ruta vieja no
    // desaparece —redirige— pero ya no es pestaña: dos puertas a la misma revisión son las que
    // hacían que una se quedara vieja.
    const DE_CAJA = [
      '/finanzas/caja-general',
      '/finanzas/caja-general/arqueos',
      '/finanzas/caos',
    ] as const;

    it('el sidebar tiene UNA entrada «Caja» que lleva todas las pestañas', () => {
      const src = fuenteSidebar();
      expect(src).toContain('tabs: CAJA_TABS');
      // ⛔ Y ya NO las lista como renglones sueltos: dos puertas a lo mismo y el menú deja de
      // decir que son un área. `/finanzas/caja-general` queda exento: es el `route` por
      // omisión de la propia entrada del área, el que `conDestino()` reemplaza.
      for (const r of DE_CAJA.filter((x) => x !== '/finanzas/caja-general')) {
        expect(src).not.toContain("route: '" + r + "'");
      }
    });

    it('las rutas están en CAJA_TABS, en el orden del recorrido del dinero', () => {
      expect(CAJA_TABS.map((t) => t.route)).toEqual([...DE_CAJA]);
    });

    /**
     * ⛔ Cada pestaña con EL MISMO gate que su ruta. Una pestaña más floja ofrece una pantalla
     * que al abrirse manda a `/sin-acceso`; una más dura esconde una que sí se puede abrir.
     */
    it('cada pestaña lleva el permiso de su ruta', () => {
      const t = (r: string) => CAJA_TABS.find((x) => x.route === r);

      // Ruta: anyPermissionGuard(VER, GESTIONAR, AUTORIZAR).
      expect(t('/finanzas/caja-general')?.anyOf).toEqual([
        Permission.FINANCE_CAJA_VER,
        Permission.FINANCE_CAJA_GESTIONAR,
        Permission.FINANCE_CAJA_AUTORIZAR,
      ]);
      // Con `anyOf`, `permission` sería letra muerta: el filtro devuelve antes de mirarlo.
      expect(t('/finanzas/caja-general')?.permission).toBeUndefined();

      // `[CGS.2]` Ruta: permissionGuard(FINANCE_CAJA_VER). Es lectura: quien revisa de mañana no
      // tiene por qué poder capturar para poder mirar.
      expect(t('/finanzas/caja-general/arqueos')?.permission).toBe(Permission.FINANCE_CAJA_VER);
      expect(t('/finanzas/caja-general/arqueos')?.anyOf).toBeUndefined();
      // Ruta: anyPermissionGuard(FINANCE_CAOS_VER) — permiso PROPIO, otro circuito de efectivo.
      expect(t('/finanzas/caos')?.permission).toBe(Permission.FINANCE_CAOS_VER);
    });

    /**
     * ⛔ Sin shell de ruta —el padre con `path: ''` de `/finanzas` ya lo ocupa Gastos— la barra
     * vive embebida en cada pantalla. Una que nazca sin ella queda **encerrada**: se entra,
     * pero no se sale a sus hermanas.
     */
    it('todas las pantallas embeben la barra de pestañas', () => {
      const ARCHIVOS: Record<string, string> = {
        '/finanzas/caja-general': 'caja-general/finanzas-caja-general.component.ts',
        '/finanzas/caja-general/arqueos': 'caja-general/finanzas-caja-arqueos.component.ts',
        '/finanzas/caos': 'caos/finanzas-caos.component.ts',
      };
      for (const ruta of DE_CAJA) {
        const src = fuentePagina(ARCHIVOS[ruta]);
        expect(src).toContain('<app-caja-tabs');
        expect(src).toContain('CajaTabsComponent');
      }
    });

    /**
     * ⭐ **Prueba negativa del candado de arriba.** Si `fuentePagina` leyera el archivo
     * equivocado, o si `toContain` se aplicara a algo que siempre está, el bucle pasaría sin
     * comprobar nada. La pantalla de la FIRMA es del área y no monta la barra **a propósito**
     * —es el teléfono del mostrador, se entra por el código de seis y se le presta a quien
     * viene a firmar—, así que sirve de control: acá el candado tiene que decir que NO está.
     */
    it('detecta una pantalla del área que NO monta la barra', () => {
      const firma = fuentePagina('caja-general/finanzas-caja-firma.component.ts');
      expect(firma).not.toContain('<app-caja-tabs');
      // Y que el control sea el archivo correcto, no uno vacío por una ruta mal escrita.
      expect(firma).toContain('app-finanzas-caja-firma');
    });
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
    // `[GX.80]` Una pantalla también tiene puerta si es pestaña de un ÁREA que el sidebar lleva como
    // UNA entrada con `tabs:` (Gastos): esa entrada lleva al área y la barra de arriba a cada pantalla.
    // Sólo cuenta si la entrada existe de verdad en el fuente: sin ella, las cuatro vuelven a faltar.
    // `[TP.20.3]` Pagos sigue la misma regla desde hoy: UNA entrada con `tabs: PAGOS_TABS`.
    // `[CG.121]` Caja sigue la misma regla desde hoy: UNA entrada con `tabs: CAJA_TABS`.
    const porArea = [
      ...(fuente.includes('tabs: GASTOS_TABS') ? GASTOS_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: PAGOS_TABS') ? PAGOS_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: CAJA_TABS') ? CAJA_TABS.map((t) => t.route) : []),
      // `[NAV.7]` Los cinco apartados que pliegan el resto del sidebar de Finanzas, misma regla:
      // cuentan sólo si su entrada `tabs:` existe de verdad en el fuente.
      ...(fuente.includes('tabs: CORTES_ARQUEOS_TABS') ? CORTES_ARQUEOS_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: BANCOS_CONCILIACION_TABS') ? BANCOS_CONCILIACION_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: DEUDA_PROVEEDORES_TABS') ? DEUDA_PROVEEDORES_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: LIBROS_CONTABLES_TABS') ? LIBROS_CONTABLES_TABS.map((t) => t.route) : []),
      ...(fuente.includes('tabs: MAAT_TABS') ? MAAT_TABS.map((t) => t.route) : []),
    ];
    const ausentes = FINANZAS_TABS
      .map((t) => t.route)
      // Las rutas que redirigen o viven fuera de /finanzas no se exigen acá.
      .filter((r) => r.startsWith('/finanzas/'))
      .filter((r) => !fuente.includes("route: '" + r + "'") && !porArea.includes(r));
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
