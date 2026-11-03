import { Permission } from '@megadulces/platform-core';
import {
  warehouseName,
  type AutoabastoVieneDoc,
  type ColaSucursal,
  type GrupoPendienteSucursal,
} from '@megadulces/contracts';
import * as Q from './sucursal-pendientes.sql';

/**
 * `[AB.45]` **El registro de colas de «Pendientes de la sucursal».**
 *
 * Edgar (2026-11-03): «aquí deben estar todos los pendientes de la Suite que tiene la sucursal». El
 * inventario se hizo recorriendo todos los dominios (FASE_AB §16.23). Cada cola dice:
 *  · `sql`     — la consulta (en `sucursal-pendientes.sql.ts`, sin imports, para poder ejercerla tal
 *                cual contra prod);
 *  · `anyOf`   — la llave que abre su `ruta`. ⛔ DEBE ser la del guard de esa ruta: si no, el número
 *                lleva a un rebote (la regla 1 de `me-work.ts`). `allOf` cuando la ruta pide dos;
 *  · `fuente`  — dónde vive el predicado dueño. Si el dueño cambia su regla, se cambia aquí.
 *
 * `de: 'otra_area'` = está abierto en la sucursal pero lo atiende otra área: se ve, no suma.
 */
export interface ColaDef {
  id: string;
  grupo: GrupoPendienteSucursal;
  de: 'sucursal' | 'otra_area';
  label: string;
  accion: string;
  ruta: string;
  query?: (llave: string | null) => Record<string, string> | null;
  ventana: string | null;
  anyOf: readonly Permission[];
  allOf?: readonly Permission[];
  sql: string;
  fuente: string;
  /**
   * La consulta lee una vista viva cara (`erp_goods_receipts`: ~65 ms fijos de su CTE de centros de
   * compra, más dos búsquedas laterales por renglón). Corre en su propia conexión para no sumarse a
   * las demás: dos pesadas en serie en la misma tanda llevaban la pantalla a 680 ms (medido 2026-11-03).
   */
  pesada?: boolean;
}

