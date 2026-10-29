import type { AprobacionPago, EstadoAprobacionPago } from '@megadulces/contracts';
import { norm } from './caja-caos-match.engine';

/**
 * ⭐ `[CGA-A.62]` **¿Se aprobó antes de pagarse?** Pago de Kepler → solicitud → vale de
 * `/finanzas/aprobacion-gastos` → la hora de la firma contra la hora del pago.
 *
 * Edgar, 2026-10-28: *«hay que revisar que los /finanzas/aprobacion-gastos que pasen por aquí hayan
 * estado aprobados antes de mencionar el pago»*.
 *
 * ── La cadena, y por qué el primer eslabón es un cruce ──────────────────────────────────────
 * El vale cuelga de la SOLICITUD de Kepler (`X-A-15-1`, por `sucursal` + `folio_solicitud`). El
 * PAGO (`X-D-26` contra la `0011`) no la nombra: medido en prod el 2026-10-28, sus `c37/c38` vienen
 * en 0 y `c39` vacío. Entonces el pago se casa con su solicitud por **sucursal + importe al centavo
 * + beneficiario**, con la solicitud capturada ANTES y a ≤ 30 días. Con control: de 1,014 pagos
 * desde el 1-oct casaron 420; corridos $1 casaron 7 (placebo). Uno-a-uno: cada solicitud paga una
 * vez, y se toma la más reciente antes del pago (las nóminas repiten importe cada semana).
 *
 * ── La hora de la firma ───────────────────────────────────────────────────────────────────────
 * Desde `[CGA-A.62]` el vale guarda `aprobado_at`. Antes no: de lo viejo sólo hay COTAS — la firma
 * fue después de levantar el vale (`created_at`) y antes de subir la evidencia o de que una persona
 * lo validara. Con cota se afirma lo que la cota permite y lo demás se DECLARA «sin hora».
 * ⚠️ El cierre de Kepler (`validated_by` = «Kepler: …») no es una firma: cierra vales que nadie
 * aprobó (`[GX.85]` los cierra desde `recibida`).
 */

export const DIAS_SOLICITUD_ANTES_DEL_PAGO = 30;
const FIRMA_KEPLER = /^kepler\b/i;

export interface PagoParaAprobar {
  /** La llave del documento en la reposición (`origen_ref`). */
  clave: string;
  sucursal: string;
  importe: number;
  beneficiario: string | null;
  /** Instante del pago (captura en Kepler, `c68`+`c69`, hora de México), ISO. */
  pagado_at: string;
  /** Día de pago (`c9`), `YYYY-MM-DD`. */
  fecha_pago: string;
}

export interface SolicitudKepler {
  sucursal: string;
  folio: string;
  importe: number;
  beneficiario: string | null;
  /** `N`, `A`, `F`, `C`. Una cancelada (`C`) no ampara nada. */
  estado: string | null;
  capturado_at: string | null;
  /** La fecha DEL GASTO que declara la solicitud (`c9`), `YYYY-MM-DD`. */
  fecha: string | null;
}

export interface ValeDeGasto {
  id: string;
  sucursal: string | null;
  folio_solicitud: string | null;
  status: string;
  created_at: string;
  aprobado_at: string | null;
  aprobado_por: string | null;
  validated_at: string | null;
  validated_by: string | null;
  evidencia_at: string | null;
}

const ms = (v: string | null | undefined) => (v ? Date.parse(v) : Number.NaN);
const cent = (v: number) => Math.round((Number(v) || 0) * 100);
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

const BLOQUEA: readonly EstadoAprobacionPago[] = ['sin_firma', 'rechazado'];
const ALERTA: readonly EstadoAprobacionPago[] = ['aprobado_despues', 'vale_despues', 'solicitud_despues'];

function resultado(estado: EstadoAprobacionPago, texto: string, extra: Partial<AprobacionPago> = {}): AprobacionPago {
  return {
    estado, texto, solicitud_folio: null, vale_id: null, vale_status: null, firmado_at: null, firma_exacta: false,
    bloquea: BLOQUEA.includes(estado), alerta: ALERTA.includes(estado), ...extra,
  };
}

