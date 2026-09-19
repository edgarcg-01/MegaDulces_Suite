import { computed, signal } from '@angular/core';
import { ErpOrderMatch, ReceivingLine, ReceivingSession } from '../receiving-session.service';
import { UnlocatedLot } from '../bin-location.service';

/**
 * Fase WMS-REC — Andén de Entrada. Estado puro, sin red.
 *
 * **Dos secciones, en este orden: Fechas → Ubicación.**
 *
 *  - **Fechas** es la puerta: con el folio aparece el vale y sus renglones, y lo
 *    único que se captura es lote + caducidad + cuántas piezas llegaron. Ahí
 *    entra la mercancía a existencia.
 *  - **Ubicación** es lo que sigue: a cada lote ya fechado se le da su rack o su
 *    tarima. Va después porque **se ubica un LOTE, no un renglón** — mientras no
 *    haya fecha, lo que hay en existencia es el lote `NA`, y acomodarlo sería
 *    acomodar algo que después se reclasifica.
 *
 * **Fechar es contar.** No hay un paso de cotejo aparte: la cantidad que se
 * declara al fechar es la que se recibió, y se escribe en `received_qty` cuando
 * el renglón queda cerrado. Así el cierre del vale sigue viendo faltantes y
 * sobrantes contra Kepler, y los reclamos de WMS-REC.8 conservan su insumo.
 *
 * La sección activa **no vive en la ruta**: es estado de pantalla. El vale es el
 * contexto y se conserva al saltar; meterlo en la URL rompe el flujo con el back
 * del navegador.
 */

export type Seccion = 'fechas' | 'ubicacion';

/** Renglón enriquecido con lo que la pantalla deriva. */
export interface AndenLinea extends ReceivingLine {
  /** Piezas por unidad del código escaneado (24 = caja de 24). `null` = sin dato. */
  uxc: number | null;
  /** Piezas ya declaradas con lote+caducidad. Derivado, nunca denormalizado. */
  declarado: number;
  /** Retenidas por un 🔴 sin autorizar: no entraron a stock. */
  retenido: number;
  /**
   * Piezas que todavía esperan lote y fecha.
   *
   * Mientras el renglón sigue `pending`, es lo que Kepler manda menos lo ya
   * declarado: eso permite partir un renglón en varios lotes (llegaron 12 con una
   * fecha y 12 con otra). En cuanto el renglón se cierra —porque se declaró todo,
   * o porque el operario dijo que no llegó más— deja de ser cola.
   */
  faltaFechar: number;
  /** Rack sugerido por `pick-suggestion` — donde ya vive este SKU. */
  binSugerido: string | null;
}

/**
 * Un lote esperando rack. **Es la unidad de la cola de Ubicación**, y sale del
 * backend (`/unlocated`), no de la memoria de la pantalla: el put-away exige el
 * lote y la caducidad exactos, y recordarlos en el navegador los desfasa en
 * cuanto otra persona fecha desde otro equipo.
 */
export interface AndenLote {
  product_id: string;
  sku: string | null;
  product_name: string | null;
  lot_code: string;
  expiry_date: string | null;
  /** Piezas de este lote que faltan por acomodar. */
  porUbicar: number;
  /** Rack donde ya vive este SKU, si lo hay. */
  binSugerido: string | null;
}

/** Lo que se persiste como borrador. Sólo lo que no se puede re-derivar del server. */
export interface AndenBorrador {
  sessionId: string;
  seccion: Seccion;
  guardadoEn: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Clave de un lote: producto + lote + caducidad. La caducidad nula es parte de la identidad. */
export function claveLote(l: { product_id: string; lot_code: string; expiry_date: string | null }): string {
  return `${l.product_id}|${l.lot_code}|${l.expiry_date ?? ''}`;
}

export class AndenState {
  // ── Identificación del vale ──
  readonly folio = signal('');
  readonly buscando = signal(false);
  readonly candidatos = signal<ErpOrderMatch[]>([]);
  readonly vale = signal<ReceivingSession | null>(null);
  readonly erp = signal<ErpOrderMatch | null>(null);

  // ── Navegación entre secciones (NO va en la ruta) ──
  readonly seccion = signal<Seccion>('fechas');

  // ── Renglones y lotes ──
  readonly lineas = signal<AndenLinea[]>([]);
  /** Lotes por acomodar, tal como los reporta el backend. */
  readonly lotes = signal<AndenLote[]>([]);
  /** Renglón abierto para fechar. */
  readonly actual = signal<AndenLinea | null>(null);
  /** Lote abierto para ubicar. */
  readonly loteActual = signal<AndenLote | null>(null);

  readonly cargando = signal(false);
  readonly guardando = signal(false);
  /** El borrador está a salvo: el bodeguero puede cerrar la app. */
  readonly guardado = signal(false);

  // ── Derivados ──

  readonly abierto = computed(() => this.vale() !== null);
  readonly cerrado = computed(() => this.vale()?.status === 'closed');

  /** El almacén SIEMPRE se hereda del vale. Si algo lo vuelve a pedir, se rompió el flujo. */
  readonly warehouseId = computed(() => this.vale()?.warehouse_id ?? null);
  readonly almacen = computed(() => {
    const v = this.vale();
    return v ? v.warehouse_code || v.warehouse_name || null : null;
  });

