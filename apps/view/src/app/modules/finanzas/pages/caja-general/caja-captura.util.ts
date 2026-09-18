/**
 * CG.14 — Lógica pura de la captura de Caja General (ADR-070).
 *
 * Acá vive lo que la pantalla DECIDE: si el arqueo cuadra, si se puede guardar, y cómo se
 * le muestra al capturista de dónde salió cada campo autorrellenado. Sin Angular, sin HTTP,
 * sin DOM — para que se pueda probar de verdad y no por inspección visual.
 *
 * Las reglas de abajo son las MISMAS del backend a propósito. No es duplicación por descuido:
 * es que el capturista tiene que enterarse ANTES de mandar, no por un 400. Si alguna vez
 * divergen, la que manda es la del servidor (ahí está el candado); la de acá sólo puede ser
 * IGUAL o MÁS ESTRICTA, nunca más permisiva.
 */

/** Las 14 denominaciones que el arqueo maneja. La morralla suelta va aparte, en su campo. */
export const DENOMINACIONES = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05] as const;

/** Largo mínimo de la glosa. Espejo del CHECK de `finance.cash_ledger`. */
export const GLOSA_MIN = 5;

/** Tolerancia del cuadre: un centavo, por el redondeo de numeric. */
export const ARQUEO_EPSILON = 0.005;

export interface DenominacionCapturada { denominacion: number; piezas: number }

export type EstadoArqueo = 'sin_desglose' | 'cuadra' | 'difiere';

export interface ResultadoArqueo {
  estado: EstadoArqueo;
  /** Lo que suma el desglose + la morralla. 0 si no hay desglose. */
  desglosado: number;
  /** desglosado − monto. Positivo = sobra en el conteo; negativo = falta. */
  diferencia: number;
}

/** Suma el desglose. Ignora renglones en cero: teclear 0 piezas es no haberlo capturado. */
export function sumaDesglose(dens: DenominacionCapturada[] | null | undefined, morralla = 0): number {
  const suma = (dens ?? [])
    .filter((d) => d && Number(d.piezas) > 0)
    .reduce((a, d) => a + Number(d.denominacion) * Number(d.piezas), 0);
  return redondea(suma + Number(morralla || 0));
}

