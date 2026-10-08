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

/** Cómo está un documento que sube la deuda, según lo que Kepler le aplicó. */
export type AcreedorDocEstado = 'pendiente' | 'parcial' | 'pagado' | 'sobreaplicado';

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
}

/** Documento que sube la deuda (abono `A`), con lo que se le aplicó. */
export interface AcreedorDocumento {
  sucursal: string;
  documento: string;
  tipo_doc: number;
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
  aplicaciones: AcreedorAplicacion[];
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
  al: string;
}
