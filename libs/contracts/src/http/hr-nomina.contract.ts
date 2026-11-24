/**
 * Fase RH · frente NE · `[NE.2.3]` — EL PUENTE ENTRE EL PADRÓN DE NÓMINA Y EL DE LA SUITE.
 *
 * Lo que la API devuelve del empate que calcula `tiendePuente` (`libs/hr/.../puente-padrones.ts`)
 * y de lo que registra en `hr.person_aliases`.
 *
 * ⛔ **Acá no viajan nombres de personas.** El puente devuelve códigos, identificadores y conteos:
 * quién es cada quien ya lo dice la fila a la que apunta el alias. La pantalla que resuelve los
 * casos a mano (`[NE.2.5]`) pedirá los nombres por su propio camino, con su permiso.
 */

/** De dónde salió el padrón de nómina que se comparó. */
export type HrFuenteDeNomina = 'contpaqi';

/** Por qué una persona del padrón no quedó ligada. */
export type HrMotivoRechazoPuente = 'ambiguo' | 'solo-baja' | 'sin-candidato' | 'juicio' | 'choque';

export interface HrRechazoPuenteDto {
  /** Cómo nombra a la persona su sistema de nómina. */
  codigo: string;
  motivo: HrMotivoRechazoPuente;
  /** Qué habría que mirar para resolverlo, en palabras. Sin datos personales. */
  detalle: string;
}

export interface HrResumenPuenteDto {
  fuente: HrFuenteDeNomina;
  /** Ventana con la que se tomó el universo: quién COBRÓ en estos días. */
  dias: number;
  /** La fecha del pago más reciente que vio: dice de cuándo es el dato. */
  ultimoPago: string | null;
  universo: number;
  nivel1: number;
  nivel2: number;
  ligados: number;
  rechazados: number;
  /** Personas a las que su sistema de nómina les dio más de un código. */
  duplicadosEnElOrigen: number;
  /** `ligados + rechazados === universo`. Si es `false`, el puente perdió gente. */
  cierra: boolean;
}

/** Lo que devuelve la consulta: el empate calculado, sin escribir nada. */
export interface HrPuenteNominaDto {
  resumen: HrResumenPuenteDto;
  /** Cuántos rechazos hay de cada motivo. */
  porMotivo: Record<HrMotivoRechazoPuente, number>;
  rechazos: HrRechazoPuenteDto[];
  /** Códigos que YA tienen alias apuntando a otra persona: no se pisan, se reportan. */
  conflictos: HrConflictoAliasDto[];
}

/** Un código que ya está registrado, apuntando a alguien distinto del que calcula el puente. */
export interface HrConflictoAliasDto {
  codigo: string;
  /** A quién apunta el alias que ya existe. */
  userIdRegistrado: string;
  /** A quién apuntaría el empate de hoy. */
  userIdCalculado: string;
}

/** Lo que devuelve el registro. Idempotente: correrlo dos veces no inserta de nuevo. */
export interface HrPuenteRegistroDto extends HrPuenteNominaDto {
  /** Aliases nuevos escritos en esta corrida. */
  insertados: number;
  /** Ya estaban, idénticos: no se tocaron. */
  yaEstaban: number;
  /** ⛔ No se escribió ninguno de estos: el alias existente apunta a otra persona. */
  noTocados: number;
}
