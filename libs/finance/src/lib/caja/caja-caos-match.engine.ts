/**
 * CS.3.3 — El motor que PROPONE qué retiro del cajero (CAOS) pagó un gasto de caja.
 *
 * Puro y determinista (se prueba sin DB, patrón `cuentaPorRegla`/`esConfirmable`). No decide solo:
 * PUNTÚA candidatos por los patrones MEDIDOS (2026-09-25, prod) y el humano confirma. Nunca aplica
 * a ciegas — 1 de cada 3 «matches» por monto es falso por azar (placebo).
 *
 * Señales y por qué pesan lo que pesan (medido):
 *   · **Mismo día** (lag 0): monto exacto + mismo día = ~90% precisión (47 real / 5 placebo). Es la
 *     señal más fuerte → +50. ±1 día ~80% → +25. ±3 → +10. Más lejos, penaliza.
 *   · **Ref ↔ beneficiario/concepto**: el ref de la dispensación es el proveedor/propósito
 *     (`cueritos`, `bolsas`, `gnf ma`). Si un token del ref aparece en el beneficiario/concepto del
 *     gasto → +40. Es la señal estructural, no el monto.
 *   · **Monto**: exacto → +30; el retiro ≤ gasto (financió una parte, ej. 20k de 25k) → +10; el
 *     retiro > gasto → −20 (difícil que sea parte de ese gasto).
 *   · **Aprendido** (`v_caos_link_patterns`): si ese ref ya se confirmó antes hacia esta cuenta/
 *     beneficiario, sube la confianza (+ hasta 20 por nº de casos). Es lo que hace subir la
 *     precisión con el uso.
 *
 * `confianza`: alta ≥80 · media ≥45 · baja <45. La pantalla muestra el score y los MOTIVOS, para
 * que el humano confirme con criterio, no a ciegas.
 */

export interface GastoCtx {
  /** El importe objetivo (del documento de Kepler anclado, o null si captura manual). */
  monto?: number | null;
  /** Fecha del gasto (YYYY-MM-DD). */
  fecha: string;
  beneficiario?: string | null;
  concepto?: string | null;
  sucursal?: string | null;
}

export interface CaosCandidato {
  origen_ref: string;
  external_id: number;
  device: string;
  type_label: string;
  fecha_valor: string;
  sucursal: string;
  user_external: string | null;
  ref: string | null;
  monto: number;
  denominaciones: Array<{ denominacion: number; piezas: number }>;
}

/** Lo aprendido por ref (de `analytics.v_caos_link_patterns`), indexado por `ref_norm`. */
export interface PatronAprendido {
  ref_norm: string;
  casos: number;
  cuenta_tipica: string | null;
  concepto_tipico: string | null;
  beneficiario_tipico: string | null;
}

export interface PuntajeCaos {
  score: number;
  motivos: string[];
  confianza: 'alta' | 'media' | 'baja';
}

/** Palabras del ref que NO discriminan (aparecen en casi todo) — no cuentan como coincidencia. */
const STOP = new Set(['pagos', 'pago', 'caja', 'efectivo', 'varios', 'gastos', 'gasto']);

/** Normaliza: minúsculas, sin acentos, sin puntuación. */
export function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens del ref con ≥4 caracteres y que no sean palabras vacías. */
export function tokensRef(ref: string | null | undefined): string[] {
  return norm(ref).split(' ').filter((t) => t.length >= 4 && !STOP.has(t));
}

/**
 * CS.3.5 — Número de ruta embebido en un texto (el `ref` de CAOS `rd28`/`ruta 21`/`r23`, o el
 * beneficiario/concepto de Kepler `RUTA 28`/`R.D. 28`/`VENTA RD 28`). La ruta es una llave casi
 * limpia en AMBOS lados → medido: depósito↔cobro por ruta+día+monto≈ da ~94% de precisión.
 * Toma el PRIMER número (1-3 dígitos) que sigue a una `r`/`rd`/`ruta` — no la fecha (que va después).
 */
