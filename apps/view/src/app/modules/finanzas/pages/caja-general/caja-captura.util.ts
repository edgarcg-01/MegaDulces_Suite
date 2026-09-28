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

import { denomDe, type Denominacion } from '@megadulces/contracts';

/**
 * CG.23 — Los billetes que la Caja General cuenta, en el orden en que se cuentan.
 *
 * ── Qué cambió, y por qué
 *
 * Acá había un catálogo PROPIO de 14 valores sueltos
 * (`[1000, 500, …, 0.2, 0.1, 0.05]`), duplicando el que ya vive en
 * `libs/contracts/src/money/denominations.ts` y que consumen la pantalla de tienda, la de
 * almacén y `blind-count.service`. Era la misma deuda que SM.39 cerró allá y que ADR-056
 * nombra: un primitivo compartido vive en `libs/`, o queda declarado como deuda.
 *
 * Y no era sólo duplicación: el catálogo de acá está **indexado por VALOR**, que es
 * exactamente el defecto que SM.39 arregló — México tiene billete de $20 **y** moneda de
 * $20, y un número no puede distinguirlos. Acá no muerde porque la caja no desglosa
 * monedas, pero la forma equivocada invita al bug.
 *
 * ── Por qué es una SELECCIÓN y no una lista nueva
 *
 * Decisión de Edgar (2026-09-23): *"en valores, existen billetes de 500, 200, 100, 50 y 20.
 * monedas no es necesario desglosarlo. en morralla queda perfecto"*. Así que la caja cuenta
 * **cinco** denominaciones y todo el metal cae en el campo Morralla.
 *
 * Eso se expresa eligiendo llaves del catálogo compartido, NO escribiendo otra lista: si
 * mañana `BILLETES_MXN` cambia una llave, esto **revienta al construirse** en vez de dejar
 * de ofrecer un billete en silencio. Un billete que desaparece de la reja es dinero que no
 * se puede contar, y ésa es la peor forma de fallar en un arqueo.
 *
 * ⚠️ El CHECK de `finance.cash_ledger_denominations` sigue admitiendo las 14; acá se ofrecen
 * 5. Volver a ofrecer el de $1,000 es agregar su llave a esta lista — sin migración.
 */
const CAJA_BILLETES_KEYS = ['500', '200', '100', '50', '20'] as const;

/**
 * Elige denominaciones del catálogo compartido por llave, y **falla ruidosamente** si alguna
 * no existe o no es billete. Es una función y no una constante armada inline para que la
 * prueba negativa pueda ejercerla: un gate sin prueba negativa es una intención.
 */
export function seleccionarBilletes(keys: readonly string[]): readonly Denominacion[] {
  return keys.map((k) => {
    const d = denomDe(k);
    if (!d) {
      throw new Error(
        'Denominacion "' + k + '" no existe en el catalogo MXN de @megadulces/contracts. ' +
        'La caja no puede ofrecer un billete que el catalogo compartido no reconoce.',
      );
    }
    if (d.familia !== 'billete') {
      throw new Error('La denominacion "' + k + '" es ' + d.familia + ', no billete.');
    }
    return d;
  });
}

/** Los cinco billetes de la caja, del mayor al menor. La morralla va aparte, en su campo. */
export const BILLETES_CAJA: readonly Denominacion[] = seleccionarBilletes(CAJA_BILLETES_KEYS);

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
  ventaCredito = 0,
): ResultadoArqueo {
  // CS.3.13 — El monto = EFECTIVO (denominaciones + morralla) + VENTA A CRÉDITO. La parte a crédito
  // no se cuenta en billetes pero es parte del total; por eso «cuenta» como desglose y su ausencia de
  // efectivo NO es «sin desglose» cuando hay crédito. `efectivo + crédito = monto`.
  const credito = Math.max(0, Number(ventaCredito) || 0);
  const conPiezas = (dens ?? []).filter((d) => d && Number(d.piezas) > 0);
  if (conPiezas.length === 0 && !Number(morralla) && credito <= 0) {
    return { estado: 'sin_desglose', desglosado: 0, diferencia: 0 };
  }
  const desglosado = sumaDesglose(dens, morralla) + credito;
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
  /** CS.3.13 — parte a crédito (no efectivo). `efectivo + venta_credito = monto`. */
  venta_credito?: number | null;
}

