/**
 * `[AB.16]` Fase AB — **«Mi pedido»**: el pedido de la semana de una sucursal, ya agrupado por a
 * quién se le pide (su matriz o el proveedor directo), con lo ya pedido, lo atorado, lo negado y
 * la cantidad redondeada a como se captura en Kepler.
 *
 * Este archivo trae la FORMA de la respuesta (ADR-052) y la **regla de redondeo** como función
 * pura: la calcula el servidor y la prueba su candado, en un solo lugar (FASE_AB §15.2). La
 * pantalla sólo la pinta; si la recalculara, el pedido impreso y el de la tabla podrían no cuadrar.
 */

// Sólo el tipo: la mesa importa valores de este archivo, y un `import type` se borra al compilar,
// así que no arma un ciclo en tiempo de ejecución.
import type { DiagnosticoRenglon } from './autoabasto-mesa.contract';

/** La escalera de unidades de Kepler de un producto (`analytics.v_product_unit_ladder`). */
export interface EscaleraUnidades {
  /** Rótulo de la unidad base (PZA, PAQ, KG…); la existencia y la venta vienen en ésta. */
  unit_base: string | null;
  u2_label: string | null;
  u3_label: string | null;
  /** Unidades base por peldaño 2. `null` = el peldaño no existe o es degenerado (factor 1). */
  f2: number | null;
  /** Unidades base por peldaño 3. `null` = no existe o es degenerado. */
  f3: number | null;
  /** Se vende por peso (granel). */
  is_weight: boolean;
}

/**
 * Cómo se resolvió la cantidad:
 *  · `cajas`        — 0.5 o más de la unidad mayor: unidades mayores completas.
 *  · `menor`        — menos de 0.5 de la unidad mayor: se pide en la unidad inmediata menor.
 *  · `granel`       — producto por peso: kilos completos.
 *  · `base`         — el producto sólo tiene unidad base: se pide en ésa, entera.
 *  · `sin_escalera` — Kepler no trae su escalera: se DECLARA la cantidad sin redondear.
 *  · `nada`         — no falta nada, o el redondeo da 0.
 */
export type ReglaRedondeo = 'cajas' | 'menor' | 'granel' | 'base' | 'sin_escalera' | 'nada';

/**
 * `[AB.19]` En qué lista va el renglón al surtirlo (decisión de Francisco, 2026-10-12): la matriz
 * arma una orden de unidades mayores (cajas, bultos) y otra de unidades menores (piezas, paquetes,
 * kilos), y aparte los productos que sólo tienen una unidad para todo.
 *  · `mayor`      — se pide en la unidad mayor.
 *  · `menor`      — tiene unidad mayor, pero lo que falta es menos de media: va en la menor.
 *  · `unica`      — el producto sólo tiene una unidad (base o granel sin caja).
 *  · `sin_unidad` — Kepler no trae su escalera: no se sabe en qué unidad va.
 */
export type ClaseUnidad = 'mayor' | 'menor' | 'unica' | 'sin_unidad';

export const CLASES_UNIDAD: readonly ClaseUnidad[] = ['mayor', 'menor', 'unica', 'sin_unidad'];

export const CLASE_UNIDAD_LABEL: Record<ClaseUnidad, string> = {
  mayor: 'Unidad mayor',
  menor: 'Unidad menor',
  unica: 'Una sola unidad',
  sin_unidad: 'Sin unidad en Kepler',
};

export interface RedondeoPedido {
  regla: ReglaRedondeo;
  /** `[AB.19]` La lista de surtido a la que pertenece el renglón. */
  clase: ClaseUnidad;
  /** Cantidad a capturar, en `unidad`. Nunca mezcla cajas y piezas en el mismo renglón. */
  cantidad: number;
  /** Rótulo de la unidad en que se pide. `null` si Kepler no la rotula. */
  unidad: string | null;
  /** Lo mismo expresado en unidad base, para sumar y valuar. */
  cantidad_base: number;
  /** Cuánto falta en la unidad mayor SIN redondear, para que la resta se pueda auditar. */
  falta_mayor: number | null;
  /**
   * `[AB.18]` Unidades base por cada `unidad` (caja = su factor; la menor = el suyo; base = 1).
   * Es lo que permite al − / + avanzar en la unidad de captura y llevar el ajuste a unidad base
   * sin que la pantalla adivine el factor. `null` = sin escalera: no hay factor confiable.
   */
  factor: number | null;
}

/** Redondeo "medio hacia arriba" robusto a la representación en coma flotante (3.5 → 4). */
function redondearMedioArriba(x: number): number {
  return Math.floor(x + 0.5 + 1e-9);
}

/**
 * La regla de FASE_AB §15.2, decidida por Francisco el 2026-10-07. Sobre lo que falta, en la
 * unidad MAYOR:
 *
 *   | falta (unidad mayor) | se pide                                                     |
 *   |----------------------|-------------------------------------------------------------|
 *   | menos de 0.5         | en la unidad inmediata menor (0.3 caja de 12 → 3.6 → 4 pz)  |
 *   | 0.5 o más            | sólo unidades mayores completas, .5 sube y menos de .5 baja |
 *
 * Granel: si tiene unidad mayor (caja, bulto) sigue la MISMA regla y su menor son los kilos
 * (`[AB.19]`, decisión de Francisco 2026-10-12: medido, 212 de 308 productos a granel la tienen);
 * sin unidad mayor, kilos completos (7.4 → 7, 7.5 → 8). Si en la menor da 0, no se pide.
 *
 * @param faltaBase lo que falta, en la unidad BASE del producto.
 */