  readonly proveedor = computed(() => {
    const e = this.erp();
    const v = this.vale();
    if (!v) return 'Esperando camión';
    const partes = [e?.proveedor_nombre || v.supplier_code, e?.folio ? `Kepler ${e.folio}` : null,
      v.warehouse_name || v.warehouse_code].filter(Boolean);
    return partes.join(' · ');
  });

  /**
   * De dónde viene la mercancía: **proveedor externo o traspaso interno**.
   *
   * En el andén no es un dato de adorno: si falta media tarima, a un proveedor
   * se le reclama y le pega en su scorecard; a un traspaso se le reclama a la
   * sucursal que embarcó y el faltante es de la casa. El backend lo deriva del
   * código del "proveedor" de Kepler (`TI###` = traspaso, `TI000` = CEDIS) —
   * acá no se vuelve a calcular, para que haya una sola definición.
   */
  readonly origen = computed(() => this.vale()?.origin ?? null);

  readonly estado = computed(() =>
    !this.abierto() ? 'sin identificar' : this.cerrado() ? 'cerrado' : 'en captura',
  );

  /** Cola de Fechas: renglones que todavía esperan lote y caducidad. */
  readonly pendientesFechar = computed(() => this.lineas().filter((l) => l.faltaFechar > 0));
  /** Cola de Ubicación: lotes ya fechados sin rack. */
  readonly pendientesUbicar = computed(() => this.lotes().filter((l) => l.porUbicar > 0));

  /** Piezas declaradas con fecha en todo el vale — lo que de verdad entró. */
  readonly unidades = computed(() => this.lineas().reduce((a, l) => a + l.declarado, 0));

  /** Renglones cuya cantidad declarada no coincide con lo que mandó Kepler. */
  readonly diferencias = computed(
    () => this.lineas().filter(
      (l) => l.discrepancy_kind !== 'pending' && num(l.received_qty) !== num(l.expected_qty),
    ).length,
  );

  readonly siguienteFechar = computed(() => this.pendientesFechar()[0] ?? null);
  readonly siguienteUbicar = computed(() => this.pendientesUbicar()[0] ?? null);

  // ── Mutaciones ──

  /**
   * Vuelca el detalle del vale a renglones de pantalla. `faltaFechar` se DERIVA:
   * un contador denormalizado se desfasa en cuanto un supervisor autoriza un rojo.
   *
   * Un renglón deja de ser cola cuando su `discrepancy_kind` ya no es `pending`,
   * que es la marca de renglón cerrado — y es del SERVER, no de la pantalla, así
   * que sobrevive a cerrar la app o a que lo cierre otra persona.
   *
   * Conserva lo que sólo vive acá (uxc resuelto, rack sugerido) para no perderlo
   * en cada recarga del detalle.
   */
  cargarDesdeVale(s: ReceivingSession): void {
    this.vale.set(s);
    const previas = new Map(this.lineas().map((l) => [l.id, l]));
    this.lineas.set(
      (s.lines ?? []).map((l) => {
        const prev = previas.get(l.id);
        const declarado = num(l.declared_qty);
        const retenido = num(l.held_qty);
        const abiertoAun = l.discrepancy_kind === 'pending';
        return {
          ...l,
          uxc: prev?.uxc ?? null,
          declarado,
          retenido,
          faltaFechar: abiertoAun ? Math.max(0, num(l.expected_qty) - declarado - retenido) : 0,
          binSugerido: prev?.binSugerido ?? null,
        };
      }),
    );
  }

  /**
   * Carga la cola de Ubicación con lo que el backend reporta sin acomodar,
   * **acotado a los productos de este vale**: `/unlocated` contesta por almacén, y
   * sin este filtro el andén arrastraría pendientes de recepciones de otro día que
   * nadie pidió resolver ahora.
   */
  cargarLotes(rows: UnlocatedLot[]): void {
    const delVale = new Set(this.lineas().map((l) => l.product_id).filter((x): x is string => !!x));
    const previos = new Map(this.lotes().map((l) => [claveLote(l), l]));
    this.lotes.set(
      (rows || [])
        .filter((r) => delVale.has(r.product_id))
        .map((r) => {
          const lote: AndenLote = {
            product_id: r.product_id,
            sku: r.sku ?? null,
            product_name: r.product_name ?? null,
            lot_code: r.lot_code,
            expiry_date: r.expiry_date,
            porUbicar: num(r.to_locate),
            binSugerido: null,
          };
          lote.binSugerido = previos.get(claveLote(lote))?.binSugerido ?? null;
          return lote;
        })
        .filter((l) => l.porUbicar > 0)
        .sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '')),
    );
  }

  parchear(lineId: string, patch: Partial<AndenLinea>): void {
    this.lineas.update((ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
  }

  parchearLote(clave: string, patch: Partial<AndenLote>): void {
    this.lotes.update((ls) => ls.map((l) => (claveLote(l) === clave ? { ...l, ...patch } : l)));
  }

  aBorrador(): AndenBorrador | null {
    const v = this.vale();
    if (!v) return null;
    return { sessionId: v.id, seccion: this.seccion(), guardadoEn: Date.now() };
  }

  reset(): void {
    this.folio.set('');
    this.candidatos.set([]);
    this.vale.set(null);
    this.erp.set(null);
    this.lineas.set([]);
    this.lotes.set([]);
    this.actual.set(null);
    this.loteActual.set(null);
    this.seccion.set('fechas');
    this.guardado.set(false);
  }
}