export type MotivoBloqueo =
  | 'falta_tipo' | 'falta_fecha' | 'falta_sucursal'
  | 'falta_concepto' | 'falta_concepto_de_cuenta' | 'glosa_corta' | 'monto_invalido' | 'falta_desglose' | 'arqueo_no_cuadra';

/** Texto que ve el capturista. Dice QUÉ falta, no "formulario inválido". */
export const TEXTO_BLOQUEO: Record<MotivoBloqueo, string> = {
  falta_tipo: 'Elegí el tipo de movimiento.',
  falta_fecha: 'Falta la fecha.',
  falta_sucursal: 'Falta la sucursal.',
  falta_concepto: 'Falta la cuenta y el concepto de Kepler: sin eso el movimiento no se puede contabilizar.',
  falta_concepto_de_cuenta: 'Falta el concepto de Kepler de esa cuenta: elegilo para poder contabilizar.',
  glosa_corta: `Contá qué pasó, con al menos ${GLOSA_MIN} caracteres. El concepto dice a qué cuenta va; esto dice qué pasó.`,
  monto_invalido: 'El monto tiene que ser mayor a cero.',
  falta_desglose: 'Contá el efectivo por denominación: el desglose es obligatorio, y de ahí sale el monto.',
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
  // El par va COMPLETO o no va: media cuenta no contabiliza nada. CS.3.1b — si la cuenta ya está
  // (vino del documento o se eligió) y sólo falta el concepto, se dice ESO, no "falta la cuenta":
  // decir que falta un dato presente es la mentira que esta fase vino a quitar.
  if (!f.kepler_cuenta) m.push('falta_concepto');
  else if (!f.kepler_concepto) m.push('falta_concepto_de_cuenta');
  if (!f.glosa || f.glosa.trim().length < GLOSA_MIN) m.push('glosa_corta');

  // CG.23 — El arqueo es OBLIGATORIO, no un detalle plegado. Decisión de Edgar: "el desglose
  // no es opcional". Antes el desglose era un `<details>` rotulado "(opcional)" y el monto se
  // tecleaba suelto, así que el caso normal era registrar efectivo SIN contarlo y `sin_desglose`
  // no frenaba nada. Ahora el monto SALE del conteo, así que "no contó" y "monto en cero" son
  // la misma situación — y se dice UNA vez, con el texto que sirve ("contá"), no dos.
  const arqueo = estadoArqueo(Number(f.monto), f.denominaciones, Number(f.morralla || 0), Number(f.venta_credito || 0));
  if (arqueo.estado === 'sin_desglose') {
    m.push('falta_desglose');
  } else if (!(Number(f.monto) > 0)) {
    m.push('monto_invalido');
  }
  // Sigue vivo aunque la pantalla derive el monto del conteo: esta función es el contrato laxo
  // que consume cualquier llamador, y uno que mande monto y desglose por separado tiene que
  // chocar acá y no en un 400 del servidor.
  if (arqueo.estado === 'difiere') m.push('arqueo_no_cuadra');
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
  /**
   * 'propuesto' pinta el campo como sugerido; 'vacio' lo deja en blanco con su aviso;
   * 'manual' es lo que el humano eligió él mismo.
   *
   * ⚠️ 'manual' se agregó en CG.22 porque faltaba el tercer estado y su ausencia MENTÍA: la
   * pantalla sólo miraba la propuesta, así que después de elegir el concepto a mano en el
   * buscador seguía diciendo "Propuesto de la sesión — 12 antecedentes, 80% coinciden". La
   * etiqueta existe justamente para separar propuesto de tecleado.
   */
  tono: 'propuesto' | 'vacio' | 'manual';
  texto: string;
}