export function redondearPedido(faltaBase: number, esc: EscaleraUnidades | null): RedondeoPedido {
  const falta = Number(faltaBase);
  const nada = (clase: ClaseUnidad, unidad: string | null, falta_mayor: number | null, factor: number | null = 1): RedondeoPedido =>
    ({ regla: 'nada', clase, cantidad: 0, unidad, cantidad_base: 0, falta_mayor, factor });

  const f2 = esc?.f2 && esc.f2 > 1 ? esc.f2 : null;
  const f3 = esc?.f3 && esc.f3 > 1 ? esc.f3 : null;
  const mayor = f3 ?? f2;

  if (!Number.isFinite(falta) || falta <= 0) {
    // Nada que pedir, pero el − / + tiene que poder agregar: se ofrece la unidad mayor si existe.
    if (!esc) return nada('sin_unidad', null, 0, null);
    if (!mayor) return nada('unica', esc.unit_base, null, 1);
    return nada('mayor', f3 ? esc.u3_label : esc.u2_label, 0, mayor);
  }

  // Sin escalera no hay con qué decidir la unidad: se declara la cantidad, no se inventa.
  if (!esc) {
    return { regla: 'sin_escalera', clase: 'sin_unidad', cantidad: Math.round(falta * 100) / 100, unidad: null, cantidad_base: falta, falta_mayor: null, factor: null };
  }

  if (!mayor) {
    const n = redondearMedioArriba(falta);
    const regla: ReglaRedondeo = esc.is_weight ? 'granel' : 'base';
    return n > 0
      ? { regla, clase: 'unica', cantidad: n, unidad: esc.unit_base, cantidad_base: n, falta_mayor: null, factor: 1 }
      : nada('unica', esc.unit_base, null, 1);
  }

  const etiquetaMayor = f3 ? esc.u3_label : esc.u2_label;
  // La inmediata menor: con tres peldaños es el del medio; con dos, la base.
  const menor = f3 && f2 ? f2 : 1;
  const etiquetaMenor = f3 && f2 ? esc.u2_label : esc.unit_base;
  const faltaMayor = falta / mayor;

  if (faltaMayor < 0.5) {
    const n = redondearMedioArriba(falta / menor);
    return n > 0
      ? { regla: 'menor', clase: 'menor', cantidad: n, unidad: etiquetaMenor, cantidad_base: n * menor, falta_mayor: faltaMayor, factor: menor }
      : nada('menor', etiquetaMenor, faltaMayor, menor);
  }
  const cajas = redondearMedioArriba(faltaMayor);
  return { regla: 'cajas', clase: 'mayor', cantidad: cajas, unidad: etiquetaMayor, cantidad_base: cajas * mayor, falta_mayor: faltaMayor, factor: mayor };
}

// ── [AB.22] Días de cobertura del objetivo por demanda, por almacén ─────────────────────────

/**
 * Para cuántos días de venta pide cada almacén (decisión de Francisco, 2026-10-13). El objetivo
 * de Autoabasto es `venta diaria × temporalidad × cobertura`; hasta AB.21 la cobertura era 30
 * días fijos para todos (igual que el default de /compras/pedido).
 *  · sucursales que no abastecen a otras → 21 días;
 *  · rutas → 2.5 días (se surten casi a diario);
 *  · el resto (CEDIS y matrices 00, 01, 06, 08) → 30 días.
 * ⚠️ Se aplica por CÓDIGO de almacén tal como vive en `commercial.warehouses.code` (las rutas son
 * `RUTA-NN`, medido en prod 2026-10-13). Ruta 321 y 322 no tienen plan de reabasto: quedan en 30.
 */
export const COBERTURA_AUTOABASTO_DEFAULT = 30;
export const COBERTURA_AUTOABASTO: Readonly<Record<string, number>> = {
  '02': 21, '03': 21, '04': 21, '05': 21, '07': 21,
  'RUTA-21': 2.5, 'RUTA-22': 2.5, 'RUTA-23': 2.5, 'RUTA-26': 2.5, 'RUTA-27': 2.5, 'RUTA-28': 2.5,
  'RUTA-501': 2.5, 'RUTA-502': 2.5, 'RUTA-503': 2.5, 'RUTA-504': 2.5, 'RUTA-505': 2.5,
};

/** Días de cobertura de un almacén por su código. Sin código conocido, el default (30). */
export function coberturaAutoabasto(code: string | null | undefined): number {
  return COBERTURA_AUTOABASTO[String(code ?? '').trim().toUpperCase()] ?? COBERTURA_AUTOABASTO_DEFAULT;
}

/**
 * La misma regla como expresión SQL sobre la columna del código de almacén (p. ej. `w.code`), para
 * que el motor y la pantalla no puedan divergir: los dos leen el mismo mapa.
 */
export function coberturaAutoabastoSql(colCodigo: string): string {
  const casos = Object.entries(COBERTURA_AUTOABASTO)
    .map(([c, d]) => `WHEN '${c.replace(/'/g, "''")}' THEN ${d}`).join(' ');
  return `(CASE upper(btrim(${colCodigo})) ${casos} ELSE ${COBERTURA_AUTOABASTO_DEFAULT} END)`;
}

