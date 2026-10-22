/**
 * `[PGP.6]` La FORMA del wire de **«la deuda que todavía no está programada»**
 * (`GET /commercial/supplier-obligations/pendiente-vivo` y su `POST .../desde-documento`).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Para que el Calendario de Pagos pueda asignarle un día a una factura, esa factura tiene que
 * ser una **obligación** (`commercial.supplier_payment_obligations`). Hoy sólo hay un camino que
 * las crea: `[TP.15]`, aceptar un renglón de entrega de compra. Medido en prod el 2026-10-22:
 *
 *     deuda viva de mercancía (C*)      1,740 documentos   $92,846,437
 *     …con obligación en el Calendario     33 (1.9 %)       $2,714,042 (2.9 %)
 *
 * Y el camino que existe sólo alcanza a la compra **nueva**: arrancó en octubre de 2026. La
 * deuda anterior —**$90.1 M en 1,707 documentos**, con 539 de ellos a más de 90 días vencidos—
 * nunca pasó por una entrega y nunca va a pasar. **No tiene ningún camino.**
 *
 * ── ⛔ Por qué esto NO es un importer ───────────────────────────────────────────────────────
 *
 * La regla principal del proyecto prohíbe copiar: volcar los 1,707 documentos a la tabla de
 * obligaciones sería una **segunda materialización** de una deuda que ya vive en `kdxe`, y
 * habría que mantenerla sincronizada para siempre.
 *
 * Acá no se vuelca nada. La lista **es una lectura del ODS** y la obligación se crea **de a una,
 * cuando alguien decide programar ese documento** — con su procedencia escrita (`kepler_*`), que
 * es lo que permite volver a cruzarla contra el ERP. Es el mismo `INSERT` de `[TP.15]`, con otro
 * disparador.
 *
 * ── ⭐⭐ El monto NO viaja en el payload, y es la decisión más importante de este contrato ──
 *
 * `POST .../desde-documento` recibe **sólo la coordenada del documento**. El importe se lee del
 * pendiente vivo en el instante de crear la obligación.
 *
 * Si el monto viniera del cliente, la pantalla podría mandar uno que ya no es cierto —y nadie lo
 * notaría hasta pagar de más. No es hipotético: `[TP.15]` lo midió del otro lado, cuando copiaba
 * el importe de la entrega en vez del saldo de Kepler, y **de 38 aceptados, 21 ya no debían nada
 * y 2 debían menos**. La misma trampa, por la otra puerta.
 */

/** Un documento de Kepler que debe dinero y todavía no es una obligación del Calendario. */
export interface DocumentoProgramable {
  /** Sucursal del Kepler donde vive el documento. Se muestra **por nombre**, nunca como código. */
  sucursal: string;
  /** Clave del acreedor en Kepler (`C*` mercancía, `G*` servicios). */
  proveedor: string;
  proveedor_nombre: string;
  /** `catalog.suppliers.id`, o `null` si su clave no resuelve al catálogo de la suite. */
  supplier_id: string | null;
  /** La coordenada completa del documento: con ella se vuelve a encontrar en el ERP. */
  doc_tipo: number;
  doc_sub: number;
  folio: string;
  /** Qué documento es, en palabras (`kdmm`): «Aplica Orden Entrada», etc. */
  documento: string;
  /** AAAA-MM-DD. `null` = Kepler no le puso fecha (el `1800` del ERP ya viene traducido a null). */
  vencimiento: string | null;
  /** Días vencido a hoy. Negativo = todavía no vence. `null` si no tiene fecha. */
  dias_vencido: number | null;
  /** Lo que el documento todavía debe, en pesos. **Es el importe que tomaría la obligación.** */
  pendiente: number;
  /**
   * `[PO]` `true` si el documento vive en el Kepler de una **sucursal** con fecha anterior al
   * 2026-10-01. Hasta esa fecha el CEDIS concentraba los pagos, así que muchos de ésos se
   * pagaron desde ahí y nunca se aplicaron en la sucursal: **no es seguro que sea deuda**. Se
   * marca en vez de esconderse, y se ordena al final.
   */
  anterior_al_corte: boolean;
}

/** El universo de la consulta, para que el número se pueda verificar (ADR-056). */
export interface DeudaProgramableUniverso {
  /** Documentos con saldo vivo en la selección, tengan obligación o no. */
  documentos_total: number;
  pendiente_total: number;
  /** Los que YA son obligación del Calendario: el avance. */
  documentos_programados: number;
  pendiente_programado: number;
  /** `pendiente_programado / pendiente_total`. **Ésta es la métrica de O2.** */
  pct_programado: number;
  /** De los NO programados, cuántos no resuelven a `catalog.suppliers` (no se les puede crear obligación). */
  documentos_sin_catalogo: number;
  pendiente_sin_catalogo: number;
  /** Cuántas filas devuelve la página contra cuántas hay: una lista que se topa **lo dice**. */
  mostrados: number;
  hay_mas: boolean;
  /** Fecha de corte de «vencido» (hoy en hora de México, AAAA-MM-DD). */
  al: string;
}

export interface DeudaProgramableResponse {
  universo: DeudaProgramableUniverso;
  /** Ordenados por lo que primero hay que decidir: vencido hace más tiempo y de más monto. */
  documentos: DocumentoProgramable[];
}

/**
 * Lo que se manda para programar un documento. **Sólo la coordenada**: ni el monto ni el
 * vencimiento, que se leen del pendiente vivo al crear.
 */
export interface ProgramarDocumentoDto {
  sucursal: string;
  proveedor: string;
  doc_tipo: number;
  doc_sub: number;
  folio: string;
  /** Opcional: queda en `notes` de la obligación. Por qué se decidió programar este documento. */
  motivo?: string | null;
}

/** Lo que devuelve el alta, para que la pantalla pueda decir qué pasó sin volver a preguntar. */
export interface ProgramarDocumentoResultado {
  /** `creada` · `ya_existia` (alguien se adelantó) · `sin_saldo` (ya no debe nada: no se crea). */
  resultado: 'creada' | 'ya_existia' | 'sin_saldo';
  obligacion_id: string | null;
  /** El importe que de verdad tomó la obligación, leído del ODS. */
  importe: number | null;
  vencimiento: string | null;
}