/** Lo eligió la persona. No hay procedencia que declarar más que esa. */
export function etiquetaManual(): EtiquetaProcedencia {
  return { tono: 'manual', texto: 'Elegido a mano por vos.' };
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

// ── CG.15 · El corte de caja, del lado de la pantalla ───────────────────────────────────
//
// ⚠️ ESTO ESPEJA a `libs/finance/src/lib/caja/cash-cut.engine.ts` A PROPÓSITO, no por
// descuido: `apps/view` no puede importar de `@megadulces/finance` (sólo consume
// `contracts`, `shared-scoring` y `ui-web`, y la compuerta de fronteras lo hace cumplir).
// Existe para apagar un botón con su motivo en vez de que el usuario choque contra un 403.
// **El candado está en la DB** (`cut_doble_llave_chk`); si esto y el servidor divergen manda
// el servidor, y esto sólo puede ser IGUAL o MÁS ESTRICTO.

export type VeredictoCorte = 'cuadra' | 'sobra' | 'falta' | 'sin_contar';

export interface CorteVista {
  id: string;
  folio: string;
  estado: 'borrador' | 'cerrado' | 'autorizado';
  closed_by?: string | null;
  closed_by_username?: string | null;
  authorized_by_username?: string | null;
  fondo_inicial?: number;
  esperado?: number | null;
  contado?: number | null;
  diferencia?: number | null;
}

/**
 * ⛔ **RETIRADA (CG.19 Capa 1b) — no la vuelvas a cablear.**
 *
 * Calculaba el veredicto **en el navegador**, a partir de un `esperado` que el servidor le había
 * mandado. Eso es exactamente lo que el arqueo ciego elimina: con el esperado en el bundle,
 * ocultarlo en la plantilla no oculta nada, y la persona cuenta hasta que la diferencia dé cero.
 *
 * El veredicto ahora lo produce el SERVIDOR al **sellar** el conteo
 * (`POST /finance/cash-ledger/cortes/:id/contar` → `cash-cut.engine.ts#calcularCorte`), que es el
 * único momento en que el conteo ya no se puede retocar en silencio.
 *
 * Se deja la firma borrada a propósito en vez de dejar la función "por si acaso": una herramienta
 * que hace justo lo que el candado prohíbe es una invitación a romperlo sin querer. Lo único que
 * valía la pena de acá —que `sin_contar` es un estado propio y no `cuadra`— ya está probado del
 * lado del servidor, en `cash-cut.engine.spec.ts`.
 *
 * ⚠️ `sumaDesglose` SÍ sigue viva y es legítima: suma lo que la persona misma tecleó y no toca el
 * esperado. Es lo que la pantalla muestra mientras se cuenta a ciegas.
 */

/** La doble llave, para el botón. Devuelve el motivo, no un booleano pelado. */
export function puedeAutorizarUI(
  c: CorteVista | null, userId: string | null | undefined,
): { ok: boolean; texto: string } {
  if (!c) return { ok: false, texto: 'No hay corte.' };
  if (!userId) return { ok: false, texto: 'No se pudo identificar quién autoriza.' };
  if (c.estado === 'autorizado') {
    return { ok: false, texto: `Autorizado por ${c.authorized_by_username ?? 'otra persona'}.` };
  }
  if (c.estado !== 'cerrado') return { ok: false, texto: 'Primero hay que cerrar el corte.' };
  if (c.closed_by && c.closed_by === userId) {
    return { ok: false, texto: 'Vos cerraste este corte: tiene que autorizarlo otra persona.' };
  }
  return { ok: true, texto: `Cerrado por ${c.closed_by_username ?? 'el capturista'} — listo para autorizar.` };
}

export function puedeCerrarUI(c: CorteVista | null, veredicto: VeredictoCorte): { ok: boolean; texto: string } {
  if (!c) return { ok: false, texto: 'No hay corte abierto.' };
  if (c.estado !== 'borrador') return { ok: false, texto: 'Este corte ya está cerrado.' };
  if (veredicto === 'sin_contar') return { ok: false, texto: 'Contá el efectivo antes de cerrar.' };
  // Se puede cerrar aunque NO cuadre: un faltante se registra, no se esconde.
  return {
    ok: true,
    texto: veredicto === 'cuadra'
      ? 'Cuadra — listo para cerrar.'
      : 'No cuadra, pero se puede cerrar: la diferencia queda registrada.',
  };
}

/**
 * El saldo. `null` NO es cero: sin corte abierto la caja no tiene punto de partida, y
 * dibujar $0.00 sería inventar un dato (ADR-056).
 */
export function textoSaldo(
  r: { saldo: number | null; sin_corte_abierto?: boolean; corte_abierto?: { folio: string } | null } | null | undefined,
): string {
  if (!r) return 'Saldo: sin medir.';
  if (r.sin_corte_abierto || r.saldo === null || r.saldo === undefined) {
    return 'Saldo: sin corte abierto — la caja no tiene punto de partida.';
  }
  const m = r.saldo.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  return `Saldo en caja: ${m} (corte ${r.corte_abierto?.folio ?? '—'}).`;
}