export const COLAS_SUCURSAL: readonly ColaDef[] = [
  // ── Recibir ───────────────────────────────────────────────────────────────────────────────
  {
    id: 'llegadas-sin-vale', grupo: 'recibir', de: 'sucursal',
    label: 'Compras que llegaron sin vale en el Andén', accion: 'Abre el vale y captura la caducidad',
    ruta: '/almacen/anden', ventana: 'últimos 7 días', anyOf: [Permission.COMMERCIAL_INVENTORY_RECIBIR],
    sql: Q.SQL_LLEGADAS_SIN_VALE, fuente: 'receiving-session.service.ts arrivals (cascada de almacén, VENTANA_MX, sin vale vivo)', pesada: true,
  },
  {
    id: 'vales-abiertos', grupo: 'recibir', de: 'sucursal',
    label: 'Vales de recepción sin cerrar', accion: 'Termina o cancela el vale',
    ruta: '/almacen/anden', ventana: null, anyOf: [Permission.COMMERCIAL_INVENTORY_RECIBIR],
    sql: Q.SQL_VALES_ABIERTOS, fuente: "receiving_sessions.status IN ('open','validating') (en-curso)",
  },
  {
    id: 'sin-fechar', grupo: 'recibir', de: 'sucursal',
    label: 'Mercancía recibida sin fecha de caducidad', accion: 'Captura la caducidad',
    ruta: '/almacen/inventory/por-fechar', ventana: null, anyOf: [Permission.COMMERCIAL_EXPIRY_CAPTURAR],
    sql: Q.SQL_SIN_FECHAR, fuente: 'receiving-session.service.ts pendingExpiry (recibido − aceptado − retenido > 0)',
  },
  {
    id: 'entradas-sin-comprobante', grupo: 'recibir', de: 'sucursal',
    label: 'Entradas sin comprobante', accion: 'Sube la remisión',
    ruta: '/compras/entradas', query: (llave) => ({ ...(llave ? { suc: llave } : {}), estado: 'pendiente' }),
    ventana: 'desde el arranque de recepción', anyOf: [Permission.COMPRAS_ENTRADAS_GESTIONAR],
    sql: Q.SQL_ENTRADAS_SIN_COMPROBANTE, fuente: 'goods-receipt-proofs.service.ts listReceipts carril al_dia + estado pendiente', pesada: true,
  },
  {
    id: 'reclamos', grupo: 'recibir', de: 'sucursal',
    label: 'Reclamos de recepción abiertos', accion: 'Reclama al proveedor o a la sucursal que envió',
    ruta: '/compras/reclamos', ventana: null, anyOf: [Permission.COMPRAS_HALLAZGOS_VER],
    sql: Q.SQL_RECLAMOS, fuente: "receiving_claims.status IN ('open','claimed')",
  },
  // ── Surtir y despachar ────────────────────────────────────────────────────────────────────
  {
    id: 'olas', grupo: 'surtir', de: 'sucursal',
    label: 'Surtidos sin empezar o a medias', accion: 'Asígnalo, tómalo o termínalo',
    ruta: '/almacen/surtido-consola', ventana: null, anyOf: [Permission.ALMACEN_SURTIDO_COORDINAR],
    sql: Q.SQL_OLAS, fuente: "picking_waves.status IN ('abierta','en_surtido') (consola)",
  },
  {
    id: 'preventa-sin-terminar', grupo: 'surtir', de: 'sucursal',
    label: 'Pedidos de preventa a medio surtir', accion: 'Termina el surtido',
    ruta: '/almacen/surtir-preventa', ventana: null, anyOf: [Permission.COMMERCIAL_PICKING_VER, Permission.COMMERCIAL_PICKING_GESTIONAR],
    sql: Q.SQL_PREVENTA_SIN_TERMINAR, fuente: 'presale-picking.service.ts (finished_at IS NULL)',
  },
  {
    id: 'preventa-por-revisar', grupo: 'surtir', de: 'sucursal',
    label: 'Preventa surtida sin revisión en caja', accion: 'Revísala en caja',
    ruta: '/almacen/pedidos/revision', ventana: null, anyOf: [Permission.PREVENTA_GUIAS_GESTIONAR],
    sql: Q.SQL_PREVENTA_POR_REVISAR, fuente: 'presale-review.service.ts (review_required AND reviewed_at IS NULL)',
  },
  {
    id: 'guias', grupo: 'surtir', de: 'sucursal',
    label: 'Guías de carga sin liquidar', accion: 'Liquida la guía',
    ruta: '/almacen/pedidos/guias', ventana: null, anyOf: [Permission.PREVENTA_GUIAS_GESTIONAR],
    sql: Q.SQL_GUIAS, fuente: "load_guides.status IN ('abierta','impresa') sin liquidación",
  },
  {
    id: 'checado', grupo: 'surtir', de: 'sucursal',
    label: 'Pedidos a medio checar', accion: 'Termina el checado',
    ruta: '/almacen/checar', ventana: null, anyOf: [Permission.ALMACEN_CHECADO_GESTIONAR],
    sql: Q.SQL_CHECADO, fuente: "order_checks.status = 'en_checado'",
  },
  // ── Caja ──────────────────────────────────────────────────────────────────────────────────
  {
    id: 'turnos-sin-arqueo', grupo: 'caja', de: 'sucursal',
    label: 'Turnos de caja cerrados sin arqueo', accion: 'Captura el arqueo de cierre',
    ruta: '/tienda/arqueo', ventana: 'últimos 7 días', anyOf: [Permission.STORE_ARQUEO_VER, Permission.STORE_ARQUEO_CAPTURAR],
    sql: Q.SQL_TURNOS_SIN_ARQUEO, fuente: 'blind-count.service.ts turnosPendientes (sin arqueo de cierre del folio)',
  },
  {
    id: 'arqueos-por-validar', grupo: 'caja', de: 'sucursal',
    label: 'Arqueos de cierre sin la firma de la encargada', accion: 'Valídalo con la cajera',
    ruta: '/tienda/arqueos', ventana: 'últimos 7 días', anyOf: [Permission.RECONCILIATION_VER],
    sql: Q.SQL_ARQUEOS_POR_VALIDAR, fuente: "blind-count.service.ts validar (tipo 'cierre', validado_at IS NULL)",
  },
  // ── Inventario ────────────────────────────────────────────────────────────────────────────
  {
    id: 'conteos', grupo: 'inventario', de: 'sucursal',
    label: 'Conteos de inventario abiertos', accion: 'Cuenta o concilia',
    ruta: '/almacen/inventory/count', ventana: null, anyOf: [Permission.COMMERCIAL_INVENTORY_CONTAR],
    sql: Q.SQL_CONTEOS, fuente: "inventory_counts.status IN ('open','counting','review','ready_to_reconcile')",
  },
  {
    id: 'faltantes-piso', grupo: 'inventario', de: 'otra_area',
    label: 'Faltantes de piso esperando decisión', accion: 'Los decide Compras',
    ruta: '/tienda/faltantes', ventana: null, anyOf: [Permission.STORE_STOCKOUT_VER, Permission.STORE_STOCKOUT_CAPTURAR],
    sql: Q.SQL_FALTANTES_PISO, fuente: "floor_stockouts.status IN ('open','in_progress')",
  },
  {
    id: 'negativos', grupo: 'inventario', de: 'otra_area',
    label: 'Productos con existencia negativa en Kepler', accion: 'Los revisa Prevención',
    ruta: '/almacen/incidencias', query: () => ({ vista: 'negativos' }), ventana: 'hoy',
    anyOf: [Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER],
    sql: Q.SQL_NEGATIVOS, fuente: 'negative-stock.service.ts (sin revisión viva)',
  },
  // ── Administración ────────────────────────────────────────────────────────────────────────
  {
    id: 'gastos-devueltos', grupo: 'administracion', de: 'sucursal',
    label: 'Gastos que te devolvieron', accion: 'Corrígelo y vuelve a mandarlo',
    ruta: '/finanzas/mis-gastos', ventana: null, anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
    sql: Q.SQL_GASTOS_DEVUELTOS, fuente: "expense_proofs.status = 'rechazada' (mis-gastos-abiertos.ts)",
  },
  {
    id: 'gastos-esperan-factura', grupo: 'administracion', de: 'sucursal',
    label: 'Gastos aprobados que esperan su factura', accion: 'Sube la factura',
    ruta: '/finanzas/mis-gastos', ventana: null, anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
    sql: Q.SQL_GASTOS_ESPERAN_FACTURA, fuente: "expense_proofs.status = 'aprobada' (mis-gastos-abiertos.ts)",
  },
  {
    id: 'gastos-en-revision', grupo: 'administracion', de: 'otra_area',
    label: 'Gastos en revisión', accion: 'Los revisa Finanzas',
    ruta: '/finanzas/mis-gastos', ventana: null, anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR],
    sql: Q.SQL_GASTOS_EN_REVISION, fuente: "expense_proofs.status IN ('recibida','revision')",
  },
  {
    id: 'tickets', grupo: 'administracion', de: 'sucursal',
    label: 'Solicitudes de servicio que esperan a la sucursal', accion: 'Confírmala o responde lo que te piden',
    ruta: '/servicio/solicitudes', ventana: null, anyOf: [Permission.SERVICIO_REPORTAR],
    sql: Q.SQL_TICKETS, fuente: "servicedesk.requests resuelto, o en_espera por el solicitante (sin confidenciales)",
  },
  {
    id: 'cotizaciones', grupo: 'administracion', de: 'sucursal',
    label: 'Cotizaciones en borrador sin enviar', accion: 'Envíala o ciérrala',
    ruta: '/telemarketing/cotizaciones', ventana: 'vigentes',
    // La ruta pide las DOS llaves (dos guards): con una sola, el enlace rebotaría.
    anyOf: [Permission.COMMERCIAL_QUOTES_VER], allOf: [Permission.COMMERCIAL_QUOTES_VER, Permission.COMMERCIAL_TELEVENTA_OPERATE],
    sql: Q.SQL_COTIZACIONES, fuente: "quotes.status = 'draft' AND valid_until >= hoy",
  },
  {
    id: 'fichas', grupo: 'administracion', de: 'sucursal',
    label: 'Fichas de catálogo por recapturar', accion: 'Recaptura la ficha',
    ruta: '/levantamiento', ventana: null, anyOf: [Permission.CATALOGO_LEVANTAR],
    sql: Q.SQL_FICHAS, fuente: "levantamiento.service.ts (status IN ('en_captura','recapturar'))",
  },
  {
    id: 'domicilio', grupo: 'surtir', de: 'otra_area',
    label: 'Pedidos a domicilio sin despachar', accion: 'Los despacha Reparto',
    ruta: '/reparto/asignar', ventana: null, anyOf: [Permission.REPARTO_DESPACHAR],
    sql: Q.SQL_DOMICILIO, fuente: "home_deliveries.status = 'pendiente'",
  },
];

