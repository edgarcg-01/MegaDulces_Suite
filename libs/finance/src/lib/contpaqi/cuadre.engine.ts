/**
 * Fase CP `[CP.8.8]` — **El cuadre: lo que vuelve PUENTE a lo que si no es un exportador.**
 *
 * Un sink entrega; nadie puede afirmar desde ahí que ContPAQi tenga el asiento. Quien lo
 * afirma es esto: busca la póliza que entregamos en `analytics.gl_polizas` —que el carril de
 * vuelta trae **cada minuto**— y emite un veredicto.
 *
 * Puro, sin DI ni base de datos, igual que `poliza-egreso.ts`: el servicio hace la I/O y le pasa
 * los candidatos ya leídos. Así el candado prueba la REGLA sin levantar nada.
 *
 * ── Dos llaves, y NO son intercambiables ────────────────────────────────────────────────────
 * ⭐ Es la lección de `[LC.14]`/`[LC.15]`, medida y cara: ahí convivían una puerta EXACTA (por
 * UUID) y una por importe, y se midió que **ninguna es superconjunto de la otra** — la exacta
 * atrapó 4 facturas de jul-2026 que el importe no veía, y el importe sigue encontrando cosas
 * todos los meses.
 *
 *   `token`   — CERTEZA. El token que nosotros escribimos en el concepto volvió. Asciende solo.
 *   `importe` — SOSPECHA. Casa por (fecha, tipo, total) y nada más. **NO asciende solo**: queda
 *               `probable` y lo confirma una persona.
 *
 * ⛔ Tratar una coincidencia por importe como certeza es exactamente cómo se cuela un duplicado:
 * dos pagos del mismo monto el mismo día son comunes (medido en ContPAQi: `PAGO COMBUSTIBLE`
 * aparece 326 veces en un año).
 *
 * ── Las ausencias NO son todas la misma (ADR-056) ───────────────────────────────────────────
 * `esperando` (el plazo sigue abierto) y `no_aparecio` (venció) se ven igual en una tabla y se
 * arreglan distinto: una se espera, la otra se investiga. Por eso `verificada` es **ternario** y
 * `esperando` devuelve `null`, no `false`.
 */

/** Lo que entregamos y estamos esperando confirmar. */
export interface ExportPendiente {
  evento_tipo: string;
  evento_id: string;
  /** `YYYY-MM-DD` — la fecha del asiento, no la de entrega. */
  fecha: string;
  tipo_poliza: number;
  total: number;
  /** `YYYY-MM` — acota la búsqueda de candidatos del lado del servicio. */
  periodo: string;
  token: string | null;
  /** Cuándo se entregó, `YYYY-MM-DD`. Con esto se mide el plazo. */
  entregada_en: string | null;
}

/** Una póliza que el carril de vuelta trajo de ContPAQi. */
export interface CandidatoContpaqi {
  ejercicio: number;
  periodo: number;
  tipo_pol: string;
  folio: string;
  guid: string | null;
  /** `YYYY-MM-DD`. */
  fecha: string;
  concepto: string | null;
  cargos: number;
  abonos: number;
}

export type VeredictoCuadre =
  | 'aplicada'     // casó por token y los importes cuadran al centavo
  | 'difiere'      // casó, pero los importes NO cuadran
  | 'probable'     // casó SÓLO por importe — lo confirma una persona
  | 'ambiguo'      // más de un candidato igual de bueno
  | 'esperando'    // no casó y el plazo sigue abierto
  | 'no_aparecio'; // no casó y el plazo venció

export interface ResultadoCuadre {
  veredicto: VeredictoCuadre;
  /** `true` · `false` · `null` = NO SE VERIFICÓ. Nunca se colapsa `null` a `false`. */
  verificada: boolean | null;
  /** Cómo casó. `null` cuando no casó con nada. */
  casado_por: 'token' | 'importe' | null;
  contpaqi_folio: number | null;
  contpaqi_guid: string | null;
  /** Siempre escrito. Un veredicto sin motivo no se puede auditar. */
  motivo: string;
}

/** Centavos enteros: comparar pesos en punto flotante deja pasar descuadres de 1 ¢. */
const cent = (n: number) => Math.round(Number(n) * 100);

/** Días entre dos `YYYY-MM-DD`, sin pasar por `Date` (que corre el día por zona horaria). */
export function diasEntre(desde: string, hasta: string): number {
  const dias = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    // Día juliano aproximado: sólo se usa para restar, no para mostrar.
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  };
  return dias(hasta) - dias(desde);
}

/**
 * El plazo por default. **No es un número redondo porque sí**: el carril de vuelta corre cada
 * minuto, así que si el archivo se importó, la póliza aparece el mismo día. Lo que tarda es que
 * una PERSONA lo importe, y eso puede caer en fin de semana. Tres días hábiles ≈ 5 naturales.
 */
export const PLAZO_DIAS = 5;

/**
 * Emite el veredicto de un evento entregado contra lo que ContPAQi devolvió.
 *
 * `hoy` se pasa, no se calcula: un motor puro no lee el reloj — si lo hiciera, su candado
 * cambiaría de resultado según el día en que se corra.
 */