// ── [AB.20] Mínimo en pesos para lo que se pide en unidad menor ──────────────────────────────

/**
 * Un renglón en unidad menor (piezas, paquetes, kilos de un producto que SÍ tiene caja) que vale
 * menos de esto no se pide: no vale la pena surtir un renglón suelto tan chico (decisión de
 * Francisco, 2026-10-12). Se espera a que falte más; el almacenista lo puede subir con +.
 */
export const MINIMO_VALOR_MENOR = 200;

/**
 *  · `no_aplica` — el renglón no va en unidad menor (cajas, una sola unidad, nada que pedir).
 *  · `cumple`    — va en unidad menor y vale el mínimo o más.
 *  · `debajo`    — va en unidad menor y vale menos: se quitó del pedido.
 *  · `sin_costo` — va en unidad menor pero no tiene costo: el mínimo NO se pudo revisar y el
 *                  renglón se queda como estaba (no se supone ni que cumple ni que no).
 *  · `agotado`   — va en unidad menor y vale menos, pero está AGOTADO: se pide igual (decisión de
 *                  Francisco, 2026-10-12: el mínimo frena bajo mínimo y bajo reorden, nunca un agotado).
 */
export type EstadoMinimoMenor = 'no_aplica' | 'cumple' | 'debajo' | 'sin_costo' | 'agotado';

export interface MinimoMenorAplicado {
  redondeo: RedondeoPedido;
  estado: EstadoMinimoMenor;
  /** Lo que valía el renglón en unidad menor antes de aplicar el mínimo. `null` = sin costo o no aplica. */
  valor_menor: number | null;
}

/**
 * Aplica el mínimo en pesos a un renglón ya redondeado. `costoBase` = costo por unidad BASE;
 * `posicion` = el `bucket` del motor (un agotado nunca se frena).
 */
export function aplicarMinimoMenor(
  r: RedondeoPedido, costoBase: number | null, posicion: string, minimo = MINIMO_VALOR_MENOR,
): MinimoMenorAplicado {
  if (r.regla !== 'menor' || r.cantidad <= 0) return { redondeo: r, estado: 'no_aplica', valor_menor: null };
  const costo = costoBase == null ? NaN : Number(costoBase);
  if (!Number.isFinite(costo) || costo <= 0) return { redondeo: r, estado: 'sin_costo', valor_menor: null };
  const valor = Math.round(r.cantidad_base * costo * 100) / 100;
  if (valor + 1e-9 >= minimo) return { redondeo: r, estado: 'cumple', valor_menor: valor };
  if (posicion === 'agotado') return { redondeo: r, estado: 'agotado', valor_menor: valor };
  // Se queda en la unidad menor con su factor, para que el + pueda pedirlo si la persona quiere.
  return { redondeo: { ...r, regla: 'nada', cantidad: 0, cantidad_base: 0 }, estado: 'debajo', valor_menor: valor };
}

// ── [AB.19] Qué posiciones entran al pedido ──────────────────────────────────────────────────

/**
 * El almacenista decide hasta dónde pide (decisión de Francisco, 2026-10-12): sólo lo agotado,
 * agotado + bajo mínimo, o además lo bajo reorden. `otros` = renglones que el motor de demanda
 * pide aunque la existencia ya esté sobre el punto de reorden (sano o sobrestock).
 */
export const POSICIONES_PEDIDO = ['agotado', 'bajo_minimo', 'bajo_reorden', 'otros'] as const;
export type PosicionPedido = typeof POSICIONES_PEDIDO[number];

/**
 * `[AB.39]` Lo que entra por default: agotado y bajo mínimo (PM, 2026-10-26). Hasta hoy entraba también
 * «bajo reorden», y las 4 sucursales que guardaron sus posiciones lo habían quitado. Medido ese día en las
 * otras 4: sale el 18–30 % del valor del pedido (Padre Hidalgo 193 renglones / $1.04 M, Morelia Abastos
 * 250 / $1.34 M). Quien lo quiera, lo marca y se guarda en su borrador.
 */
export const POSICIONES_PEDIDO_DEFAULT: readonly PosicionPedido[] = ['agotado', 'bajo_minimo'];

export const POSICION_PEDIDO_LABEL: Record<PosicionPedido, string> = {
  agotado: 'Agotado',
  bajo_minimo: 'Bajo mínimo',
  bajo_reorden: 'Bajo reorden',
  otros: 'Sobre reorden, con venta',
};

/** La casilla a la que pertenece una posición del motor (`bucket`). */
export function posicionPedido(bucket: string): PosicionPedido {
  return bucket === 'agotado' || bucket === 'bajo_minimo' || bucket === 'bajo_reorden' ? bucket : 'otros';
}

/** Limpia una selección que viene de fuera: sólo valores conocidos, sin repetir, en su orden. */
export function normalizarPosiciones(v: unknown): PosicionPedido[] {
  const dadas = Array.isArray(v) ? v.map(String) : [];
  return POSICIONES_PEDIDO.filter((p) => dadas.includes(p));
}

