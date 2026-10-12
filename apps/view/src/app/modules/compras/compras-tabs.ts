import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[NAV.2]` — Las pantallas de **Compras**, agrupadas por el MOMENTO DEL FLUJO en que se usan.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────────────────
 * Medido el 2026-10-12: `/compras` ofrecía **22 renglones de sidebar en 5 grupos**, y los
 * grupos describían *temas*, no el trabajo. El comprador no entra a «Análisis»: entra a
 * decidir qué pedir, a emitirlo, a recibirlo o a ver qué le cuesta. Cada grupo pasa a ser UNA
 * entrada con su barra de pestañas (`NavItem.tabs`, el patrón de `[GX.80]`), y la etiqueta
 * nombra el momento, no la pantalla.
 *
 * ⛔ **Y una corrección que sólo apareció al leer qué hace cada una.** Tres pantallas comparten
 * `COMPRAS_HALLAZGOS_VER` —Hallazgos, Faltantes de piso y Reclamos— y la primera lectura dijo
 * «el permiso ya las trata como una cosa, júntalas». **Es falso, y juntarlas habría roto el
 * flujo:**
 *   · **Hallazgos** = el scanner nocturno deja agotados clase A y bajo-reorden → se PLANEA.
 *   · **Faltantes de piso** = lo que un cliente pidió en mostrador y no había; la única señal
 *     de demanda que ningún feed del ERP puede ver (una venta que no ocurrió no deja ticket)
 *     → se PLANEA.
 *   · **Reclamos** = el faltante que el Andén detectó AL RECIBIR, y a quién se le reclama
 *     → es RECEPCIÓN.
 * Un permiso compartido es una pista, no un veredicto. Las dos primeras alimentan la decisión
 * de compra; la tercera cierra un circuito de mercancía que ya llegó mal.
 *
 * ⚠️ Cada pestaña conserva SU permiso: la entrada del sidebar se ve si la persona ve al menos
 * una (`hasPermFor` → `tabs.some`), y lleva a la primera que puede ver (`conDestino`). Nadie
 * gana ni pierde acceso por este archivo — sólo cambia dónde se ofrece.
 */

/**
 * **Abastecimiento** — *¿qué hay que comprar?* Todo lo que alimenta la decisión, antes de que
 * exista un documento. Las dos bandejas van acá y no en un grupo de «hallazgos»: son entradas
 * de demanda, y su salida es un pedido.
 */
export const COMPRAS_ABASTO_TABS: PageTab[] = [
  { label: 'Existencia', route: '/compras/existencia', icon: 'pi pi-box',
    permission: Permission.EXISTENCIA_VER },
  { label: 'Pedido', route: '/compras/pedido', icon: 'pi pi-shopping-cart',
    permission: Permission.COMPRAS_PEDIDO_VER },
  // La bandeja del scanner nocturno: agotados clase A y bajo reorden que alguien tiene que mirar.
  { label: 'Hallazgos', route: '/compras/hallazgos', icon: 'pi pi-flag',
    permission: Permission.COMPRAS_HALLAZGOS_VER },
  // La venta que NO ocurrió. No sale de ningún feed: la captura el piso en el mostrador.
  { label: 'Faltantes de piso', route: '/compras/faltantes', icon: 'pi pi-exclamation-circle',
    permission: Permission.COMPRAS_HALLAZGOS_VER },
  // El árbol CEDIS→sucursal con el que el motor planea la demanda dependiente (DRP, RA-PRO.6).
  { label: 'Red de abasto', route: '/compras/red', icon: 'pi pi-sitemap',
    permission: Permission.COMPRAS_RED_VER },
  // Arma la requisición conversando; el motor pone cantidades y el comprador confirma (HITL).
  { label: 'Asistente', route: '/compras/asistente', icon: 'pi pi-comments',
    permission: Permission.COMPRAS_PEDIDO_GESTIONAR },
];

/** **Compra** — *el documento que se emite y se le manda al proveedor.* */
export const COMPRAS_DOCUMENTO_TABS: PageTab[] = [
  { label: 'Requisiciones', route: '/compras/requisiciones', icon: 'pi pi-file-edit',
    permission: Permission.COMPRAS_REQUISICIONES_VER },
  { label: 'Órdenes de compra', route: '/compras/ordenes', icon: 'pi pi-send',
    permission: Permission.COMPRAS_ORDENES_VER },
  // Las que el ERP tiene abiertas: lo pedido que todavía no llega.
  { label: 'Abiertas en Kepler', route: '/compras/oc-abiertas', icon: 'pi pi-clock',
    permission: Permission.COMPRAS_PEDIDO_VER },
];

/**
 * **Recepción** — *la mercancía que llegó.* Reclamos vive acá, y no con las otras dos bandejas:
 * su disparador es el Andén detectando un faltante contra el vale, no el reabasto.
 */
export const COMPRAS_RECEPCION_TABS: PageTab[] = [
  { label: 'Captura de facturas', route: '/compras/entradas', icon: 'pi pi-file-import',
    permission: Permission.COMPRAS_ENTRADAS_GESTIONAR },
  { label: 'Control de entradas', route: '/compras/entradas/control', icon: 'pi pi-verified',
    permission: Permission.COMPRAS_ENTRADAS_VER },
  // WMS-REC.8: el circuito que antes se evaporaba — el Andén pintaba el faltante y al cerrar
  // el vale no quedaba registro de que se hubiera reclamado.
  { label: 'Reclamos', route: '/compras/reclamos', icon: 'pi pi-megaphone',
    permission: Permission.COMPRAS_HALLAZGOS_VER },
];

/**
 * **Proveedores** — *con quién se compra y cómo se le paga.* Las tres salían del grupo
 * «Catálogo», donde no son catálogo: son el expediente comercial del proveedor. «Qué vence»
 * entra acá porque es su calendario de pago (`[RE.3]`), no una etapa de la recepción.
 */
export const COMPRAS_PROVEEDORES_TABS: PageTab[] = [
  // Lead time, cadencia, colchón y mínimo de compra: los parámetros con los que el motor pide.
  { label: 'Parámetros', route: '/compras/proveedores', icon: 'pi pi-id-card',
    permission: Permission.COMPRAS_PROVEEDORES_VER },
  // La cuenta por pagar que alimenta el Calendario de Pagos de Finanzas (TP.3).
  { label: 'Obligaciones', route: '/compras/obligaciones', icon: 'pi pi-book',
    permission: Permission.COMPRAS_OBLIGACIONES_VER },
  // Toda alta o cambio de cuenta pasa por una solicitud: control anti-fraude (TP.7).
  { label: 'Cuentas de pago', route: '/compras/cuentas-pago', icon: 'pi pi-credit-card',
    permission: Permission.COMPRAS_OBLIGACIONES_VER },
  // ⚠️ NO se llama «Cuentas por pagar» a propósito: no existe la liga recepción→pago en el ERP.
  { label: 'Qué vence', route: '/compras/vencimientos', icon: 'pi pi-calendar-clock',
    permission: Permission.COMPRAS_ENTRADAS_VER },
];

/**
 * **Costos** — *qué cuesta de verdad comprar.* Las tres responden la misma pregunta con tres
 * testigos distintos, y por eso valen juntas: la lista, lo pagado y lo recuperado.
 */
export const COMPRAS_COSTOS_TABS: PageTab[] = [
  // ⭐ Es el MISMO componente que la pestaña «Listado» de Recepción, con `data.lente = 'dinero'`:
  // la misma recepción mirada por el costo. Estaba suelta en el grupo «Análisis» y gateada por
  // `COMPRAS_ENTRADAS_VER` —el permiso de Recepción—, así que quien tenía ese permiso y ninguno
  // de costo veía un grupo «Análisis» con UN renglón. Acá contesta la pregunta que de verdad
  // responde. ⚠️ No se fusiona con «Listado»: son dos lentes, y la ruta propia existe para que
  // el sidebar no marque dos items a la vez.
  { label: 'Costo por compra', route: '/compras/costo-por-compra', icon: 'pi pi-dollar',
    permission: Permission.COMPRAS_ENTRADAS_VER },
  // CXP.4 — landed cost: compras menos descuentos efectivos, por proveedor.
  { label: 'Costo por proveedor', route: '/compras/costo-neto', icon: 'pi pi-percentage',
    permission: Permission.COMPRAS_COSTO_NETO_VER },
  // CE.6 — el de la ficha de Kepler, que es EL QUE FIJA EL PRECIO.
  { label: 'Costo estándar', route: '/compras/costo-estandar', icon: 'pi pi-tag',
    permission: Permission.COMPRAS_COSTO_ESTANDAR_VER },
  // RE.10 — devoluciones y notas de crédito clasificadas por su motivo.
  { label: 'Descuentos y apoyos', route: '/compras/descuentos', icon: 'pi pi-gift',
    permission: Permission.COMPRAS_DESCUENTOS_VER },
];
