/**
 * [SM.48] Sucursales y sus cajas: a qué turno de Kepler pertenece cada conteo.
 *
 * La liga conteo ↔ turno (por folio, o por caja + hora) vive en `@megadulces/platform-core`
 * (`lib/caja/ligar-conteos.ts`) desde `[CSU.16]`, con su porqué: también la usa
 * Cortes/Sucursales, en `libs/finance`. Aquí se re-exporta para que los consumidores de esta
 * lib no cambien de import, y se arma la respuesta de un día.
 *
 * Funciones puras: sin base de datos, para probarlas una por una.
 */
import type {
  ArqueoCajasConteo, ArqueoCajasResp, ArqueoCajasSucursal, ArqueoCajasTurno, ArqueoRetirosEstado,
} from '@megadulces/contracts/http/arqueo-cajas';
import { ligarConteos, llaveTurno } from '@megadulces/platform-core';
import { cuadreTurno, CUADRE_UMBRAL, type CorteKepler } from './cash-cut-identity';

export { GRACIA_MIN, elegirTurno, ligarConteos, llaveTurno, minutos } from '@megadulces/platform-core';
export type { ComoSeLigo, ConteoLigable, TipoConteo, TurnoHorario } from '@megadulces/platform-core';

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