/** `PUT /commercial/autoabasto/pedido/posiciones` — qué posiciones entran al pedido. */
export interface AutoabastoPosicionesRequest { warehouse_id: string; posiciones: PosicionPedido[] }

// ── [AB.18] Ajustes del almacenista ──────────────────────────────────────────────────────────

/** Por qué se movió el sugerido. Lista cerrada: un texto libre no se puede aprender. */
export const MOTIVOS_AJUSTE = [
  'espacio_bodega', 'promocion_proxima', 'cliente_aparto', 'producto_lento', 'caducidad', 'exhibicion', 'otro',
] as const;
export type MotivoAjuste = typeof MOTIVOS_AJUSTE[number];

export const MOTIVO_AJUSTE_LABEL: Record<MotivoAjuste, string> = {
  espacio_bodega: 'Espacio en bodega',
  promocion_proxima: 'Viene promoción',
  cliente_aparto: 'Cliente apartó',
  producto_lento: 'Producto lento',
  caducidad: 'Caducidad',
  exhibicion: 'Exhibición',
  otro: 'Otro',
};

/** Desvío desde el que el ajuste pide motivo (decisión de Francisco, 2026-10-12: ±20%). */
export const UMBRAL_MOTIVO = 0.2;

/**
 * ¿Este ajuste necesita motivo? Sí si se aleja del sugerido más de `UMBRAL_MOTIVO`, o si se pide
 * algo que el sistema no sugirió (sugerido 0). Bajarlo a 0 un sugerido mayor que 0 también lo pide.
 */
export function necesitaMotivo(sugerido: number, cantidad: number): boolean {
  const s = Number(sugerido), c = Number(cantidad);
  if (!Number.isFinite(s) || !Number.isFinite(c)) return true;
  if (s <= 0) return c > 0;
  return Math.abs(c - s) / s > UMBRAL_MOTIVO + 1e-9;
}

/** Un paso del − / +: de uno en uno en la unidad de captura, nunca debajo de 0. */
export function pasoAjuste(cantidad: number, dir: 1 | -1): number {
  const c = Math.max(0, Math.round(Number(cantidad) || 0));
  return Math.max(0, c + dir);
}

/** Lo que guardó la persona sobre un renglón. `null` en la línea = no lo tocó (vale el sugerido). */
export interface AjusteLinea {
  cantidad: number;
  unidad: string | null;
  motivo: MotivoAjuste | null;
  ajustado_por: string | null;
  ajustado_at: string;
}

/**
 * `PUT /commercial/autoabasto/pedido/ajuste`
 *
 * Trae la FOTO de lo que la persona vio (sugerido, unidad, factor, contexto): es exactamente la
 * huella que se quiere guardar, y evita recalcular todo el pedido en cada clic del − / +. El
 * servidor valida los números y exige el motivo; el envío (etapa 2) recalcula del motor.
 */
export interface AutoabastoAjusteRequest {
  warehouse_id: string;
  product_id: string;
  sku: string;
  origen_tipo: 'matriz' | 'proveedor' | 'sin_ruta';
  origen_clave: string | null;
  /** Lo sugerido que vio, en su unidad. */
  sugerido: number;
  unidad: string | null;
  /** Unidades base por `unidad` (`a_pedir.factor`). */
  factor: number;
  /** Lo que deja, en la misma unidad. */
  cantidad: number;
  motivo?: MotivoAjuste | null;
  /** Lo que tenía enfrente (venta 30 d, existencia, ya pedido, negado, regla…). */
  contexto?: Record<string, unknown>;
  /** Cuánto tardó en el renglón, medido por la pantalla. */
  ms_en_renglon?: number | null;
}

/** `POST /commercial/autoabasto/pedido/abrir` — la persona abrió su pedido (huella). */
export interface AutoabastoAbrirRequest { warehouse_id: string; renglones: number }

/** `POST /commercial/autoabasto/pedido/restablecer` — vuelve al sugerido. */
export interface AutoabastoRestablecerRequest { warehouse_id: string; product_id: string; ms_en_renglon?: number | null }

/** `POST /commercial/autoabasto/pedido/aceptar-grupo` — revisó el grupo y lo acepta como está. */
export interface AutoabastoAceptarGrupoRequest {
  warehouse_id: string;
  origen_tipo: 'matriz' | 'proveedor' | 'sin_ruta';
  origen_clave: string | null;
  renglones: number;
}

export interface AutoabastoAjusteResponse {
  pedido_id: string;
  product_id: string;
  ajuste: AjusteLinea | null;
}

// ── La respuesta de `GET /commercial/autoabasto/pedido` ──────────────────────────────────────

