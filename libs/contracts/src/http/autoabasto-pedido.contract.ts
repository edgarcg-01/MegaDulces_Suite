/**
 * `[AB.16]` Fase AB — **«Mi pedido»**: el pedido de la semana de una sucursal, ya agrupado por a
 * quién se le pide (su matriz o el proveedor directo), con lo ya pedido, lo atorado, lo negado y
 * la cantidad redondeada a como se captura en Kepler.
 *
 * Este archivo trae la FORMA de la respuesta (ADR-052) y la **regla de redondeo** como función
 * pura: la calcula el servidor y la prueba su candado, en un solo lugar (FASE_AB §15.2). La
 * pantalla sólo la pinta; si la recalculara, el pedido impreso y el de la tabla podrían no cuadrar.
 */

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

export const POSICIONES_PEDIDO_DEFAULT: readonly PosicionPedido[] = ['agotado', 'bajo_minimo', 'bajo_reorden'];

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
  /** `falta − ya_pedido`, sin redondear. */
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
