import { computed, signal } from '@angular/core';
import { ErpOrderMatch, ReceivingLine, ReceivingSession } from '../receiving-session.service';

/**
 * Fase WMS-REC — Andén de Entrada. Estado puro, sin red.
 *
 * Con el folio aparece el vale y sus renglones, y lo único que se captura es
 * lote + caducidad + cuántas piezas llegaron. Ahí entra la mercancía a existencia.
 *
 * `[WMS-REC.21]` Hasta el 2026-10-07 había una segunda sección, *Ubicación*, con la
 * cola de lotes por acomodar. Acomodar se hace ahora en Ubicaciones («Por acomodar»),
 * por almacén y no por vale. Acá se queda `AndenLote` porque es lo que entiende el
 * panel de ubicación (`app-anden-ubicacion`), que se conserva para reusarlo.
 *
 * **Fechar es contar.** No hay un paso de cotejo aparte: la cantidad que se
 * declara al fechar es la que se recibió, y se escribe en `received_qty` cuando
 * el renglón queda cerrado. Así el cierre del vale sigue viendo faltantes y
 * sobrantes contra Kepler, y los reclamos de WMS-REC.8 conservan su insumo.
 *
 * El vale abierto **no vive en la ruta**: es estado de pantalla. Meterlo en la
 * URL rompe el flujo con el back del navegador.
 */

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
 * Un lote esperando lugar. **Es la unidad de la cola de Por acomodar**, y sale del
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

  // ── Renglones ──
  readonly lineas = signal<AndenLinea[]>([]);
  /** Renglón abierto para fechar. */
  readonly actual = signal<AndenLinea | null>(null);

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

  /**
   * Quién manda y qué documento respalda el vale, en una línea.
   *
   * Lee primero lo que se eligió en el menú (`erp`) y, si el vale se RETOMÓ desde «En
   * curso» o desde el borrador, la ficha que trae el propio vale (`vale().erp`) y su
   * origen. Sin eso, un traspaso retomado se leía sólo por su código `TI###` — o vacío.
   */
  readonly proveedor = computed(() => {
    const e = this.erp();
    const v = this.vale();
    if (!v) return 'Esperando camión';
    const ficha = v.erp ?? null;
    const quien = e?.proveedor_nombre || ficha?.proveedor_nombre || v.origin?.name || v.supplier_code;
    const folio = e?.folio || ficha?.folio || null;
    const esEmbarque = (e?.fuente ?? ficha?.fuente) === 'embarque';
    const documento = folio ? (esEmbarque ? `Embarque ${folio}` : `Kepler ${folio}`) : null;
    const partes = [quien, documento, v.warehouse_name || v.warehouse_code].filter(Boolean);
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

  /** Piezas declaradas con fecha en todo el vale — lo que de verdad entró. */
  readonly unidades = computed(() => this.lineas().reduce((a, l) => a + l.declarado, 0));

  /** Renglones cuya cantidad declarada no coincide con lo que mandó Kepler. */
  readonly diferencias = computed(
    () => this.lineas().filter(
      (l) => l.discrepancy_kind !== 'pending' && num(l.received_qty) !== num(l.expected_qty),
    ).length,
  );

  readonly siguienteFechar = computed(() => this.pendientesFechar()[0] ?? null);

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

  parchear(lineId: string, patch: Partial<AndenLinea>): void {
    this.lineas.update((ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
  }

  aBorrador(): AndenBorrador | null {
    const v = this.vale();
    if (!v) return null;
    return { sessionId: v.id, guardadoEn: Date.now() };
  }

  reset(): void {
    this.folio.set('');
    this.candidatos.set([]);
    this.vale.set(null);
    this.erp.set(null);
    this.lineas.set([]);
    this.actual.set(null);
    this.guardado.set(false);
  }
}
