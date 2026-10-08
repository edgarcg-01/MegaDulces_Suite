import {
  ALMACEN_AREAS,
  ANALISIS_BI_TAB,
  almacenLandingCandidates,
  almacenTabsForUrl,
} from './almacen-tabs';
import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * El tab de **Análisis BI** cruza las áreas: se alcanza desde cualquier pantalla
 * del almacén sin volver al sidebar. Las aserciones de acá son las cuatro formas
 * en que ese cruce puede salir mal, cada una con su prueba negativa.
 */
describe('almacen-tabs · el tab de Análisis BI cruza las áreas', () => {
  const esBi = (t: { route: string }) => t.route === ANALISIS_BI_TAB.route;

  /** Una URL representativa por área visible — las que un rol abre de verdad. */
  const URLS_POR_AREA: Record<string, string> = {
    inventario: '/almacen/inventory/existencia',
    conteo: '/almacen/inventory/sessions',
    // `[SM.9]` Era `/almacen/cuadre`, que se mudó a Finanzas; Prevención es ahora la
    // primera del área Control y su URL representativa.
    control: '/almacen/prevencion',
    entrada: '/almacen/inventory/recepcion-sesiones',
    salida: '/almacen/pedidos',
  };

  for (const [area, url] of Object.entries(URLS_POR_AREA)) {
    it(`${area}: la barra termina en Análisis BI`, () => {
      const tabs = almacenTabsForUrl(url);
      expect(tabs.filter(esBi).length).toBe(1);
      expect(tabs[tabs.length - 1]).toEqual(ANALISIS_BI_TAB);
    });
  }

  it('el área de BI NO lo repite: su propia pantalla (Panorama) ya está', () => {
    const tabs = almacenTabsForUrl('/almacen/analisis-bi');
    expect(tabs.filter(esBi).length).toBe(1);
    expect(tabs.length).toBe(1);
  });

  // Prueba negativa 1 — sin esto, el operario ve una barra a media tarima.
  it('las pantallas de FOCO siguen sin barra', () => {
    for (const url of ['/almacen/anden', '/almacen/inventory/count', '/almacen/surtir']) {
      expect(almacenTabsForUrl(url)).toEqual([]);
    }
  });

  // Prueba negativa 2 — una URL fuera de toda área no estrena barra de un solo tab.
  it('una URL sin área no devuelve barra', () => {
    expect(almacenTabsForUrl('/almacen/movimientos')).toEqual([]);
  });

  // Prueba negativa 3 — la razón por la que BI NO vive dentro de `area.tabs`: si
  // viviera ahí, un rol con sólo ALMACEN_BI_VER haría que el item "Inventario" del
  // sidebar aterrizara en /almacen/analisis-bi, duplicando el item de BI.
  it('BI no es candidata de aterrizaje de ningún área ajena', () => {
    for (const area of ALMACEN_AREAS) {
      if (area.key === 'analisis-bi') continue;
      expect(almacenLandingCandidates(area).some(esBi)).toBe(false);
    }
  });
});

/**
 * `[IC.22]` — **la barra de Conteo sigue el ciclo del conteo.**
 *
 * Reordenar una barra es barato y parece inocuo, pero `almacenLandingCandidates` lee el
 * mismo array para decidir **dónde aterriza el item del sidebar**, así que cambiar el
 * orden de lectura mueve el punto de entrada de gente real. Medido contra prod el
 * 2026-10-07: poner *Programa* primero movía a **5 roles / 15 personas**.
 *
 * Por eso el área declara `landing` aparte, y la aserción que de verdad protege esto no es
 * «el orden es el que quiero» sino **«el aterrizaje de NADIE cambió»** — probada contra las
 * 16 combinaciones posibles de los 4 permisos, no contra los 11 roles de hoy: un rol nuevo
 * no puede romperla sin que esto se entere.
 */
