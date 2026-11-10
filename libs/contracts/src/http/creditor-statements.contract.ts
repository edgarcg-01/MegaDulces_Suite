/**
 * `[ECA.1]` La FORMA del wire del Estado de cuenta de acreedores (`/finanzas/estado-cuenta-acreedores`).
 *
 * Es el reporte "Estado de cuenta del proveedor" de Kepler, leído del ODS: cada documento que
 * SUBE la deuda (abono `A`: "Aplica Orden Entrada", etc.) con los cargos `D` que lo pagaron
 * ("Transferencia a proveedor", "Nota crédito"…) casados debajo, y su saldo.
 *
 *  · Documentos   = `kepler_ods.kdxe` (cuentas por pagar de Kepler).
 *  · Casamiento   = `kepler_ods.kdxf`: "el cargo (c4,c5,c6) se aplicó al abono (c7,c8,c9) por c10".
 *                   Medido en prod 2026-10-07: 30,073 de 30,073 aplicaciones van de un `D` a un `A`.
 *                   Es estructural (lo hizo Kepler), NO una estimación FIFO como la de CXP.8.
 *
 * La LÓGICA (clasificación por tipo y armado del estado de cuenta) vive en
 * `libs/finance/src/lib/creditor-statements/creditor-statements.engine.ts`; acá sólo la forma.
 */

/**
 * Tipo de acreedor. Lo decide el catálogo de proveedores de Kepler (`kdxd`): la clave (`C*` compra,
 * `G*` gasto, `A*` acreedor, `TC*` tarjeta, `TI*` traspaso) y el Grupo (`c13`) cuando se captura.
 *  · `mercancia`      — proveedores de mercancía (clave `C*`).
 *  · `servicios`      — proveedores de servicios y gasto (clave `G*`), INCLUIDOS los bancos `GB*`:
 *                       lo que se les debe son comisiones, no créditos (decisión de Francisco, 2026-10-07).
 *  · `financiero`     — deuda: préstamos (`A*`), factoraje (`B.B.*`), tarjetas de crédito (`TC*`)
 *                       y los grupos de financiamiento.
 *  · `interno`        — traspasos entre sucursales (`TI*`). No es deuda con un tercero: no se lista.
 *  · `sin_clasificar` — lo que ninguna regla reconoce. Se muestra, no se adivina.
 */
export type AcreedorTipo = 'mercancia' | 'servicios' | 'financiero' | 'interno' | 'sin_clasificar';

/**
 * Cómo está un documento que sube la deuda, según lo que Kepler le aplicó. `cancelado`: el documento
 * está cancelado en Kepler (`kdm1.c43='C'`) — no debe nada y no se le resta nada.
 */
export type AcreedorDocEstado = 'pendiente' | 'parcial' | 'pagado' | 'sobreaplicado' | 'cancelado';

export interface AcreedorTipoTotal {
  tipo: AcreedorTipo;
  acreedores: number;
  /** Σ saldo de los documentos que suben la deuda y todavía no tienen pago aplicado completo. */
  pendiente: number;
  /** La parte de `pendiente` cuyo vencimiento ya pasó. */
  vencido: number;
  /** Pagos/notas registrados en Kepler que todavía no se aplicaron a ningún documento (saldo a favor). */
  pagos_sin_aplicar: number;
  /** Σ saldo de documentos (los sobreaplicados restan) − `pagos_sin_aplicar`. */
  saldo: number;
  /**
   * La parte de `pendiente` que está en el Kepler de una SUCURSAL (no el 00) con fecha anterior al
   * 1-oct-2026. Hasta esa fecha el 00 concentraba: muchas de esas facturas se pagaron desde el 00 y
   * nunca se aplicaron en la sucursal. Se DECLARA aparte porque no es seguro que sea deuda.
   */
  pendiente_sucursal_antes_corte: number;
}

export interface AcreedorResumen {
  codigo: string;
  nombre: string;
  rfc: string | null;
  /** Grupo del catálogo de Kepler (`kdxd.c13`). */
  grupo: string | null;
  /** Nombre del grupo. Deducido: el catálogo de nombres no llega al ODS (ver `GRUPOS_KEPLER`). */
  grupo_nombre: string | null;
  tipo: AcreedorTipo;
  /** Sucursales cuyo Kepler tiene documentos de este acreedor. */
  sucursales: string[];
  documentos_pendientes: number;
  pendiente: number;
  vencido: number;
  pagos_sin_aplicar: number;
  saldo: number;
  pendiente_sucursal_antes_corte: number;
  /** Fecha (AAAA-MM-DD) del documento más reciente. */
  ultimo_movimiento: string | null;
}

export interface AcreedoresResponse {
  /** Un renglón por tipo, incluidos los que vienen en cero. */
  totales: AcreedorTipoTotal[];
  /** Todos los acreedores con documentos, de todos los tipos. La pantalla filtra por tipo. */
  acreedores: AcreedorResumen[];
  /** Fecha de corte de "vencido" (hoy en hora de México, AAAA-MM-DD). */
  al: string;
}