export function rutaDe(texto: string | null | undefined): number | null {
  const m = norm(texto).match(/\br\s*d?\s*(?:uta)?\s*0*(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

/** Días absolutos entre dos fechas YYYY-MM-DD (sin TZ: ambas son fechas de negocio). */
export function diasEntre(a: string, b: string): number {
  const da = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 9999;
  return Math.round(Math.abs(da - db) / 86400000);
}

/**
 * Puntúa un candidato de CAOS contra el gasto. Devuelve score + motivos legibles + confianza.
 * `aprendido` es opcional (cold-start funciona sin él; con él, sube la precisión).
 */
export function puntuarCaos(g: GastoCtx, c: CaosCandidato, aprendido?: Map<string, PatronAprendido>): PuntajeCaos {
  const motivos: string[] = [];
  let score = 0;

  // 1) Fecha — la señal más fuerte (medido).
  const lag = diasEntre(g.fecha, c.fecha_valor);
  if (lag === 0) { score += 50; motivos.push('mismo día'); }
  else if (lag === 1) { score += 25; motivos.push('±1 día'); }
  else if (lag <= 3) { score += 10; motivos.push(`±${lag} días`); }
  else { score -= 10; }

  // 2) Ref ↔ beneficiario/concepto del gasto — la señal estructural del lado GASTO.
  const txt = norm(`${g.beneficiario ?? ''} ${g.concepto ?? ''}`);
  const hit = txt ? tokensRef(c.ref).find((t) => txt.includes(t)) : undefined;
  if (hit) { score += 40; motivos.push(`ref «${hit}» coincide`); }

  // 2b) RUTA ↔ ruta — la señal del lado DEPÓSITO (ingresos). Llave casi limpia: el `ref` del cajero
  // y el `entidad_code`/concepto del cobro traen el mismo nº de ruta. Medido: ruta+día+monto≈ = 94%.
  const rc = rutaDe(c.ref);
  const rg = rutaDe(`${g.beneficiario ?? ''} ${g.concepto ?? ''}`);
  if (rc != null && rc === rg) { score += 45; motivos.push(`ruta ${rc}`); }

  // 3) Monto — exacto fuerte; ≈5% (depósito de ruta: el efectivo ≈ el cobro, no al peso); parcial
  // (retiro ≤ gasto) plausible; mayor que el objetivo, improbable.
  if (g.monto != null && g.monto > 0) {
    const cm = Math.abs(c.monto);
    const rel = Math.abs(cm - g.monto) / g.monto;
    if (cm === g.monto) { score += 30; motivos.push('monto exacto'); }
    else if (rel <= 0.05) { score += 22; motivos.push('monto ≈ (±5%)'); }
    else if (cm < g.monto) { score += 10; motivos.push('financia una parte'); }
    else { score -= 20; motivos.push('monto mayor que el objetivo'); }
  }

  // 4) Aprendido — lo que ya se confirmó para ese ref sube la confianza.
  const ap = aprendido?.get(norm(c.ref));
  if (ap && ap.casos > 0) { score += Math.min(20, ap.casos * 5); motivos.push(`ya confirmado antes (${ap.casos})`); }

  const confianza: PuntajeCaos['confianza'] = score >= 80 ? 'alta' : score >= 45 ? 'media' : 'baja';
  return { score, motivos, confianza };
}

/** Rankea y ordena los candidatos (mayor score primero); descarta los claramente negativos. */
export function rankearCaos(
  g: GastoCtx,
  candidatos: CaosCandidato[],
  aprendido?: Map<string, PatronAprendido>,
): Array<CaosCandidato & PuntajeCaos> {
  return candidatos
    .map((c) => ({ ...c, ...puntuarCaos(g, c, aprendido) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || diasEntre(g.fecha, a.fecha_valor) - diasEntre(g.fecha, b.fecha_valor));
}