/**
 * «Lo que te va a llegar» no es una consulta de este registro: es `AutoabastoPedidoService.viene`, el
 * mismo que pinta la mesa. Aquí sólo se reparte en colas. La llave es la de Autoabasto.
 */
export const LLAVE_VIENE = Permission.AUTOABASTO_VER;

export function colasDeViene(documentos: AutoabastoVieneDoc[], tope: number): ColaSucursal[] {
  const fila = (d: AutoabastoVieneDoc, detalle: string) => ({ folio: d.folio, detalle, dias: d.dias, monto: d.monto });
  const viejoPrimero = (a: AutoabastoVieneDoc, b: AutoabastoVieneDoc) => b.dias - a.dias || a.folio.localeCompare(b.folio);
  const de = (nombre: string) => warehouseName(nombre) || 'una sucursal sin nombre';
  const cola = (
    id: string, grupo: GrupoPendienteSucursal, quien: 'sucursal' | 'otra_area', label: string, accion: string,
    docs: AutoabastoVieneDoc[], detalle: (d: AutoabastoVieneDoc) => string,
  ): ColaSucursal => {
    const orden = [...docs].sort(viejoPrimero);
    return {
      id, grupo, de: quien, label, accion, ruta: '/almacen/autoabasto', query: null, ventana: 'últimos 30 días',
      estado: 'ok', total: orden.length, mas_viejo_dias: orden.length ? orden[0].dias : null,
      filas: orden.slice(0, tope).map((d) => fila(d, detalle(d))),
    };
  };
  const embarques = documentos.filter((d) => d.tipo === 'embarque');
  const rechazadas = documentos.filter((d) => d.tipo === 'requisicion' && d.estado === 'RECHAZADA');
  const pedidos = documentos.filter((d) => d.tipo === 'pedido');
  const conCompras = documentos.filter((d) => (d.tipo === 'requisicion' && d.estado !== 'RECHAZADA') || d.tipo === 'plan');
  return [
    cola('traspasos-sin-recibir', 'recibir', 'sucursal', 'Traspasos que te mandaron, sin recibir en Kepler',
      'Captura la recepción en Kepler', embarques, (d) => `De ${de(d.origen)} · ${d.renglones} productos`),
    cola('requisiciones-rechazadas', 'administracion', 'sucursal', 'Requisiciones que Compras rechazó',
      'Lee el motivo y vuelve a pedir si hace falta', rechazadas, (d) => (d.motivo ? `Motivo: ${d.motivo}` : 'Compras no escribió el motivo')),
    cola('pedidos-sin-embarcar', 'recibir', 'otra_area', 'Pedidos de traspaso sin embarcar',
      'Los embarca la sucursal que surte', pedidos, (d) => `${de(d.origen)} · ${d.estado.toLowerCase()}`),
    cola('requisiciones-con-compras', 'administracion', 'otra_area', 'Requisiciones esperando a Compras',
      'Las decide Compras', conCompras, (d) => d.estado.toLowerCase()),
  ];
}

