/**
 * [SM.48] A qué turno de Kepler pertenece cada conteo de caja (retiro / cierre / relevo).
 *
 * Vive en `platform-core` desde `[CSU.16]` (2026-10-30), como `cash-cut-identity.ts`: la
 * usan `libs/reconciliation` (Sucursales y sus cajas, en el arqueo de tienda) y `libs/finance`
 * (Cortes/Sucursales), que no se pueden importar entre sí.
 *
 * ── Por qué por CAJA + HORA y no por usuario
 *
 * Medido en prod (2026-10-28, octubre): 190 retiros/cierres se guardaron SIN folio
 * de turno, y en 169 (89%) la causa es que el usuario de la Suite no coincide con el
 * código de cajera de Kepler (`YAZMIN_SARAI` vs `40YSCC`, `DULCE` vs `50C01`): la
 * pantalla le filtra los turnos por su código, no le sale ninguno y cuenta «sin
 * turno». Ligar usuario ↔ código tampoco sirve: desde septiembre 15 usuarios
 * arquean turnos de varios códigos y 21 códigos los cuentan varias personas
 * (cuentas compartidas como `10C01` en los dos lados). Lo que sí es un hecho físico
 * es la caja y la hora: Kepler sabe qué turno estaba abierto en esa caja a esa hora.
 *
 * ── La regla
 *
 *  - Retiro / relevo: el turno ABIERTO en esa caja a esa hora. Si ninguno lo estaba
 *    (se capturó un poco después del corte), el que cerró más recientemente dentro
 *    de la gracia.
 *  - Cierre: al revés — primero el que cerró recientemente (se cuenta el cajón
 *    DESPUÉS del corte, y para entonces la caja ya puede tener otro turno abierto),
 *    y si ninguno cerró, el abierto.
 *  - Dos candidatos al mismo nivel = AMBIGUO: no se elige a dedo (colgarle a un turno
 *    el conteo de otro es peor que dejarlo sin turno y decirlo).
 *
 * Funciones puras: sin base de datos, para probarlas una por una.
 */

/** Minutos después del corte en que un conteo todavía se atribuye a ese turno. */
export const GRACIA_MIN = 180;

export interface TurnoHorario {
  folio: string;
  caja: string;
  /** 'HH:MM:SS' (o 'HH:MM'). */
  hora_apertura: string | null;
  /** 'HH:MM:SS'; null = el turno sigue abierto. */
  hora_cierre: string | null;
}

export type TipoConteo = 'retiro' | 'cierre' | 'relevo' | string;