describe('almacen-tabs · [IC.22] el área Conteo en orden de proceso', () => {
  const area = ALMACEN_AREAS.find((a) => a.key === 'conteo');
  if (!area) throw new Error('no existe el área `conteo`: este bloque no tiene qué proteger');
  const conteo = area;

  /**
   * El orden EXACTO anterior a `[IC.22]`, reproducido para poder comparar contra él.
   * Sin este testigo, «el aterrizaje no cambió» no se puede demostrar: se afirmaría.
   */
  const ORDEN_VIEJO: PageTab[] = [
    { label: 'Folios', route: '/almacen/inventory/sessions', anyOf: [Permission.COMMERCIAL_INVENTORY_SUPERVISAR, Permission.COMMERCIAL_INVENTORY_ASIGNAR] },
    { label: 'Cíclico (ABC)', route: '/almacen/inventory/abc', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Pasillos', route: '/almacen/inventory/aisles', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
    { label: 'Exactitud (IRA)', route: '/almacen/inventory/ira', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Diferencias', route: '/almacen/inventory/diferencias', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Contar', route: '/almacen/inventory/count', permission: Permission.COMMERCIAL_INVENTORY_CONTAR },
  ];

  const RELEVANTES = [
    Permission.COMMERCIAL_INVENTORY_SUPERVISAR,
    Permission.COMMERCIAL_INVENTORY_ASIGNAR,
    Permission.COMMERCIAL_INVENTORY_VER,
    Permission.COMMERCIAL_INVENTORY_CONTAR,
  ];

  /** Calca la resolución del layout: el primer candidato que la persona puede ver. */
  const aterriza = (tabs: PageTab[], tiene: Set<Permission>): string | null => {
    const visible = (t: PageTab) =>
      t.anyOf ? t.anyOf.some((p) => tiene.has(p)) : !t.permission || tiene.has(t.permission);
    return (tabs.find(visible) ?? { route: null as string | null }).route;
  };

  // ⭐ LA PRUEBA NEGATIVA: las 16 combinaciones de los 4 permisos, no los 11 roles de hoy.
  it('el aterrizaje de NADIE cambió — las 16 combinaciones de permisos', () => {
    const nuevos = almacenLandingCandidates(conteo);
    const movidos: string[] = [];
    for (let mask = 0; mask < 1 << RELEVANTES.length; mask++) {
      const tiene = new Set<Permission>(RELEVANTES.filter((_, i) => mask & (1 << i)));
      const antes = aterriza(ORDEN_VIEJO, tiene);
      const ahora = aterriza(nuevos, tiene);
      if (antes !== ahora) movidos.push(`[${[...tiene].join('+') || 'sin permisos'}] ${antes} -> ${ahora}`);
    }
    expect(movidos).toEqual([]);
  });

  // Control del arnés: si `ORDEN_VIEJO` dejara de distinguirse del nuevo, la prueba de
  // arriba pasaría por vacía. Acá se exige que los dos órdenes SÍ sean distintos.
  it('el orden de LECTURA sí cambió (si no, no habría nada que proteger)', () => {
    const rutas = conteo.tabs.map((t) => t.route);
    expect(rutas).not.toEqual(ORDEN_VIEJO.slice(0, 5).map((t) => t.route));
  });

  it('la barra sigue el ciclo: programa → folios → diferencias → exactitud → pasillos', () => {
    expect(conteo.tabs.map((t) => t.route)).toEqual([
      '/almacen/inventory/abc',
      '/almacen/inventory/sessions',
      '/almacen/inventory/diferencias',
      '/almacen/inventory/ira',
      '/almacen/inventory/aisles',
    ]);
  });

  it('Pasillos va al final: es configuración del almacén, no un paso del ciclo', () => {
    expect(conteo.tabs[conteo.tabs.length - 1].route).toBe('/almacen/inventory/aisles');
  });

  it('la etiqueta nombra la pregunta, no el método: «Programa», no «Cíclico (ABC)»', () => {
    const agenda = conteo.tabs.find((t) => t.route === '/almacen/inventory/abc');
    expect(agenda?.label).toBe('Programa');
    expect(conteo.tabs.some((t) => t.label.includes('ABC'))).toBe(false);
  });

  // La ruta NO cambia aunque cambie la etiqueta: los deep-links viejos siguen vivos.
  it('renombrar no movió ninguna ruta', () => {
    const rutas = new Set(conteo.tabs.map((t) => t.route));
    for (const viejo of ORDEN_VIEJO.slice(0, 5)) expect(rutas.has(viejo.route)).toBe(true);
  });

  it('Contar sigue fuera de la barra: es el acto, no una pantalla de consulta', () => {
    expect(conteo.tabs.some((t) => t.route === '/almacen/inventory/count')).toBe(false);
    expect(conteo.focusEntries?.some((t) => t.route === '/almacen/inventory/count')).toBe(true);
  });

  // `landing` existe SÓLO acá y con condición de retiro escrita ([IC.16]). Si alguien lo
  // copia a otra área sin razón medida, esto lo dice.
  it('ningún área además de Conteo usa el desvío de aterrizaje', () => {
    const conDesvio = ALMACEN_AREAS.filter((a) => a.landing).map((a) => a.key);
    expect(conDesvio).toEqual(['conteo']);
  });
});

/**
 * `[GP.3b]` Surtir desde el celular vive en el área Pedidos como pantalla de FOCO. Lo importante
 * es por dónde entra el almacenista: medido, tiene `COMMERCIAL_PICKING_GESTIONAR` ([VEC.0]) pero NO
 * `ALMACEN_PEDIDOS_VER`, así que sin la entrada de foco el área no se le pintaría.
 */
describe('almacen-tabs · Surtir (GP.3b)', () => {
  const encontrada = ALMACEN_AREAS.find((a) => a.key === 'salida');
  if (!encontrada) throw new Error('falta el área salida');
  const salida = encontrada;
  const primeraPara = (tiene: Set<string>) =>

    almacenLandingCandidates(salida).find((t) => !t.permission || tiene.has(t.permission))?.route;

  it('⭐ quien sólo puede surtir entra por Surtir', () => {
    expect(primeraPara(new Set([Permission.COMMERCIAL_PICKING_GESTIONAR]))).toBe('/almacen/surtir');
  });

  it('quien ve el tablero sigue entrando por el tablero (prueba negativa: el foco va al final)', () => {
    expect(
      primeraPara(new Set([Permission.ALMACEN_PEDIDOS_VER, Permission.COMMERCIAL_PICKING_GESTIONAR])),
    ).toBe('/almacen/pedidos');
  });

  it('quien sólo VE el surtido no entra (tomar trabajo escribe)', () => {
    expect(primeraPara(new Set([Permission.COMMERCIAL_PICKING_VER]))).toBeUndefined();
  });

  it('Surtir no es un tab de la barra', () => {
    expect(salida.tabs.some((t) => t.route === '/almacen/surtir')).toBe(false);
  });
});
