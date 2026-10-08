import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * Fase WMS.1 — el Almacén como un solo producto.
 *
 * **Jerarquía, sin repetir nada:**
 *  - **Sidebar = área** = un *trabajo* que alguien hace en un turno (Entrada,
 *    Inventario, Conteo, Control). Cuatro, no diecinueve.
 *  - **Tabs = las pantallas de ese trabajo.** Ninguna etiqueta de tab repite el
 *    nombre de su área — si la repite, el usuario ve el mismo texto dos veces y
 *    los dos menús parecen el mismo menú.
 *
 * **El corte es por trabajo, no por tema.** El primer intento agrupó por tema
 * ("Caducidades") y partió un mismo flujo en dos áreas: *Por fechar* es la cola
 * que deja el cierre del vale (el cierre da de alta en lote `NA` y alguien le
 * pone la fecha después), así que vive en **Entrada**, al lado de los Vales —
 * no en una isla temática. Lo mismo *Ubicaciones*: ubicar es el último paso de
 * recibir.
 *
 * El control es `app-page-tabs`, que desde el 2026-10-05 sirve el segmentado iOS por default (antes habia que pedirlo con `variant`,
 * **route-based**): cada tab es un `routerLink` a una ruta hermana, así que los
 * deep-links y el lazy-loading siguen intactos. Se descartó `.fb-viewseg` de
 * Finanzas por ser state-based (un `signal` + un componente gigante).
 *
 * **Las rutas NO cambian.** La barra se monta en `AlmacenAreaShellComponent`,
 * que envuelve las rutas existentes sin tocar sus paths.
 * Ver `docs/IMPLEMENTACION/FASES/FASE_WMS.md` §1.
 */
export interface AlmacenArea {
  /** Clave interna del área (iconos del sidebar / debug / tests). */
  key: string;
  /** Nombre del área — es la etiqueta del sidebar. */
  label: string;
  /**
   * Prefijos de URL que pertenecen al área. La resolución es por **prefijo más
   * largo**, así que `/almacen/inventory` (Inventario) puede convivir con
   * `/almacen/inventory/sessions` (Conteo) sin ambigüedad.
   */
  match: string[];
  /** Pantallas del área — esto es la barra de tabs. */
  tabs: PageTab[];
  /**
   * El área **no se pinta en el sidebar**, pero sigue resolviendo URLs y dando
   * su barra de tabs a quien entre por deep-link. Es el paso intermedio entre
   * "visible" y "borrada": retira la puerta sin tirar el código, que es lo que
   * permite volver atrás si el reemplazo no rinde.
   */
  hidden?: boolean;
  /**
   * Pantallas de **foco** del área: handheld, sin barra de tabs (cuelgan fuera
   * del shell de ruta). **NO son tabs**: si lo fueran, al hacer clic la barra
   * desaparecería y el operario quedaría sin salida visible. Se llega a ellas
   * desde dentro del área (un botón en la pantalla que las precede).
   *
   * Sí cuentan como **candidatas a aterrizaje**: un contador que solo tiene
   * `CONTAR` no alcanza ningún tab de Conteo, y sin esto el área no se le
   * pintaría en el sidebar.
   */
  focusEntries?: PageTab[];
  /**
   * **Dónde ENTRA cada quien, cuando no es lo mismo que dónde empieza el proceso.**
   *
   * Por default el aterrizaje del item de sidebar es el primer tab que la persona puede
   * ver, o sea `tabs[0]`. Eso confunde dos preguntas distintas: **el orden de lectura**
   * (en qué secuencia ocurre el trabajo) y **el punto de entrada** (qué querés ver al
   * llegar). Casi siempre coinciden; cuando no, forzar que coincidan degrada una de las dos.
   *
   * Si está presente, el aterrizaje se resuelve sobre ESTA lista y la barra se sigue
   * pintando en el orden de `tabs`. Se usa sólo con una razón medida y con condición de
   * retiro escrita — ver el área `conteo`.
   */
  landing?: PageTab[];
}