/** Un cargo (pago, nota de crédito…) aplicado a un documento. */
export interface AcreedorAplicacion {
  sucursal: string;
  /** Nombre del tipo de documento en Kepler (`kdmm`), p. ej. "Transferencia a proveedor". */
  documento: string;
  tipo_doc: number;
  folio: string;
  /** Fecha del documento que paga. */
  fecha: string | null;
  referencia: string | null;
  /** Lo que ESTE cargo le aplicó a ESTE documento (un pago puede repartirse entre varias facturas). */
  importe: number;
  /**
   * `[ECA.7]` El cargo o el documento está CANCELADO en Kepler (`kdm1.c43='C'`), pero la aplicación
   * sigue en `kdxf`. Se muestra para que se vea, y NO cuenta en `aplicado` ni en el saldo.
   */
  cancelado: boolean;
}

/**
 * `[ECA.8]` **Un pago del Calendario que tiene a esta factura.** Sólo pendientes y ejecutados: un pago
 * cancelado o rebotado no aparta nada y no se muestra.
 */
export interface AcreedorDocProgramado {
  allocation_id: string;
  /** Día del Calendario en que está el pago (AAAA-MM-DD). */
  fecha: string;
  estado: 'pendiente' | 'ejecutado';
  /** Pendiente en un día anterior a hoy: se programó y no se pagó. */
  dia_pasado: boolean;
  /** Lo que el pago cubre de ESTA factura (neto + descuento al pagar). */
  cubierto: number;
  /** Cuántas facturas lleva el pago y su total neto (un pago es una sola transferencia). */
  facturas_en_pago: number;
  total_pago: number;
  creado_por: string | null;
  /** Ejecutado: cuándo se marcó pagado (AAAA-MM-DD, hora de México), con qué y desde qué cuenta. */
  pagado_el: string | null;
  metodo: string | null;
  banco: string | null;
  referencia: string | null;
  /** Folio del pago de Kepler ligado a este pago del Calendario (`X-D-26`), si ya se ligó. */
  kepler_folio: string | null;
  /**
   * Ejecutado y Kepler YA aplicó ese pago a esta factura (está en sus aplicaciones). Entonces el saldo
   * de Kepler ya lo descuenta: no se resta otra vez ni se dice «Kepler aún no la aplica».
   */
  aplicado_en_kepler: boolean;
}

/** `[ECA.8]` Lo que el Calendario aparta de este acreedor, sobre los documentos mostrados. */
export interface AcreedorCalendario {
  /** `false`: no se pudo leer el Calendario. La pantalla lo DECLARA; no lo pinta como «nada programado». */
  medido: boolean;
  /** Σ de lo cubierto por pagos PENDIENTES. */
  programado: number;
  /** Documentos con al menos un pago pendiente. */
  documentos: number;
  /** Lo pendiente que ningún pago cubre todavía (nunca negativo). */
  sin_programar: number;
}

/** Documento que sube la deuda (abono `A`), con lo que se le aplicó. */
export interface AcreedorDocumento {
  sucursal: string;
  documento: string;
  tipo_doc: number;
  /** `[ECA.8]` Subtipo de Kepler (`kdxe.c5`): con sucursal, tipo y folio forma la llave del Calendario. */
  sub: number;
  folio: string;
  fecha: string | null;
  /** `null` cuando Kepler no trae vencimiento (fecha centinela 1800). */
  vence: string | null;
  referencia: string | null;
  importe: number;
  aplicado: number;
  saldo: number;
  estado: AcreedorDocEstado;
  vencido: boolean;
  /** `[ECA.7]` Cancelado en Kepler (`kdm1.c43='C'`): `aplicado` y `saldo` en cero. */
  cancelado: boolean;
  aplicaciones: AcreedorAplicacion[];
  /** `[ECA.8]` Pagos del Calendario que la tienen, por fecha. Vacío = ninguno. */
  programado: AcreedorDocProgramado[];
}

/** Cargo (`D`) con importe que todavía no se aplicó a ningún documento. */
export interface AcreedorPagoSinAplicar {
  sucursal: string;
  documento: string;
  tipo_doc: number;
  folio: string;
  fecha: string | null;
  referencia: string | null;
  importe: number;
  aplicado: number;
  remanente: number;
}

export interface AcreedorFicha {
  codigo: string;
  nombre: string;
  rfc: string | null;
  direccion: string | null;
  telefono: string | null;
  grupo: string | null;
  grupo_nombre: string | null;
  /** "Clasificaciones" del reporte de Kepler: zona (`c14`) y agente (`c12`). Sólo códigos. */
  zona: string | null;
  agente: string | null;
  tipo: AcreedorTipo;
  dias_credito: number | null;
  limite_credito: number | null;
}

export interface AcreedorEstadoCuentaResponse {
  acreedor: AcreedorFicha;
  /** `true`: sólo lo que tiene saldo (sin importar la fecha). `false`: todo el periodo. */
  solo_pendientes: boolean;
  /** Rango de fechas de documento cuando `solo_pendientes` es `false`. */
  periodo: { from: string; to: string } | null;
  documentos: AcreedorDocumento[];
  pagos_sin_aplicar: AcreedorPagoSinAplicar[];
  totales: {
    importe: number;
    aplicado: number;
    pendiente: number;
    vencido: number;
    pagos_sin_aplicar: number;
    saldo: number;
  };
  /** `[ECA.8]` */
  calendario: AcreedorCalendario;
  al: string;
}