/** Un renglón del pedido. Cantidades "_cajas" en la unidad mayor del almacén, como la mesa. */
export interface AutoabastoPedidoLinea {
  product_id: string;
  sku: string;
  nombre: string;
  venta_30d: number | null;
  existencia: number;
  objetivo: number | null;
  /** Lo que el motor dice que falta (objetivo − existencia), antes de restar lo ya pedido. */
  falta: number;
  /** Pedidos abiertos a la matriz de 7 días o menos (se restan). `0` = ninguno. */
  ya_pedido: number;
  /** Pedidos abiertos de más de 7 días: NO se restan, se marcan para reclamarlos o cancelarlos. */
  atorado: number;
  /** Lo que la matriz no surtió en los últimos 30 días (pedido − embarcado). Sólo informa. */
  negado_30d: number;
  /**
   * `[AB.23]` Lo EMBARCADO a esta sucursal (U-D-41) que todavía no se recibe (U-A-50), de
   * `ventana_en_camino_dias` o menos. **Se resta.** Antes no lo veía nadie: al embarcarse el pedido
   * dejaba de contar como «ya pedido» y la existencia no sube hasta la recepción, así que en ese
   * lapso (mediana 1 día, p90 4) el encargado volvía a pedirlo. Medido 2026-10-22: 88 embarques,
   * $1.54 M en camino. `0` = nada en camino.
   */
  en_camino: number;
  /**
   * `[AB.24]` Lo que Compras ya decidió mandarle (traspaso del pedido general, aprobado o por aprobar,
   * de 7 días o menos) y **todavía no está en Kepler**. NO se resta: mientras no exista el pedido de
   * traspaso en Kepler, la matriz no lo surte. Cuando la Suite lo mande a Kepler (Fase KR) aparece
   * como «ya pedido» y se resta solo. En cajas, la unidad en que captura `/compras/pedido`.
   */
  planeado_compras: number;
  /**
   * `[AB.29]` Lo que ESTA sucursal ya pidió a Compras con «Enviar a Compras» (requisición por aprobar,
   * o aprobada de 7 días o menos), en cajas. **NO se resta** (D14: se cuenta el documento de Kepler,
   * nunca la requisición): sólo cambia el estado a «Lo pediste a Compras» para que no se pida dos veces.
   */
  pedido_sucursal: number;
  /** `falta − ya_pedido − en_camino`, sin redondear. */
  falta_neta: number;
  /** La cantidad a capturar, ya redondeada con la regla de §15.2. */
  a_pedir: RedondeoPedido;
  /** `[AB.18]` Lo que la persona dejó. `null` = no lo tocó: el pedido lleva `a_pedir`. */
  ajuste: AjusteLinea | null;
  /** Costo de lo que se pide (cantidad efectiva en base × costo). `null` = no se puede valuar. */
  valor: number | null;
  /** `[AB.18]` Costo por unidad base, para recalcular el valor al ajustar. `null` = no valuable. */
  costo_base: number | null;
  posicion: string;
  /** `[AB.20]` Si el mínimo de $200 en unidad menor aplicó, y cómo. */
  minimo_menor: EstadoMinimoMenor;
  /** `[AB.20]` Lo que valía en unidad menor antes del mínimo (para decir «$120, no llega a $200»). */
  valor_menor: number | null;
  /** `[AB.26]` Qué pasa con el renglón: ya viene, Compras lo planeó, nadie lo ha pedido o está en política. */
  estado: EstadoRenglon;
  /** `[AB.26]` A quién se le pide, según el canal configurado. Es el mismo dato que agrupa «Mi pedido». */
  surte: SurteRenglon;
  /**
   * `[AB.39]` Mínimo, reorden, máximo y entrega: lo que explica la posición. Lo trae `GET /pedido`
   * desde que la mesa y «Mi pedido» son UNA pantalla. Opcional: un servidor anterior no lo manda, y
   * la pantalla lo dice («—») en vez de dibujar ceros.
   */
  diagnostico?: DiagnosticoRenglon;
}

// ── [AB.26] Una sola cuenta del renglón ──────────────────────────────────────────────────────
//
// La mesa de Autoabasto y «Mi pedido» partían del mismo motor y después cada una seguía su camino:
// medido el 2026-10-23 (AB.25), de 8,534 renglones que listaba la mesa, 393 ya venían y se volvían a
// pedir y 3,264 tenían una «Acción» que contradecía a quién se le pide. La cuenta del renglón vive
// AQUÍ, pura, para que el servidor la use en las dos pantallas y la prueba la ejerza sin base de datos.

/** `[AB.26]` A quién se le pide el renglón, según el canal configurado (`replenishment_channel`). */
export interface SurteRenglon {
  /** `matriz` = traspaso desde su matriz · `proveedor` = compra · `sin_ruta` = no hay canal. */
  tipo: 'matriz' | 'proveedor' | 'sin_ruta';
  /** Código del almacén que surte (matriz) o id del proveedor. `null` sin ruta. */
  clave: string | null;
  nombre: string;
}

/**
 * `[AB.26]` El «a quién» del renglón. Sustituye a la «Acción» de la mesa, que elegía origen con el
 * sobrante de TODA la red: una instrucción que la sucursal no puede ejecutar (FASE_AB D3).
 * ⚠️ Sin canal NO es compra: se dice `sin_ruta`, no se rellena con un origen por default (ADR-056).
 */
export function surteDe(via: unknown, origen: unknown, supplierId: unknown, supplierName: unknown): SurteRenglon {
  if (via === 'transfer' && origen) return { tipo: 'matriz', clave: String(origen), nombre: String(origen) };
  if (supplierId) return { tipo: 'proveedor', clave: String(supplierId), nombre: String(supplierName ?? 'Proveedor') };
  return { tipo: 'sin_ruta', clave: null, nombre: 'Sin ruta configurada' };
}