/** Lo que se buscó en la Suite y NO entra, con su porqué (FASE_AB §16.23). Se muestra en la pantalla. */
export const FUERA_DE_PENDIENTES: ReadonlyArray<{ label: string; motivo: string }> = [
  { label: 'Pedidos de WhatsApp por aprobar', motivo: 'No guardan la sucursal.' },
  { label: 'Carga al camión', motivo: 'No guarda la sucursal y sólo existe en la app del vendedor.' },
  { label: 'Cambios de precio por re-etiquetar', motivo: 'No es una cola: no hay un estado de «ya se imprimió».' },
  { label: 'Retiros en caja', motivo: 'Es un registro, no algo que quede pendiente.' },
  { label: 'Hojas de caducidad en borrador', motivo: 'Flujo retirado el 2026-09-08; se reemplazó por Caducidades de tienda.' },
  { label: 'Arqueo de Caja General por autorizar', motivo: 'Lo autoriza Tesorería, no la sucursal.' },
  { label: 'Conteo de camión', motivo: 'Es por ruta, no por sucursal.' },
  { label: 'Hallazgos de reabasto', motivo: 'Son del motor de Compras (24,038 abiertos en la red); no son trabajo de la sucursal.' },
  { label: 'Incidencias de asistencia', motivo: 'Sólo las atiende RH.' },
  { label: 'Cortes de sucursal', motivo: 'Los concilia Finanzas; lo que le toca a la sucursal —el arqueo que falta— ya está en «Turnos sin arqueo».' },
  { label: 'Clientes nuevos sin clave de Kepler', motivo: 'Su cuenta se deriva en su propia pantalla y todavía no se conecta aquí. Está en Almacén › Clientes nuevos.' },
  { label: 'Pedidos surtidos por capturar en Kepler', motivo: 'Todavía no se verificó contra Kepler qué cuenta como pendiente.' },
];
