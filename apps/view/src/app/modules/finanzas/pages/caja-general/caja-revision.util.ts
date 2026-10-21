import { VEREDICTOS_SIN_RESPUESTA, type VeredictoCorte } from '@megadulces/contracts';

/**
 * `[CGS.24]` — **Qué puede hacer la supervisora con un corte, y por qué no.**
 *
 * Espejo de las reglas del servidor (`cash-cut.engine.ts`: `puedeAutorizar`, `puedeObservar`,
 * `exigenciaParaAutorizar`). El candado de verdad es el servidor y la base; esto existe para que el
 * botón se apague CON SU MOTIVO escrito al lado, en vez de que la persona descubra la regla con un
 * error después del clic (Poka-yoke).
 *
 * ⚠️ El largo mínimo (10) es el mismo que pide la base (`cut_observado_completo_chk`) y el motor
 * (`MINIMO_TEXTO_REVISION`). Si cambia allá, cambia acá.
 */
export const MINIMO_TEXTO_REVISION = 10;

export interface CorteARevisar {
  estado: string;
  veredicto: VeredictoCorte;
  diferencia: number | null;
  /** Quien abrió, cerró, capturó o canceló en el corte. */
  no_revisa: string[];
  observo?: string | null;
  observacion?: string | null;
  autorizo?: string | null;
}

export interface Puerta { ok: boolean; texto: string }

export interface PuertasRevision {
  autorizar: Puerta;
  observar: Puerta;
  /** El corte tiene diferencia: autorizar pide nota. */
  pideNota: boolean;
}

export function puertasRevision(
  c: CorteARevisar, userId: string | null | undefined, tienePermiso: boolean, texto: string,
): PuertasRevision {
  const no = (t: string): Puerta => ({ ok: false, texto: t });
  const hayDif = c.diferencia != null && Math.abs(Number(c.diferencia)) > 0.005;
  const largo = texto.trim().length;
  const base = { pideNota: hayDif };

  if (!tienePermiso) {
    const t = 'Revisar un corte necesita el permiso «Autorizar corte de Caja General».';
    return { ...base, autorizar: no(t), observar: no(t) };
  }
  if (!userId) {
    const t = 'No se pudo identificar quién revisa.';
    return { ...base, autorizar: no(t), observar: no(t) };
  }
  if (c.estado === 'autorizado') {
    const t = `Ya está autorizado${c.autorizo ? ` por ${c.autorizo}` : ''}.`;
    return { ...base, autorizar: no(t), observar: no(t) };
  }
  if (c.estado === 'observado') {
    const t = `Observado${c.observo ? ` por ${c.observo}` : ''}: espera la respuesta de la caja.`;
    return { ...base, autorizar: no(t), observar: no(t) };
  }
  if (c.estado !== 'cerrado') {
    const t = 'El corte todavía no se cierra.';
    return { ...base, autorizar: no(t), observar: no(t) };
  }
  if (c.no_revisa.includes(userId)) {
    const t = 'Abriste, cerraste o capturaste en este corte: lo revisa otra persona.';
    return { ...base, autorizar: no(t), observar: no(t) };
  }

  const observar: Puerta = largo >= MINIMO_TEXTO_REVISION
    ? { ok: true, texto: 'Se devuelve a la caja con lo que escribiste. No cambia ninguna cifra.' }
    : no(`Para observar, escribe qué encontraste (al menos ${MINIMO_TEXTO_REVISION} caracteres).`);

  let autorizar: Puerta;
  if ((VEREDICTOS_SIN_RESPUESTA as readonly string[]).includes(c.veredicto)) {
    autorizar = no('Este corte no se puede autorizar: su cuenta no tiene respuesta. Obsérvalo con el motivo.');
  } else if (hayDif && largo < MINIMO_TEXTO_REVISION) {
    autorizar = no(`Tiene diferencia: para autorizarlo escribe por qué (al menos ${MINIMO_TEXTO_REVISION} caracteres).`);
  } else {
    autorizar = { ok: true, texto: hayDif ? 'Se autoriza con tu nota.' : 'Cuadra: se puede autorizar.' };
  }
  return { ...base, autorizar, observar };
}