/** Redondeo a centavos. Sin esto, 0.1+0.2 deja residuos que se ven como descuadre. */
export function redondea(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Estado del arqueo. **Sin desglose NO es "cuadra"**: es que no se contó. Esa distinción es
 * la que evita que un movimiento sin arqueo se vea igual que uno arqueado y correcto.
 */
export function estadoArqueo(
  monto: number,
  dens: DenominacionCapturada[] | null | undefined,
  morralla = 0,
): ResultadoArqueo {
  const conPiezas = (dens ?? []).filter((d) => d && Number(d.piezas) > 0);
  if (conPiezas.length === 0 && !Number(morralla)) {
    return { estado: 'sin_desglose', desglosado: 0, diferencia: 0 };
  }
  const desglosado = sumaDesglose(dens, morralla);
  const diferencia = redondea(desglosado - Number(monto || 0));
  return { estado: Math.abs(diferencia) <= ARQUEO_EPSILON ? 'cuadra' : 'difiere', desglosado, diferencia };
}

export interface FormularioCaja {
  tipo?: string | null;
  fecha?: string | null;
  sucursal?: string | null;
  kepler_cuenta?: string | null;
  kepler_concepto?: string | null;
  glosa?: string | null;
  monto?: number | null;
  morralla?: number | null;
  denominaciones?: DenominacionCapturada[] | null;
}

export type MotivoBloqueo =
  | 'falta_tipo' | 'falta_fecha' | 'falta_sucursal'
  | 'falta_concepto' | 'glosa_corta' | 'monto_invalido' | 'arqueo_no_cuadra';

/** Texto que ve el capturista. Dice QUÉ falta, no "formulario inválido". */
export const TEXTO_BLOQUEO: Record<MotivoBloqueo, string> = {
  falta_tipo: 'Elegí el tipo de movimiento.',
  falta_fecha: 'Falta la fecha.',
  falta_sucursal: 'Falta la sucursal.',
  falta_concepto: 'Falta la cuenta y el concepto de Kepler: sin eso el movimiento no se puede contabilizar.',
  glosa_corta: `Contá qué pasó, con al menos ${GLOSA_MIN} caracteres. El concepto dice a qué cuenta va; esto dice qué pasó.`,
  monto_invalido: 'El monto tiene que ser mayor a cero.',
  arqueo_no_cuadra: 'El desglose por denominación no cuadra con el monto.',
};

/**
 * ¿Se puede guardar? Devuelve TODOS los motivos, no el primero: que el capturista vea de una
 * vez lo que le falta en vez de descubrirlo de a uno.
 */
export function motivosDeBloqueo(f: FormularioCaja): MotivoBloqueo[] {
  const m: MotivoBloqueo[] = [];
  if (!f.tipo) m.push('falta_tipo');
  if (!f.fecha) m.push('falta_fecha');
  if (!f.sucursal) m.push('falta_sucursal');
  // El par va COMPLETO o no va: media cuenta no contabiliza nada.
  if (!f.kepler_cuenta || !f.kepler_concepto) m.push('falta_concepto');
  if (!f.glosa || f.glosa.trim().length < GLOSA_MIN) m.push('glosa_corta');
  if (!(Number(f.monto) > 0)) m.push('monto_invalido');
  if (estadoArqueo(Number(f.monto), f.denominaciones, Number(f.morralla || 0)).estado === 'difiere') {
    m.push('arqueo_no_cuadra');
  }
  return m;
}

export function puedeGuardar(f: FormularioCaja): boolean {
  return motivosDeBloqueo(f).length === 0;
}

// ── Cómo se le muestra al capturista de dónde salió un campo ────────────────────────────

export interface PropuestaVista {
  value: unknown;
  source: string | null;
  confidence: number | null;
  support?: number;
  supportRatio?: number;
  reason?: string;
}

export interface EtiquetaProcedencia {
  /** 'propuesto' pinta el campo como sugerido; 'vacio' lo deja en blanco con su aviso. */
  tono: 'propuesto' | 'vacio';
  texto: string;
}

const TEXTO_FUENTE: Record<string, string> = {
  contexto: 'de la sesión',
  documento: 'del documento',
  aprendido: 'de lo que contabilidad ya hizo',
  regla: 'de una regla',
  ocr: 'del comprobante escaneado',
};

const TEXTO_MOTIVO: Record<string, string> = {
  sin_historia: 'Sin propuesta: no hay historia de este proveedor.',
  soporte_insuficiente: 'Sin propuesta: hay muy pocos antecedentes para arriesgar uno.',
  empate: 'Sin propuesta: los antecedentes están repartidos entre varios conceptos.',
  sin_regla: 'Sin propuesta: ninguna regla aplica.',
  sin_documento: 'Sin propuesta: no se encontró un documento de origen.',
};

/**
 * ⛔ Un campo propuesto NUNCA se muestra como si el humano lo hubiera puesto. La etiqueta
 * es la diferencia entre "el sistema sugiere esto" y "esto es un hecho": sin ella, el
 * autorrelleno se acepta sin mirarlo y cambiamos movimientos sin concepto por movimientos
 * mal clasificados (ADR-070 §8.5).
 */
export function etiquetaProcedencia(p: PropuestaVista | null | undefined): EtiquetaProcedencia {
  if (!p || p.value === null || p.value === undefined) {
    const motivo = p?.reason ? TEXTO_MOTIVO[p.reason] : undefined;
    // Un vacío sin motivo conocido se declara como tal; NO se inventa una explicación.
    return { tono: 'vacio', texto: motivo ?? 'Sin propuesta: capturalo a mano.' };
  }
  const fuente = TEXTO_FUENTE[p.source ?? ''] ?? 'de origen no declarado';
  if (p.support && p.supportRatio) {
    const pct = Math.round(p.supportRatio * 100);
    return { tono: 'propuesto', texto: `Propuesto ${fuente} — ${p.support} antecedentes, ${pct}% coinciden.` };
  }
  return { tono: 'propuesto', texto: `Propuesto ${fuente}.` };
}

/**
 * Cobertura del catálogo, en una línea. Va SIEMPRE en pantalla: "0 conceptos" por carril
 * caído no puede leerse igual que "esta sucursal no tiene conceptos" (ADR-056).
 */
export function textoCobertura(filas: Array<{ usables: number; filas_origen: number; sin_subcuenta: number }> | null | undefined): string {
  if (!filas || filas.length === 0) return 'Cobertura del catálogo: sin medir.';
  const usables = filas.reduce((a, r) => a + Number(r.usables || 0), 0);
  const origen = filas.reduce((a, r) => a + Number(r.filas_origen || 0), 0);
  const sinSub = filas.reduce((a, r) => a + Number(r.sin_subcuenta || 0), 0);
  if (usables === 0) return `Catálogo de conceptos VACÍO (${origen} filas en el origen). Revisá el carril del ODS antes de capturar.`;
  const cola = sinSub > 0 ? ` · ${sinSub} sin subcuenta, fuera del catálogo` : '';
  return `${usables.toLocaleString('es-MX')} conceptos de ${origen.toLocaleString('es-MX')}${cola}.`;
}