/** `[AB.26]` Qué pasa con el renglón. El orden es el de lectura: primero lo que nadie ha pedido. */
export const ESTADOS_RENGLON = ['sin_pedir', 'lo_pediste', 'compras_lo_planeo', 'ya_viene', 'en_politica'] as const;
export type EstadoRenglon = typeof ESTADOS_RENGLON[number];

export const ESTADO_RENGLON_LABEL: Record<EstadoRenglon, string> = {
  // [AB.35] No «Nadie lo ha pedido»: con cobertura parcial (20 de 32 en camino) eso afirmaba algo falso.
  sin_pedir: 'Falta por pedir',
  // [AB.29] La sucursal ya lo mandó a Compras y la requisición sigue viva (por aprobar o recién aprobada).
  lo_pediste: 'Lo pediste a Compras',
  compras_lo_planeo: 'Compras lo planeó',
  ya_viene: 'Ya viene',
  en_politica: 'En política',
};

/**
 * `[AB.26]` El estado sale de las cantidades, no de un juicio:
 *  · sin falta → `en_politica`;
 *  · lo que ya viene (pedido abierto + embarque sin recibir) cubre la falta → `ya_viene`;
 *  · queda falta y la sucursal ya la mandó a Compras → `lo_pediste` (AB.29; tampoco se resta, D14);
 *  · queda falta y Compras la planeó → `compras_lo_planeo` (el plan NO se resta: AB.24 / §16.8);
 *  · queda falta y nadie la pidió → `sin_pedir`. Es el porqué que AB.3b dejó abierto.
 * ⚠️ `ya_viene` gana sobre el plan: sin el folio de Kepler (AB.30) un plan ya capturado aparece también
 * como pedido abierto, y contarlo dos veces diría que hay más en camino de lo que hay.
 * `lo_pediste` gana sobre el plan de Compras: es lo que la sucursal hizo, y es lo que le impide volver
 * a mandarlo (`esEnviable`).
 */
export function estadoRenglon(faltaBase: number, netaBase: number, planeadoCajas: number, pedidoSucursalCajas = 0): EstadoRenglon {
  if (!(faltaBase > 0)) return 'en_politica';
  if (!(netaBase > 0)) return 'ya_viene';
  if (pedidoSucursalCajas > 0) return 'lo_pediste';
  if (planeadoCajas > 0) return 'compras_lo_planeo';
  return 'sin_pedir';
}

/** `[AB.26]` Lo que ya viene de un producto, en la unidad BASE del almacén. */
export interface VieneBase {
  /** Pedidos abiertos a la matriz de la ventana corta (se restan). */
  ya: number;
  /** Pedidos abiertos más viejos (se muestran, no se restan). */
  atorado: number;
  /** Pedido − embarcado del periodo (sólo informa). */
  negado: number;
  /** Embarcado sin recibir de la ventana corta (se resta). */
  camino: number;
}

/** `[AB.26]` Lo que el servidor sabe de un renglón antes de hacer la cuenta. */
export interface EntradaRenglon {
  product_id: string;
  sku: string;
  nombre: string;
  venta_30d: number | null;
  existencia: number;
  objetivo: number | null;
  /** Lo que el motor dice que falta, en cajas (la columna «Falta» de la mesa). */
  falta: number;
  /** Lo mismo en la unidad base del almacén (`suggested_qty_nat` del motor). */
  falta_base: number;
  /** Unidades base por caja en este almacén. Lo que llegue menor que 1 se toma como 1. */
  caja_factor: number;
  /** Costo por unidad base. `null` = sin costo. */
  costo_base: number | null;
  /** Veredicto del peldaño (U.2). Cualquier valor = el $ está retenido. */
  rung_veredicto: string | null;
  posicion: string;
  /** `null` = no hay nada que venga (o no se pudo medir: eso lo declara la respuesta, no el renglón). */
  viene: VieneBase | null;
  /** Lo planeado por Compras para este almacén, en cajas. */
  planeado_compras: number;
  /** `[AB.29]` Lo que esta sucursal ya pidió a Compras (requisición viva), en cajas. No se resta. */
  pedido_sucursal: number;
  escalera: EscaleraUnidades | null;
  /** Lo que la persona dejó guardado, con su cantidad en base. */
  ajuste: (AjusteLinea & { cantidad_base: number }) | null;
  surte: SurteRenglon;
}

