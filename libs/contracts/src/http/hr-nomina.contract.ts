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
  /**
   * `[NE.2.5]` A quiénes miró el puente y descartó, por id de usuario de la Suite. Vacío cuando no
   * había ninguno. ⛔ Identificadores, nunca nombres.
   */
  candidatos: string[];
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

// ── `[NE.2.2]` El periodo de nómina, derivado de ContPAQi ────────────────────────────────────

/** Por qué una fecha de pago no se volvió un periodo. */
export type HrMotivoOmitirPeriodo =
  /** No cayó en viernes. La semana de nómina es sábado→viernes y la tabla lo exige. */
  | 'no-es-viernes'
  /** Ya existe un periodo con esa fecha y dice algo distinto: no se pisa, se reporta. */
  | 'ya-existe-distinto';

export interface HrPeriodoOmitidoDto {
  paidOn: string;
  motivo: HrMotivoOmitirPeriodo;
  detalle: string;
}

export interface HrPeriodosDto {
  /** Fechas de pago de nómina ORDINARIA que se miraron. */
  universo: number;
  /** Periodos escritos en esta corrida. */
  insertados: number;
  /** Ya estaban, iguales: no se tocaron. */
  yaEstaban: number;
  /** Con rango de días derivado de ContPAQi (7 días que terminan el día del pago). */
  conRango: number;
  /** ⚠️ Sin rango: se escribieron con `starts_on`/`ends_on` NULL, declarados, no inventados. */
  sinRango: number;
  omitidos: HrPeriodoOmitidoDto[];
}

// ── `[NE.2.5]` La cola de los que no ligaron ──────────────────────────────────────────────────

/**
 * ⚠️ **Acá SÍ viajan nombres de personas**, al revés que en el resto de este archivo, y es a
 * propósito: **una identidad no se resuelve a ciegas**. Quien tiene que decidir si el código 1234
 * de nómina es tal persona de la Suite necesita leer los dos nombres; pedirle que lo haga con
 * identificadores sería pedirle que firme lo que no puede ver.
 *
 * Por eso toda esta superficie va detrás de `HR_NOMINA_GESTIONAR`, que está **sin repartir** hasta
 * que exista la pantalla: un alias equivocado liga a una persona con el sueldo de otra.
 */
export interface HrCandidatoDeLaSuiteDto {
  userId: string;
  nombre: string;
  /** Tal cual lo dice la Suite: `active`, `invited`, `terminated`… No se traduce ni se agrupa. */
  status: string;
  /** Si ya tiene algún código de nómina ligado: avisa antes de ligarle un segundo. */
  codigosYaLigados: string[];
}

export interface HrCasoDeLaColaDto {
  codigo: string;
  motivo: HrMotivoRechazoPuente;
  detalle: string;
  /** El nombre tal como lo escribe el sistema de nómina, sin normalizar. */
  nombreNomina: string;
  /** Cuándo cobró por última vez y cuántas veces en la ventana: dice si el caso corre prisa. */
  ultimoPago: string | null;
  pagos: number;
  /** Los que el puente miró y descartó, ya con su nombre. Vacío si no había ninguno. */
  candidatos: HrCandidatoDeLaSuiteDto[];
}

export interface HrColaNominaDto {
  resumen: HrResumenPuenteDto;
  porMotivo: Record<HrMotivoRechazoPuente, number>;
  casos: HrCasoDeLaColaDto[];
}

/** Lo que manda la pantalla para resolver UN caso. */
export interface HrResuelveCasoDto {
  /** El código del sistema de nómina que se va a ligar. */
  codigo: string;
  /** A quién. */
  userId: string;
  /** ⛔ Obligatoria y no en blanco: es la firma. La base también la exige. */
  nota: string;
  /**
   * Sólo si el código YA tiene un alias y se quiere corregir: a quién apunta **hoy**, tal como lo
   * vio quien resuelve. Si no coincide con lo que hay en la base, la operación se rechaza en vez
   * de pisar algo que cambió mientras tanto.
   */
  reemplazaA?: string;
}

export interface HrResolucionDto {
  codigo: string;
  userId: string;
  /** El alias que quedó vigente. */
  aliasId: string;
  /** El alias que se dio de baja, si hubo corrección. `null` si fue un alta limpia. */
  reemplazado: string | null;
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
