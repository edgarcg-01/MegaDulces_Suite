/**
 * [SM.48] Sucursales y sus cajas: a qué turno de Kepler pertenece cada conteo.
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
import type {
  ArqueoCajasConteo, ArqueoCajasResp, ArqueoCajasSucursal, ArqueoCajasTurno, ArqueoRetirosEstado,
} from '@megadulces/contracts/http/arqueo-cajas';
import { cuadreTurno, CUADRE_UMBRAL, type CorteKepler } from './cash-cut-identity';

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

// ── Armado de la respuesta (puro: recibe filas, devuelve el contrato) ──────────

const n2 = (v: unknown): number => Math.round((Number(v) || 0) * 100) / 100;
const json = <T>(v: unknown, def: T): T => {
  if (v == null) return def;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return def; } }
  return v as T;
};
const texto = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

const TIPOS_DE_CAJA = new Set(['retiro', 'cierre', 'relevo']);

function aConteo(r: Record<string, unknown>): ArqueoCajasConteo {
  return {
    id: String(r['id']), tipo: String(r['tipo']), secuencia: Number(r['secuencia'] ?? 1) || 1,
    caja: String(r['caja'] ?? ''), hora: String(r['hora'] ?? ''),
    captured_at: r['captured_at'] instanceof Date ? (r['captured_at'] as Date).toISOString() : String(r['captured_at'] ?? ''),
    total: n2(r['total']),
    usuario: texto(r['usuario']), usuario_nombre: texto(r['usuario_nombre']),
    denominations: json<Record<string, number>>(r['denominations'], {}),
    medios: json<Record<string, number> | null>(r['medios'], null),
    nota: texto(r['nota']), incidencia_tipo: texto(r['incidencia_tipo']), motivo: texto(r['motivo']),
    concepto: texto(r['concepto']),
    route_code: texto(r['route_code']), cash_cut_folio: texto(r['cash_cut_folio']),
    validado_por: texto(r['validado_por']),
    validado_at: r['validado_at'] instanceof Date ? (r['validado_at'] as Date).toISOString() : texto(r['validado_at']),
  };
}

/** Estado de los retiros: lo contado contra lo que Kepler dice que salió. */
export function estadoRetiros(contados: number, kepler: number): ArqueoRetirosEstado {
  if (!contados && !kepler) return 'sin_retiros';
  if (Math.abs(contados - kepler) < 0.5) return 'cuadra';
  return contados < kepler ? 'faltan' : 'de_mas';
}

/**
 * Arma `ArqueoCajasResp` desde las filas crudas de los turnos (`kdpv_folio_caja`,
 * con los alias de `CorteKepler`) y de los conteos (`blind_counts`) de UN día.
 */
export function armarCajasDelDia(
  fecha: string,
  turnosRaw: Array<Record<string, unknown>>,
  conteosRaw: Array<Record<string, unknown>>,
): ArqueoCajasResp {
  const conteos = conteosRaw.map((r) => ({ ...aConteo(r), suc: String(r['warehouse_code']) }));
  const sucs = new Map<string, { nombre: string | null; turnos: Array<Record<string, unknown>> }>();
  for (const t of turnosRaw) {
    const s = String(t['warehouse_code']);
    if (!sucs.has(s)) sucs.set(s, { nombre: texto(t['warehouse_name']), turnos: [] });
    sucs.get(s)!.turnos.push(t);
  }
  for (const c of conteos) if (!sucs.has(c.suc)) sucs.set(c.suc, { nombre: null, turnos: [] });

  const sucursales: ArqueoCajasSucursal[] = [...sucs.keys()].sort().map((code) => {
    const { nombre, turnos } = sucs.get(code)!;
    const horarios = turnos.map((t) => ({
      ...t, folio: String(t['folio']), caja: String(t['caja']),
      hora_apertura: texto(t['hora_apertura']), hora_cierre: texto(t['hora_cierre']),
    }));
    const deLaSuc = conteos.filter((c) => c.suc === code);
    const deCaja = deLaSuc.filter((c) => TIPOS_DE_CAJA.has(c.tipo));
    const { porTurno, sinTurno } = ligarConteos(horarios, deCaja);
    const quitaSuc = <X extends { suc: string }>(x: X): Omit<X, 'suc'> => { const { suc: _s, ...resto } = x; return resto; };

    const turnosOut: ArqueoCajasTurno[] = horarios.map((t) => {
      const mios = (porTurno.get(llaveTurno(t)) ?? []).map((c) => quitaSuc(c) as ArqueoCajasConteo);
      const retiros = mios.filter((c) => c.tipo === 'retiro');
      const cierres = mios.filter((c) => c.tipo === 'cierre');
      const relevos = mios.filter((c) => c.tipo === 'relevo');
      const retirosContados = n2(retiros.reduce((s, c) => s + c.total, 0));
      const retiradoKepler = n2(t['efectivo_retirado']);
      // Si el cajón se recapturó, vale el último (el UPSERT ya deja uno; esto es defensa).
      const cajon = cierres.length ? cierres[cierres.length - 1].total : null;
      const cq = cuadreTurno(t as CorteKepler, { cajonContado: cajon, retirosContados });
      return {
        caja: t.caja, folio: t.folio,
        cajero_code: texto(t['cajero_code']), cajero_nombre: texto(t['cajero_nombre']),
        hora_apertura: t.hora_apertura, hora_cierre: t.hora_cierre, abierto: Boolean(t['abierto']),
        esperado: cq.esperado, retirado_kepler: retiradoKepler,
        retiros, cierres, relevos,
        retiros_contados: retirosContados,
        retiros_estado: estadoRetiros(retirosContados, retiradoKepler),
        retiros_diferencia: n2(retirosContados - retiradoKepler),
        cuadre: {
          // Solo NUESTRO conteo: sin cajón contado no se publica la diferencia de Kepler aquí.
          medible: cq.diff_real != null,
          // Sin esperado no hay contra qué; con esperado y sin cajón contado, falta NUESTRO conteo.
          motivo: cq.diff_real != null ? null : cq.esperado == null ? 'sin_esperado' : 'sin_conteo',
          diferencia: cq.diff_real,
          retiros_sin_verificar: cq.retiros_sin_verificar,
          contado_total: cq.contado_total,
        },
      };
    });
    return {
      warehouse_code: code, nombre,
      turnos: turnosOut,
      sin_turno: sinTurno.map((c) => quitaSuc(c) as ArqueoCajasConteo),
      sin_caja: deLaSuc.filter((c) => !TIPOS_DE_CAJA.has(c.tipo)).map((c) => quitaSuc(c) as ArqueoCajasConteo),
    };
  });
  return { fecha, umbral: CUADRE_UMBRAL, sucursales };
}
