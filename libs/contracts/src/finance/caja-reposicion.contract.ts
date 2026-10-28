/**
 * `[CGA-A.61]` Reposición por sucursal: la forma del boundary REST.
 *
 * Edgar, 2026-10-28: *«con este reporte podemos automatizar todos los egresos y vincular un egreso
 * general con los egresos pequeños… sólo si tiene diferencia, que se agregue de la caja o salga de
 * la caja»*, y después *«hagámoslo, pero desde una sola interfaz para tener más practicidad»*.
 *
 * Cada sucursal paga sus gastos con su venta (`X-D-26` contra su `0011`) y Caja General se los
 * repone con un retiro de CAOS. Esto dice, por sucursal y día de pago, qué documentos de Kepler hay,
 * cuáles ya son egresos del libro, de qué retiro salió cada peso y qué falta — y PROPONE los
 * vínculos que faltan para que se confirmen de un clic en la misma pantalla.
 *
 * Sólo tipos (ADR-052): producer (`CashLedgerController`, `CaosController`) y consumer
 * (`/finanzas/caja-general`) importan lo mismo.
 */

/** La nómina va en su propio retiro («nom …»); el resto son gastos («gnf …»). */
export type ClaseReposicion = 'nomina' | 'gasto';

/**
 * De dónde salió el dinero de UN documento de Kepler:
 *  · `por_capturar` — todavía está en la cola, no es egreso del libro.
 *  · `sin_vincular` — es egreso, no dice «del cajón», y le falta por explicar al menos un billete.
 *  · `caos` — lo explica un retiro (lo que le falte es menos de un billete: sale del cajón).
 *  · `cajon` — el egreso dice que salió del cajón, o lo que le falta es menos de un billete.
 */
export type EstadoDocReposicion = 'por_capturar' | 'sin_vincular' | 'caos' | 'cajon';

/** Un vínculo vivo de un egreso con un retiro de CAOS. */
export interface ReposicionVinculo {
  link_id: string;
  device: string;
  external_id: number;
  ref: string | null;
  monto: number;
}

export interface ReposicionDoc {
  /** `sucursal|doc_tipo|folio|clave_banco`: la misma llave que la cola y el libro. */
  origen_ref: string;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  fecha_valor: string | null;
  fecha_captura: string | null;
  beneficiario: string | null;
  monto: number;
  clase: ClaseReposicion;
  /** `false`: el libro tiene el egreso y Kepler ya no tiene el documento (se canceló allá). */
  en_kepler: boolean;
  ledger_id: string | null;
  /** Folio de Caja General (`CG-2026-00512`). */
  cg_folio: string | null;
  origen_efectivo: string | null;
  enlazado: number;
  /** `monto - enlazado` de un egreso que no dice «del cajón»; 0 en los demás. */
  falta: number;
  estado: EstadoDocReposicion;
  vinculos: ReposicionVinculo[];
}

/** Por qué un retiro es candidato de una sucursal. */
export type AfinidadRetiro = 'nombra_la_sucursal' | 'ya_paga_la_sucursal';

/** Un retiro de CAOS con dinero libre, leído para la reposición. */
export interface ReposicionRetiro {
  device: string;
  external_id: number;
  occurred_at: string;
  /** Día de negocio (México) del retiro. */
  dia: string;
  ref: string | null;
  total: number;
  libre: number;
  /** Sucursales que nombra la referencia que se tecleó en CAOS (`nom canindo` → `['06']`). */
  sucursales_ref: string[];
  /** Clase que nombra la referencia (`nom` / `gnf`), o `null` si no nombra o nombra las dos. */
  clase_ref: ClaseReposicion | null;
  /** Sucursales cuyos egresos ya explica este retiro. */
  sucursales_vinculadas: string[];
}

/** Un vínculo que el motor propone: un egreso, un retiro, un monto. */
export interface ReposicionAsignacion {
  ledger_id: string;
  cg_folio: string;
  origen_ref: string;
  device: string;
  external_id: number;
  ref: string | null;
  monto: number;
}

/** Lo que el motor propone para los egresos sin vincular de UN grupo. Lo confirma una persona. */
export interface ReposicionPropuesta {
  asignaciones: ReposicionAsignacion[];
  monto: number;
  /** Lo que ni así queda explicado: sale del cajón. */
  queda: number;
  /** Las señales, en llano, para confirmar con criterio y no a ciegas. */
  razon: string;
}

export type EstadoGrupoReposicion = 'por_capturar' | 'sin_vincular' | 'explicada';

/** Una sucursal en un día de pago (`c9` de Kepler). */
export interface ReposicionGrupo {
  clave: string;
  fecha: string;
  sucursal: string;
  docs: ReposicionDoc[];
  total: number;
  por_capturar: number;
  n_por_capturar: number;
  /** Lo que explican los retiros vinculados. */
  caos: number;
  /** Lo que salió del cajón: egresos «del cajón» y lo que a cada egreso le falta de menos de un billete. */
  cajon: number;
  /** Lo que falta por explicar de los egresos sin vincular. */
  sin_vincular: number;
  n_sin_vincular: number;
  estado: EstadoGrupoReposicion;
  propuesta: ReposicionPropuesta | null;
  /** El retiro que el motor sugiere para «Reponer» lo que está por capturar. `null` = ninguno claro. */
  retiro_sugerido: { device: string; external_id: number; ref: string | null; libre: number; razon: string } | null;
}

export interface ReposicionSucursales {
  desde: string;
  hasta: string;
  grupos: ReposicionGrupo[];
  /** Los retiros con dinero libre que el motor consideró. */
  retiros: ReposicionRetiro[];
  /** Edad del dato de Kepler (latido del carril que escribe `kdm1`) y de CAOS. `null` = sin medir. */
  datos_al: string | null;
  caos_al: string | null;
  /** El universo: qué sucursales se miraron y cuáles no tuvieron un solo documento en la ventana. */
  universo: { sucursales: string[]; sin_documentos: string[]; excluidas: string[] };
}

/** `[CGA-A.61]` Varios vínculos de una vez (sólo superadmin): todo o nada. */
export interface VincularLoteInput {
  asignaciones: Array<{ ledger_id: string; device: string; external_id: number; monto: number }>;
  motivo?: string;
}

export interface VincularLoteResultado {
  ok: true;
  vinculos: number;
  monto: number;
}

/** `[CGA-A.61]` Pasar un vínculo a otro retiro (sólo superadmin): baja con motivo + alta, juntas. */
export interface MoverVinculoInput {
  device: string;
  external_id: number;
  motivo: string;
}

export interface MoverVinculoResultado {
  ok: true;
  link_baja: string;
  link_alta: string | null;
  /** Lo que tomó el retiro destino. */
  monto: number;
  /** Lo que el destino no alcanzó a tomar: queda por explicar (o sale del cajón). */
  queda: number;
}
