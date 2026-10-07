/**
 * `[RA-PRO.67]` Señales por SKU que el comprador necesita para juzgar una oferta en
 * `/compras/pedido`: el MARGEN de hoy y la VENTA PERDIDA. Viajan en cada fila del workbook
 * (`signals`), calculadas sólo sobre la página que se muestra.
 *
 * **Margen** = el MISMO número que publica `/compras/costo-estandar` (`margen_real_pct` de
 * `analytics.v_kepler_standard_cost`): precio de la ficha sin impuesto ÷ costo de REPOSICIÓN − 1.
 * Es margen **sobre el costo**, como lo expresa Kepler (`kdii` margen 23 % ⇒ 23 % acá). No se
 * recalcula: dos pantallas que dicen "margen" del mismo producto tienen que decir lo mismo.
 *
 * **Venta perdida** tiene DOS fuentes y viajan POR SEPARADO, cada una con su fecha, porque se apagan en
 * momentos distintos (la insignia de una sucursal sí las suma: no se traslapan, una empieza donde la
 * otra calla):
 *  - `wincaja`: los faltantes que Wincaja registraba en caja. ⚠️ **Se detiene en cada plaza el día
 *    que pasó a Kepler** (el último, el CEDIS, el 2026-09-30): Kepler NO registra faltantes. Que
 *    después no haya filas NO quiere decir que no falte nada — por eso viaja `ultimo_dato`.
 *  - `mostrador`: lo que reportan cajeras y anaquelistas en `/tienda/faltantes` (Fase FLT,
 *    `commercial.floor_stockouts`), sólo motivo `agotado`: es la fuente que sigue viva.
 */

/** Margen de UNA sucursal. `null` = no se pudo medir (sin costo de reposición o sin impuesto medido). */
export interface SkuMarginBranch {
  /** Margen sobre costo, en %. */
  m: number | null;
  /** Vende bajo costo al precio de hoy. */
  bc: boolean | null;
}

export interface SkuMarginSignal {
  /** Margen sobre costo de la red, ponderado por la venta neta de 30 días de cada sucursal. */
  margen_pct: number | null;
  margen_min: number | null;
  margen_max: number | null;
  sucursales_bajo_costo: number;
  /**
   * Margen sobre costo de LO QUE SE ESTÁ COMPRANDO: el precio de la ficha sin impuesto contra el
   * costo de caja del pedido (`caja_cost` del plan = el último costo pagado al proveedor) ÷ caja.
   * ⚠️ No es el mismo que `margen_pct`: ése usa el costo de REPOSICIÓN de Kepler, que arrastra lo que
   * se pagó antes. Medido 2026-10-02 con 95434 NIKOLO: compras de septiembre a $58–61/paq dejan
   * `margen_pct` en −20 %, y la OC del 1-oct a $40.39 deja esta compra en +17 %. Para DECIDIR una
   * compra importa éste; para saber si el inventario de hoy pierde, el otro.
   */
  margen_compra_pct: number | null;
  /**
   * Margen sobre costo con lo que REALMENTE se pagó en las compras recibidas
   * (`replenishment_plan.real_buy_cost`, por unidad base) y la fecha de la última. Es el testigo de
   * `margen_compra_pct`: la lista del proveedor en Kepler puede estar desfasada. Medido 2026-10-02
   * sobre las 239 fichas "bajo costo": la última OC salió al precio de lista en 131, más cara en 46
   * y más barata en 54. Cuando los dos márgenes se separan, la pantalla pide confirmar el precio.
   */
  margen_pagado_pct: number | null;
  ultima_compra: string | null;
  /** Precio de ficha (con impuesto) y costo de reposición por unidad base, de la sucursal que más vende. */
  precio_ficha: number | null;
  costo_reposicion_base: number | null;
  por_sucursal: Record<string, SkuMarginBranch>;
}

/** Venta perdida de UNA sucursal en la ventana. */
export interface SkuLostBranch {
  importe: number;
  reportes: number;
}

export interface SkuLostDemandSignal {
  /** Ventana medida: desde el primer día de hace 3 meses. */
  desde: string;
  wincaja: {
    /**
     * Importe VERIFICADO: sólo los renglones (sucursal × mes) cuyo precio implícito
     * (importe ÷ unidades) cae entre 0.6× y 1.3× el precio de la ficha de ALGÚN peldaño (pieza,
     * paquete o caja: Wincaja guarda la cantidad en su unidad de venta). ⚠️ Medido en prod el
     * 2026-10-02 sobre 2026: cuadra en 79–88 % de los renglones de tienda y sólo en 44.8 % del
     * CEDIS (00), donde $9.3M de $16.4M traen un importe de hasta 56× el precio — la cantidad y
     * el importe vienen en unidades distintas. Lo que no cuadra NO se suma: se cuenta en
     * `reportes_sin_verificar`.
     */
    importe: number;
    /** Reportes cuyo importe no cuadra con el precio de la ficha (o sin ficha contra qué medir). */
    reportes_sin_verificar: number;
    /** Unidades de los renglones verificados, como las registró Wincaja: pueden mezclar peldaños. No se publica en pantalla. */
    unidades: number;
    reportes: number;
    /** Último faltante que registró Wincaja para este SKU. Después de esta fecha la fuente calla. */
    ultimo_dato: string | null;
    por_sucursal: Record<string, SkuLostBranch>;
  };
  mostrador: {
    /** Reportes "agotado" de mostrador (veces reportado). */
    reportes: number;
    importe_estimado: number;
    ultimo: string | null;
    por_sucursal: Record<string, SkuLostBranch>;
  };
}

export interface WorkbookSkuSignals {
  margin: SkuMarginSignal | null;
  lost: SkuLostDemandSignal | null;
}
