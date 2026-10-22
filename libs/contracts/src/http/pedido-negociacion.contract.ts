/**
 * `[RA-NEG.1]` COSTO Y NEGOCIACIÓN de un producto, dentro del desglose de `/compras/pedido`.
 *
 * Pedido del PM (2026-10-22): *«donde vemos costo, margen, precio, todas las herramientas que nos
 * servirían para negociar con el proveedor»*. Esos datos YA existían, repartidos en seis pantallas
 * (Costo estándar, Historial de costos, Descuentos, Costo neto, Plazos, Reclamos) y ninguna se abría
 * desde el pedido. Este contrato los junta para UN producto y su proveedor, y declara lo que no se
 * pudo medir en vez de dibujarlo como cero (ADR-056).
 *
 * ── De dónde sale cada cosa (medido contra prod el 2026-10-22 con 70056 La Rosa Mazapán) ─────────
 *  - Costo, precio y margen: `analytics.v_kepler_standard_cost` — el MISMO número que publica
 *    `/compras/costo-estandar`; no se recalcula.
 *  - Lo pagado: las órdenes de entrada `X-A-20` de Kepler (`kdm1`/`kdm2`), sólo las del proveedor del
 *    producto, convertidas a la unidad BASE con la escalera de la ficha. Lo que no se puede convertir
 *    se CUENTA (`renglones_sin_unidad`), no se adivina.
 *  - Proveedor: recepciones, pagos y notas de 12 meses (`analytics.erp_*`), plazo de
 *    `catalog.suppliers` y la tasa de pronto pago de `commercial.supplier_discount_policy`.
 *
 * ⚠️ La tasa de pronto pago casi siempre es OBSERVADA (`source = 'observed'`): sale del historial de
 * pagos, no de un contrato. Viaja su `fuente` para que la pantalla lo diga.
 *
 * ⚠️ El «pedido típico» del proveedor NO viaja acá: ya lo publica la fila (`min_order_amount`,
 * `[RA-PRO.69]`). Un segundo cálculo del mismo concepto daría otra cifra — medido: $1.28 M contra
 * $713 K para La Rosa — y la pantalla se contradiría.
 */

/** Un mes de lo pagado al proveedor, en la unidad BASE del producto. */
export interface NegociacionPagoMes {
  /** `AAAA-MM` */
  mes: string;
  /** Unidades base recibidas en el mes. */
  base: number;
  /** Costo promedio ponderado por unidad base. */
  promedio: number;
  min: number;
  max: number;
}

/** `[RA-NEG.3]` Una entrada pagada al proveedor, en unidad base: el historial que se ve SIN salir del pedido. */
export interface NegociacionEntrada {
  fecha: string;
  /** Código de la plaza que recibió; `00` = capturada en oficinas sin plaza resuelta. */
  sucursal: string;
  base: number;
  costo_base: number;
}

/** `[RA-NEG.3]` Un pago al proveedor que salió SIN el descuento por pronto pago. */
export interface NegociacionPagoSinDescuento {
  fecha: string;
  folio: string;
  sucursal: string;
  monto: number;
}

/** Entradas recientes registradas EXACTAMENTE al costo estándar: puede ser un precio mejor o una captura. */
export interface NegociacionAlEstandar {
  /** Código de la sucursal que recibió (la plaza). La pantalla la NOMBRA, nunca pinta el código. */
  sucursal: string;
  entradas: number;
  base: number;
  costo_base: number;
}

export interface NegociacionCosto {
  /** Costo estándar de Kepler (`kdii.c77`) por unidad base. */
  estandar_base: number | null;
  /**
   * Costo de REPOSICIÓN por unidad base (`kdik.c16`, la última entrada) de la sucursal que más vende:
   * con el que se valúa el pedido. Es «lo de hoy» para negociar — no la última entrada suelta, que
   * puede ser justo la que cayó al estándar (medido con 70056: la última fue la de Canindo).
   */
  reposicion_base: number | null;
  /** Precio de ficha CON impuesto por unidad base, de la sucursal que más vende. */
  precio_ficha: number | null;
  /** Tasa observada en ventas. `null` = no se sabe (el producto no vende), no 0. */
  impuesto_pct: number | null;
  /** ¿Las sucursales con ficha tienen el mismo precio? Si no, la pantalla no habla de «el precio». */
  precio_igual_en_todas: boolean;
  /** Margen que calcula la ficha (precio ÷ estándar). */
  margen_ficha_pct: number | null;
  /** Precio por unidad base que conserva el margen de la ficha con el costo de reposición. */
  precio_conserva_margen: number | null;
  /** Costo de más en 30 días por vender con el estándar desfasado (suma de las sucursales afectadas). */
  impacto_30d: number;
  /** Sucursales donde el estándar quedó abajo del costo de reposición (códigos). */
  sucursales_afectadas: string[];
}