/** 'HH:MM[:SS[.fff]]' → minutos del día. null si no se puede leer. */
export function minutos(hora: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(hora ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
}

const abiertoEn = (t: TurnoHorario, h: number): boolean => {
  const a = minutos(t.hora_apertura);
  const c = minutos(t.hora_cierre);
  return a != null && a <= h && (c == null || h <= c);
};

const cerroHaceRato = (t: TurnoHorario, h: number): boolean => {
  const c = minutos(t.hora_cierre);
  return c != null && c <= h && h - c <= GRACIA_MIN;
};

/** El único candidato, o null si hay 0 o varios (ambiguo). */
const unico = (xs: TurnoHorario[]): TurnoHorario | null => (xs.length === 1 ? xs[0] : null);

/** De los que cerraron dentro de la gracia, el más reciente — si no empata. */
const ultimoCerrado = (xs: TurnoHorario[]): TurnoHorario | null => {
  if (!xs.length) return null;
  const orden = [...xs].sort((a, b) => (minutos(b.hora_cierre) ?? 0) - (minutos(a.hora_cierre) ?? 0));
  return orden.length > 1 && minutos(orden[0].hora_cierre) === minutos(orden[1].hora_cierre) ? null : orden[0];
};

/**
 * El turno de `candidatos` (ya filtrados a la misma sucursal, caja y fecha) al que
 * pertenece un conteo de `tipo` capturado a la `hora`. null = ninguno o ambiguo.
 */
export function elegirTurno(candidatos: TurnoHorario[], tipo: TipoConteo, hora: string | null | undefined): TurnoHorario | null {
  const h = minutos(hora);
  if (h == null || !candidatos.length) return null;
  const abiertos = candidatos.filter((t) => abiertoEn(t, h));
  const cerrados = candidatos.filter((t) => cerroHaceRato(t, h));
  if (tipo === 'cierre') {
    if (cerrados.length) return ultimoCerrado(cerrados);
    return unico(abiertos);
  }
  if (abiertos.length) return unico(abiertos);
  return ultimoCerrado(cerrados);
}

/** Lo mínimo de un conteo para ligarlo. */
export interface ConteoLigable {
  id: string;
  tipo: string;
  caja: string;
  cash_cut_folio: string | null;
  /** Hora de captura en la zona de la tienda, 'HH:MM:SS'. */
  hora: string;
}

export type ComoSeLigo = 'folio' | 'hora';

/**
 * Llave de un turno. El folio NO es único por sucursal: es por caja (medido: en la
 * 08 el 26-oct, el folio 30 existe en la caja 2 y en la caja 3).
 */
export const llaveTurno = (t: { caja: string; folio: string }): string => `${t.caja}#${t.folio}`;

/**
 * Reparte los conteos de caja (retiro / cierre / relevo) entre los turnos de UNA
 * sucursal y UN día. Primero por folio (cuando la captura lo trae, manda); si no,
 * por caja + hora. Lo que no cae en ningún turno vuelve en `sinTurno`: se muestra
 * aparte, nunca se pega al turno «más parecido».
 */
export function ligarConteos<T extends ConteoLigable, U extends TurnoHorario>(
  turnos: U[],
  conteos: T[],
): { porTurno: Map<string, Array<T & { ligado: ComoSeLigo }>>; sinTurno: T[] } {
  const porTurno = new Map<string, Array<T & { ligado: ComoSeLigo }>>();
  for (const t of turnos) porTurno.set(llaveTurno(t), []);
  const sinTurno: T[] = [];
  for (const c of conteos) {
    const porFolio = c.cash_cut_folio
      ? turnos.find((t) => t.folio === String(c.cash_cut_folio) && String(t.caja) === String(c.caja)) : undefined;
    if (porFolio) { porTurno.get(llaveTurno(porFolio))!.push({ ...c, ligado: 'folio' }); continue; }
    const t = elegirTurno(turnos.filter((x) => String(x.caja) === String(c.caja)), c.tipo, c.hora);
    if (t) porTurno.get(llaveTurno(t))!.push({ ...c, ligado: 'hora' });
    else sinTurno.push(c);
  }
  return { porTurno, sinTurno };
}

// ── [CSU.16] Varios días y sucursales, con la fecha como candado ───────────────

/** Un turno con su sucursal y su día en Kepler (`kdpv_folio_caja.c5`). */
export interface TurnoFechado extends TurnoHorario {
  sucursal: string;
  /** 'YYYY-MM-DD' de apertura. */
  fecha: string;
  /** 'YYYY-MM-DD' de cierre (`c10`); null = sigue abierto. */
  fecha_cierre: string | null;
}

/** Un conteo con el día en que se CAPTURÓ (hora de la tienda), no el que guardó la pantalla. */
export interface ConteoFechado extends ConteoLigable {
  sucursal: string;
  /** 'YYYY-MM-DD' de `captured_at` en America/Mexico_City. */
  fecha_captura: string;
}

export const llaveTurnoFechado = (t: { sucursal: string; caja: string; folio: string; fecha: string }): string =>
  `${t.sucursal}|${llaveTurno(t)}|${t.fecha}`;

/** Minuto absoluto de una fecha + hora de la tienda; null si alguna no se puede leer. */
const instante = (fecha: string | null, hora: string | null | undefined): number | null => {
  const m = minutos(hora);
  const d = fecha ? Date.parse(`${fecha}T00:00:00Z`) : NaN;
  return m == null || Number.isNaN(d) ? null : d / 60_000 + m;
};

/** Un turno abierto en Kepler no se toma como vigente más allá de esto después de abrir. */
const ABIERTO_MAX_MIN = 24 * 60;

/** ¿La captura cae dentro del turno: de que abrió a que cerró, más la gracia? */
function capturaDentro(t: TurnoFechado, c: ConteoFechado): boolean {
  const cap = instante(c.fecha_captura, c.hora);
  const abre = instante(t.fecha, t.hora_apertura);
  if (cap == null || abre == null || cap < abre) return false;
  if (t.hora_cierre == null || t.fecha_cierre == null) return cap - abre <= ABIERTO_MAX_MIN;
  const cierra = instante(t.fecha_cierre, t.hora_cierre);
  return cierra != null && cap <= cierra + GRACIA_MIN;
}

/** Por qué un conteo no se ligó: su folio apunta a un turno que no estaba en ese momento, o no hay turno. */
export type MotivoSinLigar = 'folio_de_otro_turno' | 'sin_turno';

/**
 * `[CSU.16]` `ligarConteos` sobre varios días y sucursales, con la HORA DE CAPTURA como candado del folio.
 *
 * ⛔ El folio que guarda la captura no basta. Medido en prod el 2026-10-30: de 639 retiros y
 * cierres con folio desde septiembre, **316 (49 %) se capturaron más de un día DESPUÉS** del turno
 * al que apuntan (Padre Hidalgo 206 de 343, 8 Esquinas 62 de 99). Y no son conteos tardíos: sus
 * retiros cuadran contra lo retirado del turno al que apuntan en **1 de 82** grupos, y contra el de
 * un turno del día en que se capturaron en **44**. El conteo es de hoy y quedó colgado de un turno
 * de hace una semana. Aceptar «el día anterior» tampoco alcanza: en Padre Hidalgo Caja 2 el 25-oct
 * dos personas capturaron retiros, uno con el folio del 24 y otro con el del 23; los del primero
 * suman $95,000, lo retirado por el turno 118 de ESE día.
 *
 * Entonces:
 *  - el folio manda sólo si la captura cae DENTRO de su turno (de la apertura al cierre más la
 *    gracia; el cierre que se cuenta pasada la medianoche entra solo);
 *  - un conteo SIN folio se liga por caja + hora entre los turnos del día en que se capturó, con la
 *    regla de `elegirTurno`;
 *  - un folio que apunta a otro momento NO se reasigna por la hora: en 8 Esquinas esos conteos traen
 *    también la caja equivocada (folios de agosto, de otra cajera), y reasignarlos sumaba $57,571 de
 *    retiros ajenos a un turno que retiró $11,000. Vuelve en `sinTurno` con su motivo: colgarle a un
 *    turno el conteo de otro es peor que dejarlo sin turno y decirlo.
 */
export function ligarPorCaptura<T extends ConteoFechado, U extends TurnoFechado>(
  turnos: U[],
  conteos: T[],
): { porTurno: Map<string, Array<T & { ligado: ComoSeLigo }>>; sinTurno: Array<T & { motivo: MotivoSinLigar }> } {
  const porTurno = new Map<string, Array<T & { ligado: ComoSeLigo }>>();
  const porCaja = new Map<string, U[]>();
  for (const t of turnos) {
    porTurno.set(llaveTurnoFechado(t), []);
    const k = `${t.sucursal}|${String(t.caja)}`;
    if (!porCaja.has(k)) porCaja.set(k, []);
    porCaja.get(k)!.push(t);
  }
  const sinTurno: Array<T & { motivo: MotivoSinLigar }> = [];
  for (const c of conteos) {
    const mismaCaja = porCaja.get(`${c.sucursal}|${String(c.caja)}`) ?? [];
    if (c.cash_cut_folio) {
      const porFolio = mismaCaja.filter((t) => t.folio === String(c.cash_cut_folio) && capturaDentro(t, c));
      if (porFolio.length === 1) porTurno.get(llaveTurnoFechado(porFolio[0]))!.push({ ...c, ligado: 'folio' });
      else sinTurno.push({ ...c, motivo: 'folio_de_otro_turno' });
      continue;
    }
    const t = elegirTurno(mismaCaja.filter((x) => x.fecha === c.fecha_captura), c.tipo, c.hora) as U | null;
    if (t) porTurno.get(llaveTurnoFechado(t))!.push({ ...c, ligado: 'hora' });
    else sinTurno.push({ ...c, motivo: 'sin_turno' });
  }
  return { porTurno, sinTurno };
}
