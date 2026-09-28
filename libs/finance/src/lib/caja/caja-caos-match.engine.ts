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

/**
 * CS.3.6 — La FECHA DE NEGOCIO embebida en el texto (no la de registro). Es la llave real del
 * emparejamiento de ruta: el cobro trae `VENTA RD 21 19-09-2026` y el depósito `rd21 19/09` — la
 * venta del 19 puede registrarse/depositarse el 24 en ambos lados. Se quita primero el prefijo de
 * ruta (para no leer el nº de ruta como día) y se toma la primera fecha DD-MM VÁLIDA. Salida `DD-MM`.
 * `null` si no hay fecha inequívoca (ej. `ruta 21 09 26` incompleto, `ruta22250926` concatenado).
 */
function fechaValida(dd: string, mm: string): boolean {
  const d = Number(dd); const m = Number(mm);
  return d >= 1 && d <= 31 && m >= 1 && m <= 12;
}
export function fechaNegocio(texto: string | null | undefined): string | null {
  const t = norm(texto).replace(/\br\s*d?\s*(?:uta)?\s*0*\d{1,3}\b/, ' ');
  const full = t.match(/\b(\d{2})[ -](\d{2})[ -]\d{4}\b/); // DD-MM-YYYY (concepto de Kepler)
  if (full && fechaValida(full[1], full[2])) return `${full[1]}-${full[2]}`;
  for (const m of t.matchAll(/\b(\d{2})[ /](\d{2})\b/g)) if (fechaValida(m[1], m[2])) return `${m[1]}-${m[2]}`;
  return null;
}

/** Días absolutos entre dos fechas YYYY-MM-DD (sin TZ: ambas son fechas de negocio). */
export function diasEntre(a: string, b: string): number {
  const da = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 9999;
  return Math.round(Math.abs(da - db) / 86400000);
}

/**
 * CS.3.6 — Coacciona a 'YYYY-MM-DD' cualquier fecha que devuelva el driver de Postgres. Los tipos
 * `date` y `timestamptz` llegan como OBJETO Date (node-postgres, sin parser custom), NO string → el
 * viejo `String(date).slice(0,10)` daba "Wed Sep 27" → `Date.parse` NaN → `new Date(NaN).toISOString()`
 * TIRABA y reventaba la bandeja entera (medido en prod: movimientos-pendientes → 500 cada minuto).
 * Devuelve null si no es una fecha usable (se DECLARA, no se inventa). Los mocks del spec pasaban
 * strings, por eso los 60 tests verdes no lo cacharon.
 */
export function ymd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  // Sólo un prefijo ISO YYYY-MM-DD (cubre 'date' y 'timestamp' ISO). NADA de `Date.parse` sobre texto
  // suelto: `Date.parse('Sun Sep 27')` inventa año 2001 — coaccionar basura a una fecha es inventar.
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Puntúa un candidato de CAOS contra el gasto. Devuelve score + motivos legibles + confianza.
 * `aprendido` es opcional (cold-start funciona sin él; con él, sube la precisión).
 */
export function puntuarCaos(g: GastoCtx, c: CaosCandidato, aprendido?: Map<string, PatronAprendido>): PuntajeCaos {
  const motivos: string[] = [];
  let score = 0;
  const gtxt = `${g.beneficiario ?? ''} ${g.concepto ?? ''}`;

  // 1) RUTA — llave estructural del lado INGRESO (depósito de ruta ↔ cobro de ruta). El nº de ruta
  //    está limpio en ambos: `entidad_code='RUTA 21'`/concepto en Kepler, `rd21` en el ref de CAOS.
  const rc = rutaDe(c.ref);
  const rg = rutaDe(gtxt);
  const rutaOk = rc != null && rc === rg;
  if (rutaOk) { score += 45; motivos.push(`ruta ${rc}`); }

  // 2) FECHA DE NEGOCIO — la del TEXTO, no la de registro. Medido: `VENTA RD 21 19-09` se deposita
  //    como `rd21 19/09` aunque ambos se registren el 24. ruta + fecha de negocio + depósito≤cobro =
  //    ~98% de precisión (90 real / 2 placebo). Es la llave real del emparejamiento de ruta.
  const fg = fechaNegocio(gtxt);
  const fc = fechaNegocio(c.ref);
  if (fg && fc && fg === fc) { score += 40; motivos.push(`fecha ${fg}`); }

  // 3) REF ↔ beneficiario/concepto — señal del lado GASTO (proveedor/propósito). Sólo si NO casó por
  //    ruta: una dispensación (`cueritos`, `nomina`) no trae ruta y se ata por el nombre del proveedor.
  if (!rutaOk) {
    const txt = norm(gtxt);
    const hit = txt ? tokensRef(c.ref).find((t) => txt.includes(t)) : undefined;
    if (hit) { score += 40; motivos.push(`ref «${hit}» coincide`); }
  }

  // 4) MONTO — el efectivo del cajero es PARTE del movimiento de Kepler: el depósito es SIEMPRE ≤ el
  //    cobro (medido 53/53), y la diferencia es lo retenido/gastos de ruta. Por eso «≤» SUMA (no un
  //    ≈5% que rechazaba diferencias reales de hasta 12%). Exacto es más fuerte; MAYOR es improbable.
  if (g.monto != null && g.monto > 0) {
    const cm = Math.abs(c.monto);
    if (cm === g.monto) { score += 30; motivos.push('monto exacto'); }
    else if (cm <= g.monto) { score += 15; motivos.push('parte del arqueo'); }
    else if (cm <= g.monto * 1.05) { score += 8; motivos.push('monto ≈'); }
    else { score -= 25; motivos.push('monto mayor que el movimiento'); }
  }

  // 5) Fecha de REGISTRO — respaldo DÉBIL (NO es la llave; la de negocio manda y puede diferir).
  const lag = diasEntre(g.fecha, c.fecha_valor);
  if (lag === 0) { score += 12; }
  else if (lag <= 3) { score += 5; }
  else if (lag > 15) { score -= 10; }

  // 6) Aprendido — lo ya confirmado para ese ref sube la confianza.
  const ap = aprendido?.get(norm(c.ref));
  if (ap && ap.casos > 0) { score += Math.min(15, ap.casos * 5); motivos.push(`ya confirmado (${ap.casos})`); }

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