export interface NegociacionPagado {
  desde: string;
  hasta: string;
  meses: NegociacionPagoMes[];
  ultimo: { fecha: string; sucursal: string; costo_base: number } | null;
  minimo: { fecha: string; sucursal: string; costo_base: number; base: number } | null;
  /** Unidades base y dinero de 12 meses, de ESTE producto a ESTE proveedor. */
  total_base: number;
  total_valor: number;
  renglones: number;
  /** Renglones cuya unidad no está en la escalera de la ficha: no se convierten ni se suman. */
  renglones_sin_unidad: number;
  /**
   * Renglones con un costo fuera de 0.2×–5× la mediana: bonificaciones a centavo o capturas rotas
   * (medido: 95434 traía uno a $0.0006). No entran al mínimo ni al promedio; se cuentan.
   */
  renglones_atipicos: number;
  al_estandar_reciente: NegociacionAlEstandar[];
  /** `[RA-NEG.3]` Las últimas entradas (hasta `MAX_ENTRADAS_NEGOCIACION`), de la más reciente a la más vieja. Sin las atípicas. */
  entradas: NegociacionEntrada[];
}

export interface NegociacionProntoPago {
  /** Tasa esperada (0–1). */
  tasa: number;
  /** `observed` = derivada del historial; otra cosa = capturada. */
  fuente: string | null;
  pagos: number;
  sin_descuento: number;
  monto_sin_descuento: number;
  /** `tasa × monto_sin_descuento`: estimado, no un hecho. */
  estimado_perdido: number;
  ultimo_sin_descuento: string | null;
  /**
   * `[RA-NEG.3]` Los últimos pagos sin descuento (hasta 15). `null` = quien consulta no tiene permiso de ver
   * Descuentos: se DECLARA, no se manda vacío (vacío se leería «todos los pagos llevaron descuento»).
   */
  ultimos_sin_descuento: NegociacionPagoSinDescuento[] | null;
}

export interface NegociacionProveedor {
  supplier_id: string;
  nombre: string;
  compras_12m: number;
  recepciones_12m: number;
  descuento_pago_12m: number;
  descuento_notas_12m: number;
  /** `null` = no hubo compras contra qué medir. */
  descuento_pct: number | null;
  /** `null` = el proveedor no tiene tasa de pronto pago (no la da, o nadie la midió). */
  pronto_pago: NegociacionProntoPago | null;
  plazo_dias: number | null;
  plazo_base: string | null;
  /** Lo que dicen las recepciones de Kepler, de la más usada a la menos. */
  plazo_kepler: { dias: number | null; recepciones: number }[];
  /** `null` = no capturado (el motor supone 7). */
  tiempo_entrega_dias: number | null;
  /** Reclamos de recepción (cualquier estado): los del proveedor y los de TODA la base, para no leer «0» como «nada faltó». */
  reclamos: { del_proveedor: number; en_la_base: number };
}

export interface PedidoNegociacionDto {
  product_id: string;
  sku: string;
  unidad_base: string | null;
  /** Unidades base por caja (la escalera de la ficha). `null` = el producto no tiene caja. */
  base_por_caja: number | null;
  costo: NegociacionCosto;
  pagado: NegociacionPagado;
  /** `null` = el producto no tiene proveedor en el catálogo. */
  proveedor: NegociacionProveedor | null;
  generado_at: string;
}

/** `[RA-NEG.3]` Cuántas entradas viajan para el historial del panel (las demás están resumidas por mes). */
export const MAX_ENTRADAS_NEGOCIACION = 40;

/** Margen sobre costo, como lo expresa Kepler: precio SIN impuesto ÷ costo − 1, en %. */
export function margenSobreCosto(precioConImpuesto: number | null, impuestoPct: number | null, costo: number | null): number | null {
  if (precioConImpuesto == null || impuestoPct == null || costo == null || !(costo > 0)) return null;
  return (precioConImpuesto / (1 + impuestoPct / 100) / costo - 1) * 100;
}