export function cuadrar(
  pendiente: ExportPendiente,
  candidatos: CandidatoContpaqi[],
  hoy: string,
): ResultadoCuadre {
  const vacio = {
    casado_por: null,
    contpaqi_folio: null,
    contpaqi_guid: null,
  } as const;

  // ── 1. Por TOKEN: la certeza ───────────────────────────────────────────────────────────────
  // Se compara con `includes` y no con `startsWith`: el token va adelante en lo que NOSOTROS
  // serializamos, pero si alguien edita el concepto en ContPAQi y lo empuja hacia atrás, el
  // token sigue siendo nuestro y sigue siendo válido. Lo que no se admite es el token partido.
  const porToken = pendiente.token
    ? candidatos.filter((c) => (c.concepto ?? '').includes(pendiente.token as string))
    : [];

  if (porToken.length > 1) {
    return {
      ...vacio,
      veredicto: 'ambiguo',
      verificada: false,
      motivo: `el token ${pendiente.token} aparece en ${porToken.length} pólizas de ContPAQi: ` +
        porToken.map((c) => `${c.tipo_pol}/${c.folio}`).join(', '),
    };
  }

  if (porToken.length === 1) {
    const c = porToken[0];
    const esperado = cent(pendiente.total);
    const real = cent(c.cargos);
    if (esperado !== real) {
      return {
        veredicto: 'difiere',
        verificada: false,
        casado_por: 'token',
        contpaqi_folio: Number(c.folio) || null,
        contpaqi_guid: c.guid,
        motivo: `casó por token con ${c.tipo_pol}/${c.folio} pero el importe difiere: ` +
          `entregamos ${(esperado / 100).toFixed(2)} y ContPAQi tiene ${(real / 100).toFixed(2)}`,
      };
    }
    return {
      veredicto: 'aplicada',
      verificada: true,
      casado_por: 'token',
      contpaqi_folio: Number(c.folio) || null,
      contpaqi_guid: c.guid,
      motivo: `casó por token con la póliza ${c.tipo_pol}/${c.folio} del ${c.fecha}; importes idénticos`,
    };
  }

  // ── 2. Por IMPORTE: la sospecha ────────────────────────────────────────────────────────────
  // Mismo día, mismo tipo, mismo total al centavo. Es deliberadamente estricto: aflojarlo
  // convierte el fallback en una fábrica de falsos positivos.
  const porImporte = candidatos.filter(
    (c) => c.fecha === pendiente.fecha
      && String(c.tipo_pol) === String(pendiente.tipo_poliza)
      && cent(c.cargos) === cent(pendiente.total),
  );

  if (porImporte.length === 1) {
    const c = porImporte[0];
    return {
      // ⛔ NO asciende a `aplicada`. Coincidir en fecha y monto no es ser el mismo asiento.
      veredicto: 'probable',
      verificada: null,
      casado_por: 'importe',
      contpaqi_folio: Number(c.folio) || null,
      contpaqi_guid: c.guid,
      motivo: `sin token; coincide por fecha e importe con ${c.tipo_pol}/${c.folio}. ` +
        'Requiere confirmación humana: coincidir en monto no es ser el mismo asiento.',
    };
  }
  if (porImporte.length > 1) {
    return {
      ...vacio,
      veredicto: 'ambiguo',
      verificada: false,
      motivo: `sin token y ${porImporte.length} pólizas coinciden en fecha e importe: ` +
        porImporte.map((c) => `${c.tipo_pol}/${c.folio}`).join(', '),
    };
  }

  // ── 3. No casó con nada: ¿todavía se espera, o ya no? ──────────────────────────────────────
  const dias = pendiente.entregada_en ? diasEntre(pendiente.entregada_en, hoy) : NaN;
  if (!Number.isFinite(dias)) {
    return {
      ...vacio,
      veredicto: 'esperando',
      verificada: null,
      motivo: 'no aparece en ContPAQi y no hay fecha de entrega para medir el plazo',
    };
  }
  if (dias > PLAZO_DIAS) {
    return {
      ...vacio,
      veredicto: 'no_aparecio',
      verificada: false,
      motivo: `entregada hace ${dias} días (plazo ${PLAZO_DIAS}) y no aparece en ContPAQi`,
    };
  }
  return {
    ...vacio,
    veredicto: 'esperando',
    verificada: null,
    motivo: `entregada hace ${dias} días; el plazo es ${PLAZO_DIAS}`,
  };
}

/**
 * Resumen para el latido (`[CP.8.10]`). ⭐ Mide **ENTREGA** —cuántos eventos están de verdad
 * sincronizados— y no "el proceso corrió" (ADR-053). Un cuadre que corre perfecto sobre cero
 * eventos no es salud: es silencio.
 */
export function resumirCuadre(resultados: ResultadoCuadre[]) {
  const por: Record<VeredictoCuadre, number> = {
    aplicada: 0, difiere: 0, probable: 0, ambiguo: 0, esperando: 0, no_aparecio: 0,
  };
  for (const r of resultados) por[r.veredicto]++;
  const total = resultados.length;
  // El denominador EXCLUYE `esperando`: todavía no se les puede exigir nada. Incluirlos haría
  // que entregar un lote nuevo bajara el porcentaje y pareciera un deterioro.
  const juzgables = total - por.esperando;
  return {
    total,
    juzgables,
    sincronizados: por.aplicada,
    /** `null` cuando no hay nada juzgable — NO 0, que se leería como "todo mal". */
    pct_sincronizado: juzgables > 0 ? Math.round((1000 * por.aplicada) / juzgables) / 10 : null,
    por,
  };
}