export interface RenglonArmado {
  linea: AutoabastoPedidoLinea;
  /** Lo que de verdad lleva el pedido, en base: el ajuste si existe; si no, lo sugerido redondeado. */
  efectivo_base: number;
  /** Lo mismo en la unidad de captura. */
  efectivo_cantidad: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[AB.26]` LA cuenta del renglón. Antes vivía dentro del bucle de `AutoabastoPedidoService.pedido()`;
 * se movió tal cual (mismo orden de restas, mismo redondeo) para que la mesa la use sin copiarla.
 *
 *   falta neta = falta − ya pedido − en camino      (en base; lo atorado, lo negado y el plan NO se restan)
 *   a pedir    = redondeo §15.2 de la falta neta, con el mínimo de $200 en unidad menor (AB.20)
 *   lleva      = el ajuste guardado si lo hay; si no, a pedir
 */
export function armarRenglon(e: EntradaRenglon): RenglonArmado {
  const cf = Math.max(1, Number(e.caja_factor) || 0);
  const yaBase = e.viene?.ya ?? 0;
  const caminoBase = e.viene?.camino ?? 0;
  const netaBase = Math.max(0, e.falta_base - yaBase - caminoBase);
  // Se valúa sólo si el peldaño no está contradicho (U.2) y hay costo.
  const valuable = e.rung_veredicto == null && e.costo_base != null;
  const minimo = aplicarMinimoMenor(redondearPedido(netaBase, e.escalera), valuable ? e.costo_base : null, e.posicion);
  const aPedir = minimo.redondeo;
  const g = e.ajuste;
  const efectivoBase = g ? g.cantidad_base : aPedir.cantidad_base;
  const efectivoCant = g ? g.cantidad : aPedir.cantidad;
  const ajuste: AjusteLinea | null = g
    ? { cantidad: g.cantidad, unidad: g.unidad, motivo: g.motivo, ajustado_por: g.ajustado_por, ajustado_at: g.ajustado_at }
    : null;
  return {
    linea: {
      product_id: e.product_id,
      sku: e.sku,
      nombre: e.nombre,
      venta_30d: e.venta_30d,
      existencia: e.existencia,
      objetivo: e.objetivo,
      falta: e.falta,
      ya_pedido: r1(yaBase / cf),
      atorado: r1((e.viene?.atorado ?? 0) / cf),
      negado_30d: r1((e.viene?.negado ?? 0) / cf),
      en_camino: r1(caminoBase / cf),
      planeado_compras: r1(e.planeado_compras),
      pedido_sucursal: r1(e.pedido_sucursal),
      falta_neta: r1(netaBase / cf),
      a_pedir: aPedir,
      ajuste,
      valor: valuable && efectivoBase > 0 ? r2(efectivoBase * (e.costo_base as number)) : null,
      costo_base: valuable ? e.costo_base : null,
      posicion: e.posicion,
      minimo_menor: minimo.estado,
      valor_menor: minimo.valor_menor,
      estado: estadoRenglon(e.falta_base, netaBase, e.planeado_compras, e.pedido_sucursal),
      surte: e.surte,
    },
    efectivo_base: efectivoBase,
    efectivo_cantidad: efectivoCant,
  };
}

export interface AutoabastoPedidoGrupo {
  /** `matriz` = traspaso desde otra sucursal · `proveedor` = compra directa · `sin_ruta`. */
  tipo: 'matriz' | 'proveedor' | 'sin_ruta';
  /** Código del almacén origen (traspaso) o id del proveedor (compra). */
  clave: string | null;
  nombre: string;
  lineas: AutoabastoPedidoLinea[];
  /** Renglones con algo que pedir después de redondear. */
  renglones_a_pedir: number;
  /**
   * Suma de lo que se pide, en cajas: las cajas completas más la fracción de caja de lo que se
   * pide en piezas o paquetes. NO incluye los renglones sin caja (`renglones_sin_caja`): sumar sus
   * piezas como cajas inflaba el total (medido: 3 churros por pieza daban «2,837 cajas»).
   */
  total_cajas: number;
  /** Renglones que se piden en una unidad sin caja (sólo base, granel o sin escalera). */
  renglones_sin_caja: number;
  /** Suma valuada; `null` si ningún renglón se pudo valuar. */
  total_valor: number | null;
  /** Renglones que no entran en `total_valor` por no poder valuarse. */
  sin_valuar: number;
  /** Pedido mínimo del proveedor en cajas (sólo compras). */
  minimo_cajas: number | null;
  /** Pedido mínimo del proveedor en pesos (sólo compras). */
  minimo_valor: number | null;
}

/**
 * `[AB.23]` Un documento de lo que le va a llegar a la sucursal: un pedido de traspaso abierto
 * (U-D-40: autorizado, surtido o checado) o un embarque todavía sin recibir (U-D-41).
 */
export interface AutoabastoVieneDoc {
  /**
   * `plan` = traspaso que decidió Compras y todavía no está en Kepler (`[AB.24]`): nunca se resta.
   * `requisicion` = `[AB.29]` lo que ESTA sucursal mandó a Compras con «Enviar a Compras»: nunca se resta.
   */
  tipo: 'pedido' | 'embarque' | 'plan' | 'requisicion';
  /** Código de la sucursal que manda. La pantalla la NOMBRA. En una requisición a proveedor, `''`. */
  origen: string;
  /** `[AB.29]` En una requisición a proveedor, a quién se le compra. `null` en los demás. */
  proveedor?: string | null;
  serie: number;
  folio: string;
  /**
   * `AUTORIZADO` · `SURTIDO` · `CHECADO` (pedido) · `EMBARCADO` (embarque sin recibir) · `PLANEADO` (plan).
   * `[AB.29]` Requisición: `POR APROBAR` · `APROBADA` · `RECHAZADA`.
   */
  estado: string;
  /** `[AB.32]` Por qué Compras rechazó la requisición. Sólo en `RECHAZADA`. */
  motivo?: string | null;
  fecha: string;
  dias: number;
  renglones: number;
  /** Importe del documento en Kepler. `null` = sin importe capturado. */
  monto: number | null;
  /** ¿Se resta del pedido? Lo de más días que su ventana se muestra para reclamarlo, no se resta. */
  se_resta: boolean;
}

// ── [AB.29] «Enviar a Compras»: la requisición que genera la sucursal ──────────────────────────

/**
 * `[AB.29]` ¿Este renglón se puede mandar a Compras? La MISMA regla en la pantalla (qué renglones
 * cuenta el botón) y en el servidor (qué renglones acepta). Sólo lo que de verdad falta por pedir:
 * no lo que ya viene, ni lo que la sucursal ya pidió, ni lo que Compras ya planeó; con a quién
 * pedírselo (sin ruta no hay a quién) y con una cantidad que llevar.
 */
export function esEnviable(l: Pick<AutoabastoPedidoLinea, 'estado' | 'surte' | 'ajuste' | 'a_pedir'>): boolean {
  return motivoNoEnviable(l) === null;
}

/**
 * `[AB.29]` El renglón ya se mandó a Compras: sigue a la vista con su estado, pero NO suma como «a
 * pedir» en la sucursal (ni en los grupos de «Mi pedido», ni en el resumen de la mesa, ni en el PDF
 * para Kepler). Si sumara, la sucursal lo pediría dos veces: en la requisición y capturado en Kepler.
 */
export function yaSeMandoACompras(l: Pick<AutoabastoPedidoLinea, 'estado'>): boolean {
  return l.estado === 'lo_pediste';
}

/** `[AB.29]` Por qué un renglón NO se manda a Compras, en palabras de la sucursal. `null` = sí se manda. */
export function motivoNoEnviable(l: Pick<AutoabastoPedidoLinea, 'estado' | 'surte' | 'ajuste' | 'a_pedir'>): string | null {
  if (l.estado === 'lo_pediste') return 'Ya lo pediste a Compras';
  if (l.estado === 'compras_lo_planeo') return 'Compras ya lo planeó';
  if (l.estado === 'ya_viene') return 'Ya viene lo que falta';
  if (l.estado === 'en_politica') return 'No le falta';
  if (l.surte.tipo === 'sin_ruta') return 'No tiene a quién pedírselo (sin ruta configurada)';
  const cantidad = l.ajuste ? l.ajuste.cantidad : l.a_pedir.cantidad;
  if (!(cantidad > 0)) return 'La cantidad a pedir es 0';
  return null;
}

/** `[AB.29]` Lo que manda la pantalla: QUÉ renglones. Las cantidades y a quién se le pide los pone el servidor. */
export interface AutoabastoEnviarRequest {
  warehouse_id: string;
  product_ids: string[];
  /** Nota para Compras (opcional). */
  nota?: string | null;
}

/** `[AB.29]` Una requisición creada: una por origen (su matriz, o cada proveedor). */
export interface AutoabastoRequisicionCreada {
  id: string;
  folio: string;
  surte: SurteRenglon;
  renglones: number;
  /** Suma en cajas de la mesa. */
  total_cajas: number;
}

export interface AutoabastoEnviarResponse {
  requisiciones: AutoabastoRequisicionCreada[];
  /** Lo que se pidió y NO se mandó, con el porqué (ya no falta, ya lo pediste, sin ruta…). */
  omitidos: Array<{ product_id: string; motivo: string }>;
  /** A quién le llega: los nombres de quien tiene la responsabilidad. Vacío = nadie la tiene repartida. */
  le_llega_a: string[];
}

export interface AutoabastoViene {
  documentos: AutoabastoVieneDoc[];
  /** Renglones de esos documentos en una unidad que la escalera del producto no conoce: no se suman. */
  renglones_sin_unidad: number;
}

export interface AutoabastoPedidoResponse {
  almacen: { id: string; code: string; name: string };
  /** AAAA-MM-DD y HH:mm en hora de México, del servidor. */
  fecha_mx: string;
  hora_mx: string;
  /** Días de cobertura del objetivo (igual que /compras/pedido). */
  cobertura_dias: number;
  /** Ventana de «ya pedido»: abiertos de esta antigüedad o menos se restan. */
  ventana_ya_pedido_dias: number;
  ventana_negado_dias: number;
  /** `[AB.23]` Ventana de «en camino»: embarques sin recibir de esta antigüedad o menos se restan. */
  ventana_en_camino_dias: number;
  /** `[AB.23]` Lo que le va a llegar. `null` = no se midió (la sucursal no tiene cliente de traspaso). */
  viene: AutoabastoViene | null;
  grupos: AutoabastoPedidoGrupo[];
  /** `false` = el almacén no es una sucursal de Kepler con cliente de traspaso (`TI`): ya pedido,
   *  atorado y negado NO se midieron (no es lo mismo que «cero»). */
  pedidos_medidos: boolean;
  /** `[AB.18]` El borrador guardado de este almacén. `null` = nadie ha ajustado nada todavía. */
  pedido_id: string | null;
  /** `[AB.18]` La persona puede ajustar (tiene AUTOABASTO_SOLICITAR). */
  puede_ajustar: boolean;
  /**
   * `[AB.18]` Se puede guardar el borrador: las tablas existen Y la conexión escribe. `false` = falta
   * la migración o la base es de sólo lectura (p. ej. probar en local contra prod): la pantalla lo
   * declara arriba en vez de dejar que cada ajuste falle sin explicación.
   */
  guardado_disponible: boolean;
  /** `[AB.19]` Qué posiciones entran al pedido: lo guardado en el borrador, o el default. */
  posiciones: PosicionPedido[];
}