// ── Las ACCIONES: qué hacer, en pocas palabras ────────────────────────────────────────────────
// Pedido del PM (2026-10-22): «solo en los enunciados, arranquemos en pocas palabras qué debe hacer,
// negociar, pedir, etc». Cada acción es VERBO + QUÉ + la cifra que lo justifica, y una sola línea.

export type TonoAccion = 'warn' | 'info';
export interface AccionNegociacion {
  clave: 'negocia' | 'sube' | 'pide' | 'confirma';
  verbo: string;
  que: string;
  por: string;
  tono: TonoAccion;
  /**
   * `[RA-NEG.3]` Qué detalle abre, DENTRO del pedido: `historial` (lo pagado y los costos) o `descuentos`.
   * Antes era una ruta a otra pantalla, y salir del pedido perdía la requisición en armado.
   */
  detalle: 'historial' | 'descuentos' | null;
}

/** Diferencia por debajo de la cual dos costos se toman como iguales (centavos de redondeo). */
const TOLERANCIA = 0.005;

const pesos = (v: number, dec = 2): string =>
  '$' + v.toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const millones = (v: number): string =>
  v >= 1e6 ? '$' + (v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 }) + ' M'
    : v >= 1e3 ? '$' + Math.round(v / 1e3).toLocaleString('es-MX') + ' mil' : pesos(v, 0);

/**
 * Las acciones de negociación que salen de los datos. Ninguna se inventa: si falta el dato que la
 * justifica, la acción no aparece.
 *
 * @param nombreSucursal resuelve un código a su NOMBRE (la regla del PM: jamás «06», siempre «Canindo»).
 */
export function accionesNegociacion(d: PedidoNegociacionDto, nombreSucursal: (code: string) => string): AccionNegociacion[] {
  const out: AccionNegociacion[] = [];
  const bpc = d.base_por_caja && d.base_por_caja > 0 ? d.base_por_caja : null;
  const enCaja = (vBase: number) => (bpc ? pesos(vBase * bpc) + ' la caja' : pesos(vBase) + ' ' + (d.unidad_base ?? '').toLowerCase());
  const est = d.costo.estandar_base;
  const ult = d.costo.reposicion_base ?? d.pagado.ultimo?.costo_base ?? null;

  // NEGOCIA — se paga más que el costo con el que Kepler fija el precio.
  if (est != null && ult != null && ult - est > TOLERANCIA) {
    out.push({
      clave: 'negocia', verbo: 'Negocia', que: enCaja(est), tono: 'warn', detalle: 'historial',
      por: '(hoy ' + enCaja(ult).replace(' la caja', '') + ')',
    });
  }
  // O SUBE — la otra salida, sólo si el desfase ya cuesta y el precio es uno solo.
  const pc = d.costo.precio_conserva_margen, pf = d.costo.precio_ficha;
  if (pc != null && pf != null && pc - pf > TOLERANCIA && d.costo.impacto_30d > 0 && d.costo.precio_igual_en_todas) {
    out.push({
      clave: 'sube', verbo: out.length ? 'O sube' : 'Sube', que: 'el precio a ' + pesos(pc), tono: 'warn', detalle: 'historial',
      por: '(' + millones(d.costo.impacto_30d) + ' de más en 30 días)',
    });
  }
  // PIDE — pronto pago que no se tomó.
  const pp = d.proveedor?.pronto_pago;
  if (pp && pp.sin_descuento > 0 && pp.estimado_perdido > 0) {
    out.push({
      clave: 'pide', verbo: 'Pide', que: 'el pronto pago', tono: 'warn', detalle: 'descuentos',
      por: '(≈ ' + millones(pp.estimado_perdido) + ' sin tomar en ' + pp.sin_descuento + ' pagos)',
    });
  }
  // CONFIRMA — una entrada al estándar exacto: puede ser el mejor argumento o un error de captura.
  for (const a of d.pagado.al_estandar_reciente.slice(0, 1)) {
    // `00` aquí NO es una plaza: es lo capturado en oficinas cuya plaza no se pudo resolver.
    const donde = a.sucursal === '00' ? 'capturado en oficinas' : 'de ' + nombreSucursal(a.sucursal);
    out.push({
      clave: 'confirma', verbo: 'Confirma', que: 'el ' + pesos(a.costo_base) + ' ' + donde, tono: 'info', detalle: 'historial',
      por: 'en la factura: es el costo estándar al centavo',
    });
  }
  return out;
}