/** El juicio de UN vale contra la hora del pago. */
export function juzgarVale(v: ValeDeGasto, pagadoAt: string, solicitud: string): AprobacionPago {
  const base = { solicitud_folio: solicitud, vale_id: v.id, vale_status: v.status };
  const pago = ms(pagadoAt);
  if (v.status === 'recibida') return resultado('sin_firma', 'Espera firma en Aprobación de gastos', base);
  if (v.status === 'rechazada') return resultado('rechazado', 'Se rechazó en Aprobación de gastos', base);
  if (v.aprobado_at) {
    const firmado = { ...base, firmado_at: v.aprobado_at, firma_exacta: true };
    return ms(v.aprobado_at) <= pago
      ? resultado('aprobado_antes', `Aprobado el ${fechaHora(v.aprobado_at)}, antes del pago`, firmado)
      : resultado('aprobado_despues', `Aprobado el ${fechaHora(v.aprobado_at)}, DESPUÉS del pago (${fechaHora(pagadoAt)})`, firmado);
  }
  if (ms(v.created_at) > pago) {
    return resultado('vale_despues', `El vale se levantó el ${fechaHora(v.created_at)}, después del pago (${fechaHora(pagadoAt)})`, base);
  }
  // Sin hora exacta: la cota superior de la firma es la evidencia o la validación de una PERSONA.
  const porPersona = v.validated_at && !FIRMA_KEPLER.test(String(v.validated_by ?? '')) ? v.validated_at : null;
  const cotas = [v.evidencia_at, porPersona].filter((x): x is string => !!x).sort((a, b) => ms(a) - ms(b));
  if (cotas.length && ms(cotas[0]) <= pago) {
    return resultado('aprobado_antes', `Aprobado a más tardar el ${fechaHora(cotas[0])}, antes del pago`, { ...base, firmado_at: cotas[0] });
  }
  if (FIRMA_KEPLER.test(String(v.validated_by ?? '')) && !v.evidencia_at) {
    return resultado('cerrado_por_kepler', 'Lo cerró Kepler al pagarse: no consta la firma en Aprobación de gastos', base);
  }
  return resultado('aprobado_sin_hora', 'Aprobado; la hora de la firma no se guardaba (antes del 28/10)', base);
}

/**
 * Para cada pago, su estado de aprobación. Los pagos se recorren en orden de hora y cada
 * solicitud ampara a UNO: la más reciente que casa antes del pago.
 */
export function aprobacionDePagos(
  pagos: readonly PagoParaAprobar[], solicitudes: readonly SolicitudKepler[], vales: readonly ValeDeGasto[],
): Map<string, AprobacionPago> {
  const salida = new Map<string, AprobacionPago>();
  const usadas = new Set<string>();
  const llaveSol = (s: { sucursal: string; folio: string }) => `${s.sucursal}|${s.folio}`;
  const valePorSol = new Map<string, ValeDeGasto>();
  for (const v of [...vales].sort((a, b) => ms(b.created_at) - ms(a.created_at))) {
    const k = `${String(v.sucursal ?? '').trim()}|${String(v.folio_solicitud ?? '').trim()}`;
    if (!valePorSol.has(k)) valePorSol.set(k, v);
  }
  const vivas = solicitudes.filter((s) => String(s.estado ?? '').trim().toUpperCase() !== 'C');
  const ventana = DIAS_SOLICITUD_ANTES_DEL_PAGO * 86400000;

  for (const p of [...pagos].sort((a, b) => ms(a.pagado_at) - ms(b.pagado_at) || a.clave.localeCompare(b.clave))) {
    const pago = ms(p.pagado_at);
    const casan = vivas.filter((s) => s.sucursal === p.sucursal && cent(s.importe) === cent(p.importe)
      && norm(s.beneficiario) === norm(p.beneficiario) && !usadas.has(llaveSol(s)));
    const antes = casan.filter((s) => ms(s.capturado_at) <= pago && ms(s.capturado_at) > pago - ventana)
      .sort((a, b) => ms(b.capturado_at) - ms(a.capturado_at));
    const sol = antes[0];
    if (!sol) {
      // Una solicitud capturada DESPUÉS sólo es de este pago si está FECHADA el día del pago o
      // antes: se regularizó tarde. Fechada después es de otro pago — en caja chica el importe se
      // repite ($1,000 una y otra vez) y sin esto se emparejaba con el pago equivocado.
      const despues = casan.filter((s) => ms(s.capturado_at) > pago && ms(s.capturado_at) <= pago + ventana
          && !!s.fecha && s.fecha <= p.fecha_pago)
        .sort((a, b) => ms(a.capturado_at) - ms(b.capturado_at))[0];
      if (despues) {
        usadas.add(llaveSol(despues));
        salida.set(p.clave, resultado('solicitud_despues',
          `La solicitud ${despues.folio} se capturó en Kepler después del pago`, { solicitud_folio: despues.folio }));
      } else {
        salida.set(p.clave, resultado('sin_solicitud', 'Sin solicitud en Kepler: no pasó por Aprobación de gastos'));
      }
      continue;
    }
    usadas.add(llaveSol(sol));
    const vale = valePorSol.get(llaveSol(sol));
    salida.set(p.clave, vale
      ? juzgarVale(vale, p.pagado_at, sol.folio)
      : resultado('sin_vale', `La solicitud ${sol.folio} nunca pasó por Aprobación de gastos`, { solicitud_folio: sol.folio }));
  }
  return salida;
}