export const ALMACEN_AREAS: AlmacenArea[] = [
  {
    key: 'entrada',
    label: 'Entrada',
    /**
     * **OCULTA del sidebar** (decisión del equipo, 2026-09-01): el Andén es la
     * única puerta del bodeguero, y dejar la entrada vieja a la vista invita a
     * volver al recorrido de 79 toques.
     *
     * **Las rutas y los componentes NO se borraron.** Siguen vivos para
     * deep-links y para el supervisor, y el área sigue declarada para que
     * `resolveAlmacenArea` les dé su barra de tabs coherente al entrar por URL.
     * Apagarlas de verdad es el último paso del plan, después de correr los dos
     * flujos en paralelo y comprobar que el tablero de pendientes baja.
     *
     * *Por fechar* y *Ubicaciones* **se mudaron a Inventario**: el Andén resuelve
     * un vale de punta a punta, pero no cubre la deuda de vales anteriores ni la
     * consulta de dónde vive cada lote. Ocultarlas sin reubicarlas las volvía
     * inalcanzables.
     */
    hidden: true,
    // Ojo: 'recepcion-sesiones' NO es hijo de 'recepcion' (no hay `/` entre
    // medio), por eso van los dos prefijos explícitos. El detalle handheld
    // `/recepcion-sesiones/:id` cae por prefijo → sigue resolviendo a Entrada.
    match: ['/almacen/inventory/recepcion', '/almacen/inventory/recepcion-sesiones'],
    tabs: [
      { label: 'Vales', icon: 'pi pi-list', route: '/almacen/inventory/recepcion-sesiones', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
      { label: 'Caducidad', icon: 'pi pi-camera', route: '/almacen/inventory/recepcion', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
    ],
  },
  {
    key: 'inventario',
    label: 'Inventario',
    // '/almacen/inventory' cubre por prefijo a expiring y caducidades; las
    // sub-rutas de Entrada y Conteo ganan porque su prefijo es más largo.
    match: ['/almacen/inventory', '/almacen/warehouses', '/almacen/dead-stock', '/almacen/inventory-health'],
    tabs: [
      // EXISTENCIA va primera: el trabajo del almacén empieza en el censo. Y como
      // `almacenNavGroups` aterriza en el PRIMER tab alcanzable, el item "Inventario" del sidebar
      // lleva acá a quien tenga el permiso y degrada solo a "Ajustes de stock" a quien no.
      { label: 'Existencia', icon: 'pi pi-box', route: '/almacen/inventory/existencia', permission: Permission.EXISTENCIA_VER, exact: true },
      // Se llamaba "Existencias" y NO lo es: lee `commercial.stock`, el libro transaccional
      // (acierta 91% contra el POS, 15,324 unidades de error). Es la consola de AJUSTE y el
      // único lugar con el apartado. El censo físico es el tab de arriba.
      { label: 'Ajustes de stock', icon: 'pi pi-sliders-h', route: '/almacen/inventory', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
      { label: 'Por vencer', icon: 'pi pi-calendar-times', route: '/almacen/inventory/expiring', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
      // Mudadas desde Entrada al ocultarla: el Andén resuelve UN vale de punta a
      // punta, pero no cubre la deuda que dejaron los vales anteriores (Por
      // fechar) ni la consulta de dónde vive cada lote (Ubicaciones).
      { label: 'Por fechar', icon: 'pi pi-clock', route: '/almacen/inventory/por-fechar', permission: Permission.COMMERCIAL_EXPIRY_CAPTURAR, exact: true },
      // `anyOf`: quien RECIBE tiene que poder ver donde acomodo. En prod el rol
      // `almacenista` solo tiene RECIBIR y esta pestana le estaba OCULTA.
      { label: 'Ubicaciones', icon: 'pi pi-map-marker', route: '/almacen/inventory/ubicaciones', anyOf: [Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR], exact: true },
      // exact:false a propósito — el tab sigue activo en el detalle `/:id`.
      { label: 'Hojas de anaquel', icon: 'pi pi-clipboard', route: '/almacen/inventory/caducidades', permission: Permission.COMMERCIAL_EXPIRY_VER, exact: false },
      { label: 'Stock muerto', icon: 'pi pi-exclamation-triangle', route: '/almacen/dead-stock', permission: Permission.COMMERCIAL_DEADSTOCK_VER, exact: false },
      { label: 'Salud inv.', icon: 'pi pi-heart', route: '/almacen/inventory-health', permission: Permission.COMMERCIAL_INVHEALTH_VER, exact: false },
      { label: 'Almacenes', icon: 'pi pi-warehouse', route: '/almacen/warehouses', permission: Permission.COMMERCIAL_WAREHOUSES_VER, exact: false },
    ],
  },
  {
    key: 'abasto',
    label: 'Abasto',
    /**
     * Fase AB — el trabajo de **decidir qué falta y a quién pedírselo**. Va acá, después de
     * Inventario, porque es lo que sigue a mirar el censo: primero ves qué hay, después
     * decidís qué traer.
     *
     * Hoy trae un solo tab, así que la barra NO se pinta (el shell la esconde con menos de
     * dos) y el área se ve como un item simple de sidebar — igual que Análisis BI.
     * *Nivelación de inventarios* (`/almacen/nivelacion`, `NIVELACION_VER`) es el segundo tab
     * y entra **con su pantalla** en el PR 4 de la fase. Ni el tab ni su prefijo se declaran
     * antes: sin ruta en `app.routes.ts` el tab tiraría 404 y el prefijo no resolvería nunca
     * — código muerto que además aparenta alcance.
     */
    match: ['/almacen/autoabasto'],
    tabs: [
      { label: 'Autoabasto', icon: 'pi pi-shopping-cart', route: '/almacen/autoabasto', permission: Permission.AUTOABASTO_VER, exact: true },
    ],
  },
  {
    key: 'salida',
    label: 'Pedidos',
    /**
     * `[GP.1]` Fase GP — el pedido que SALE del almacén (Kepler `U-D-40`, telemarketing y
     * sucursal). Hoy un solo tab: el tablero de lectura. Surtido, checado y carga (GP.3–GP.5)
     * entran aquí como tabs con su pantalla; no se declaran antes porque sin ruta el tab tiraría
     * 404. Permiso propio `ALMACEN_PEDIDOS_VER` (ver el comentario en `authz-tree.ts`).
     */
    match: ['/almacen/pedidos'],
    tabs: [
      { label: 'Tablero', icon: 'pi pi-list-check', route: '/almacen/pedidos', permission: Permission.ALMACEN_PEDIDOS_VER, exact: true },
    ],
  },
  {
    key: 'rutas',
    label: 'Ruta Directa',
    /**
     * `[RD.45]` **La flota de Ruta Directa como un trabajo del almacén.**
     *
     * Las tres primeras pantallas ya vivían en `/comercial` y se sirven acá con el MISMO
     * componente (ver `app.routes.ts`): no hay copia, hay una segunda puerta. La cuarta —
     * *Conteos* — es nueva y es el punto de la entrada: cuenta el camión, que es lo único que
     * arbitra lo que la camioneta declara de sí misma.
     *
     * **El orden lo decide la pregunta que trae a alguien a ESTE proyecto, no el relato de la
     * operación.** En `/comercial` el orden natural es «qué vendió → qué le queda», porque ahí
     * se entra a leer la venta. Acá se entra desde el almacén, y la pregunta es *qué trae ese
     * camión* y *andá a contarlo*: por eso **Inventario** abre y **Conteos** va segundo, con la
     * venta y la comisión detrás como contexto.
     *
     * ⛔ **Sin desvío de aterrizaje**, y es a propósito: el default (`tabs[0]`) ya resuelve bien
     * los dos casos. Medido el 2026-10-07, los **16** de piso que estrenan
     * `ROUTE_COUNT_REGISTRAR` tienen `COMMERCIAL_ROUTE_SALES_VER` en **`false` explícito**, así
     * que *Inventario* no les existe y el sidebar los degrada solo a *Conteos*; quien tiene
     * todas las llaves aterriza en *Inventario*, que es la pregunta del almacén. Un `landing`
     * acá habría sido una excepción escrita para un caso **hipotético** —«por si algún día les
     * dan ROUTE_SALES_VER»— y el área `conteo` es la única con una razón **medida** para tenerlo.
     *
     * ⚠️ Los permisos son heterogéneos a propósito: `ROUTE_SALES_VER` (operación),
     * `ROUTE_COUNT_REGISTRAR` (escritura que RESETEA) y `COMMISSIONS_VER` (nómina). Ver cuánto
     * vendió una ruta y ver cuánto cobra su chofer siguen siendo cosas distintas.
     */
    match: ['/almacen/rutas'],
    tabs: [
      { label: 'Inventario', icon: 'pi pi-truck', route: '/almacen/rutas/inventario', permission: Permission.COMMERCIAL_ROUTE_SALES_VER, exact: true },
      { label: 'Conteos', icon: 'pi pi-list-check', route: '/almacen/rutas/conteos', permission: Permission.COMMERCIAL_ROUTE_COUNT_REGISTRAR, exact: true },
      { label: 'Ventas', icon: 'pi pi-directions', route: '/almacen/rutas/ventas', permission: Permission.COMMERCIAL_ROUTE_SALES_VER, exact: true },
      { label: 'Comisiones', icon: 'pi pi-percentage', route: '/almacen/rutas/comisiones', permission: Permission.COMMERCIAL_COMMISSIONS_VER, exact: true },
    ],
    focusEntries: [
      // Contar un camión: handheld, sin barra. Se llega desde *Conteos*, eligiendo la ruta —
      // nunca directo, porque sin ruta la pantalla no tiene hoja que mostrar.
      { label: 'Contar camión', icon: 'pi pi-list-check', route: '/almacen/rutas/contar', permission: Permission.COMMERCIAL_ROUTE_COUNT_REGISTRAR, exact: false },
    ],
  },
  {
    key: 'conteo',
    label: 'Conteo',
    match: [
      '/almacen/inventory/sessions',
      '/almacen/inventory/abc',
      '/almacen/inventory/aisles',
      '/almacen/inventory/ira',
      '/almacen/inventory/diferencias',
      '/almacen/inventory/count',
    ],
    /**
     * `[IC.22]` — **la barra sigue el ciclo del conteo, no el orden en que se construyeron
     * las pantallas.** Antes era `Folios · Cíclico · Pasillos · IRA · Diferencias`, que no es
     * ninguna secuencia: mezclaba el trabajo de hoy, la configuración del almacén y el
     * resultado del trimestre. Cada posición se decidió mirando qué pregunta contesta la
     * pantalla, verificada contra su componente en `app.routes.ts`:
     *
     *  1. **Programa** (`inventory/abc`) — *¿qué toca contar?* Es la agenda, no un reporte:
     *     la ruta es «conteo cíclico (clasificación ABC + agenda)». Abre el ciclo.
     *  2. **Folios** — *¿qué se está contando y quién lo cuenta?* Abrir, asignar y seguir.
     *  3. *(**Contar** vive en `focusEntries`: es el acto, no una pantalla de consulta, y se
     *     llega desde el folio. Si fuera tab, al entrar desaparecería la barra.)*
     *  4. **Diferencias** — *¿qué salió descuadrado?* El trimestral de Kepler, que es el
     *     tercero de los tres ritmos.
     *  5. **Exactitud (IRA)** — *¿estamos mejorando?* El resultado acumulado. Va después de
     *     lo que lo produce.
     *  6. **Pasillos** — **no es un paso del ciclo, es configuración** del almacén (editor 2D
     *     de layout y mapeo SKU→pasillo). Se hace una vez y se consulta rara vez: al final.
     *
     * ⚠️ `Cíclico (ABC)` pasa a llamarse **Programa**: la etiqueta vieja nombraba el método
     * (Pareto ABC) y no la pregunta que contesta. La ruta NO cambia — los deep-links siguen.
     */
    tabs: [
      // ABC.3b — la agenda: qué toca contar hoy. Primera porque abre el ciclo.
      { label: 'Programa', icon: 'pi pi-sync', route: '/almacen/inventory/abc', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
      // exact:false — el tab sigue activo en el detalle del folio y en Equipos.
      // [IC.23] `anyOf` y no `permission`: el encargado de sucursal entra con ASIGNAR a armar
      // el equipo del conteo diario. Con permiso único perdía el tab aunque el guard lo dejara pasar.
      { label: 'Folios', icon: 'pi pi-clipboard', route: '/almacen/inventory/sessions', anyOf: [Permission.COMMERCIAL_INVENTORY_SUPERVISAR, Permission.COMMERCIAL_INVENTORY_ASIGNAR], exact: false },
      // [IC.0] El descuadre del trimestral de Kepler. Gate VER (lectura) y no SUPERVISAR:
      // el permiso ya esta repartido a 10 roles, incluida direccion y prevencion.
      { label: 'Diferencias', icon: 'pi pi-exclamation-triangle', route: '/almacen/inventory/diferencias', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
      { label: 'Exactitud (IRA)', icon: 'pi pi-verified', route: '/almacen/inventory/ira', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
      // Configuración, no ciclo: el editor 2D de pasillos y el mapeo SKU→pasillo.
      { label: 'Pasillos', icon: 'pi pi-th-large', route: '/almacen/inventory/aisles', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR, exact: true },
    ],
    /**
     * ⛔ **El aterrizaje NO sigue al orden de lectura, y la razón está medida.**
     *
     * El default es `tabs[0]`, así que poner *Programa* primero mandaría a **5 roles / 15
     * personas** (superadmin, compras, gerente_compras, marketing, supervisor) a aterrizar
     * ahí en vez de en *Folios*. Y hoy eso sería peor que antes: **el reloj de la cadencia
     * nunca arrancó** —`last_counted_at` cuelga de `MAX(reconciled_at)` y no hay un solo
     * folio reconciliado (§2.2 de `FASE_IC_RITMOS_Y_ABC`)— así que *Programa* publica el
     * catálogo entero como vencido. Aterrizar a alguien en una pantalla que grita «39,480
     * pendientes» no es un punto de entrada: es ruido con permiso.
     *
     * *Folios* sigue siendo la entrada porque contesta **qué está pasando ahora**, que es lo
     * que alguien quiere ver al llegar, y desde `[IC.13]` trae avance, última actividad y las
     * alertas.
     *
     * ⭐ **Condición de retiro, explícita:** cuando `[IC.16]` ponga el reloj por ritmo con
     * arranque declarado, *Programa* deja de mentir y esta lista se borra — el aterrizaje
     * vuelve a ser `tabs[0]` y pasa a coincidir con el inicio del proceso. Borrarla es el
     * cambio, no agregar otra cosa.
     */
    landing: [
      { label: 'Folios', icon: 'pi pi-clipboard', route: '/almacen/inventory/sessions', anyOf: [Permission.COMMERCIAL_INVENTORY_SUPERVISAR, Permission.COMMERCIAL_INVENTORY_ASIGNAR], exact: false },
      { label: 'Programa', icon: 'pi pi-sync', route: '/almacen/inventory/abc', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
      { label: 'Pasillos', icon: 'pi pi-th-large', route: '/almacen/inventory/aisles', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR, exact: true },
      { label: 'Exactitud (IRA)', icon: 'pi pi-verified', route: '/almacen/inventory/ira', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR, exact: true },
      { label: 'Diferencias', icon: 'pi pi-exclamation-triangle', route: '/almacen/inventory/diferencias', permission: Permission.COMMERCIAL_INVENTORY_VER, exact: true },
    ],
    focusEntries: [
      // Pantalla del contador: handheld, con `countFocusGuard` en canDeactivate.
      { label: 'Contar', icon: 'pi pi-qrcode', route: '/almacen/inventory/count', permission: Permission.COMMERCIAL_INVENTORY_CONTAR, exact: true },
    ],
  },
  {
    key: 'anden',
    label: 'Andén',
    // El Andén es pantalla de FOCO: no tiene tabs propios. Se declara como área
    // para que el sidebar lo resalte y para que el resolvedor no lo tire dentro
    // de Entrada, que sí tiene barra.
    match: ['/almacen/anden'],
    tabs: [],
    focusEntries: [
      { label: 'Andén', icon: 'pi pi-truck', route: '/almacen/anden', permission: Permission.COMMERCIAL_INVENTORY_RECIBIR, exact: true },
    ],
  },
  {
    key: 'control',
    label: 'Control',
    // `/almacen/movimientos` NO está acá a propósito: el **Diario de
    // Movimientos** queda intacto por decisión del equipo (2026-08-31) — item
    // propio de sidebar, su ruta cuelga fuera del shell y no lleva barra de
    // tabs. No moverlo a un área.
    /**
     * `[SM.9]` **Cuadre salió de acá y se fue a Finanzas** (`/finanzas/cuadre`): su permiso
     * nunca fue de almacén —es `RECONCILIATION_*`, dominio propio (ADR-029)— y lo que
     * resuelve es dinero (arqueo ciego, descuadre de caja) con una pata en inventario.
     * Quedan las tres de prevención, que sí son de piso.
     * ⚠️ Salió también del `match`: dejarlo ahí encendía esta barra sobre una URL que ya
     * no cuelga de este shell.
     */
    match: ['/almacen/prevencion', '/almacen/monitoreo', '/almacen/riesgo'],
    tabs: [
      { label: 'Prevención', icon: 'pi pi-shield', route: '/almacen/prevencion', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
      { label: 'Monitoreo', icon: 'pi pi-eye', route: '/almacen/monitoreo', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
      { label: 'Riesgo', icon: 'pi pi-chart-bar', route: '/almacen/riesgo', permission: Permission.COMMERCIAL_PREVENTION_VER, exact: true },
    ],
  },
  {
    key: 'analisis-bi',
    label: 'Análisis BI',
    // Un solo tab hoy → la barra NO se pinta (el shell la esconde con menos de dos), así que
    // el área se ve como un item simple de sidebar. Cuando entre el segundo indicador, se
    // agrega acá como tab y la barra aparece sola: no hay que tocar el layout.
    match: ['/almacen/analisis-bi'],
    tabs: [
      { label: 'Panorama', icon: 'pi pi-chart-line', route: '/almacen/analisis-bi', permission: Permission.ALMACEN_BI_VER, exact: true },
    ],
  },
];

/**
 * **Análisis BI — el único tab que cruza las áreas.**
 *
 * El resto de la barra son "las pantallas de este trabajo"; BI no es un trabajo,
 * es la lectura cruzada de todos. Se agrega al final de la barra de CADA área
 * (`almacenTabsForUrl`) en vez de copiarse dentro de los cinco arrays: así hay
 * un solo lugar donde cambia la etiqueta, la ruta o el permiso.
 *
 * **No entra en `area.tabs`** a propósito. `almacenLandingCandidates` lee ese
 * array para elegir a dónde apunta el item de sidebar del área, y un rol que sólo
 * tuviera `ALMACEN_BI_VER` habría hecho que "Inventario" aterrizara en BI — dos
 * items del sidebar apuntando a la misma ruta.
 *
 * Quien no tiene el permiso no lo ve: `app-page-tabs` filtra por `permission` y
 * se esconde solo cuando queda un tab visible, así que para esos roles la barra
 * queda exactamente como estaba.
 */
export const ANALISIS_BI_TAB: PageTab = {
  label: 'Análisis BI',
  icon: 'pi pi-chart-line',
  route: '/almacen/analisis-bi',
  permission: Permission.ALMACEN_BI_VER,
  exact: true,
};

/** Quita query string y fragmento — `routerLinkActive` compara sin ellos. */
function cleanUrl(url: string): string {
  return url.split('?')[0].split('#')[0];
}

/**
 * Resuelve el área por **prefijo más largo**. Sin esa regla,
 * `/almacen/inventory` (Inventario) se tragaría todas las sub-rutas de Entrada
 * y Conteo, que viven bajo el mismo path.
 */
export function resolveAlmacenArea(url: string): AlmacenArea | null {
  const path = cleanUrl(url);
  let best: AlmacenArea | null = null;
  let bestLen = -1;
  for (const area of ALMACEN_AREAS) {
    for (const prefix of area.match) {
      const hit = path === prefix || path.startsWith(prefix + '/');
      if (hit && prefix.length > bestLen) {
        best = area;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Tabs del área a la que pertenece la URL, más **Análisis BI** al final: es el
 * único tab que cruza las áreas, para que el indicador se alcance desde cualquier
 * pantalla del almacén sin volver al sidebar (`ANALISIS_BI_TAB`).
 *
 * Vacío en las pantallas de **foco** (`focusEntries`): ahí la barra no se pinta a
 * propósito, y sumarle BI la haría aparecer.
 */
export function almacenTabsForUrl(url: string): PageTab[] {
  const area = resolveAlmacenArea(url);
  if (!area) return [];
  const path = cleanUrl(url);
  const isFocus = (area.focusEntries ?? []).some(
    (f) => path === f.route || path.startsWith(f.route + '/'),
  );
  if (isFocus) return [];
  // Un área sin tabs (Andén) NO estrena barra por sumarle BI: quedaría una barra
  // de un solo elemento en una pantalla de foco, que es justo lo que el diseño
  // del área evita.
  if (!area.tabs.length) return [];
  // El área de BI ya trae su propia pantalla (*Panorama*); repetirla acá pondría
  // dos tabs apuntando a la misma ruta.
  if (area.key === 'analisis-bi') return area.tabs;
  return [...area.tabs, ANALISIS_BI_TAB];
}

/**
 * Candidatas a aterrizaje del área, en orden de preferencia: primero los tabs
 * (el trabajo normal), después las pantallas de foco. Un contador con solo
 * `CONTAR` no alcanza ningún tab de Conteo y aterriza en *Contar*.
 */
export function almacenLandingCandidates(area: AlmacenArea): PageTab[] {
  // `landing` sólo existe donde el orden de lectura y el punto de entrada NO coinciden
  // (hoy: `conteo`, ver la razón medida ahí). Sin él, el default sigue siendo `tabs`.
  return [...(area.landing ?? area.tabs), ...(area.focusEntries ?? [])];
}
