import { computed, signal } from '@angular/core';
import { ErpOrderMatch, ReceivingLine, ReceivingSession } from '../receiving-session.service';

/**
 * Fase WMS-REC — Andén de Entrada. Estado puro, sin red.
 *
 * **La tesis del rediseño: son DOS PUERTAS con dos relojes distintos.**
 *
 *  - **Puerta 1 · Cotejo y acceso** corre contra el chofer. Se identifica el vale
 *    con el folio del papel, se cuenta contra lo que mandó Kepler y se da acceso.
 *    La mercancía entra sin fecha (lote `NA`) y el camión se va. Todo lo lento
 *    —foto, OCR, corrección de fecha— queda FUERA: el andén ocupado es el recurso
 *    que no se quiere gastar.
 *  - **Puerta 2 · Fechado y acomodo** corre contra el anaquel. Sin prisa, con la
 *    caja en la mano: foto, lote, caducidad, rack.
 *
 * Hoy el sistema mezcla las dos y por eso se acumula mercancía sin fechar y sin
 * ubicar: fechar y ubicar compiten con la siguiente tarima, y pierden siempre.
 *
 * El contador de toques es parte del producto, no telemetría: es la métrica del
 * rediseño (79 → 24 en un vale de 5 líneas) y se muestra en pantalla.
 */

export type Puerta = 'folio' | 'cotejo' | 'fechado';

/** Renglón enriquecido con lo que la pantalla necesita derivar. */
export interface AndenLinea extends ReceivingLine {
  /** Piezas por unidad del código escaneado (24 = caja de 24). `null` = sin dato. */
  uxc: number | null;
  /** Piezas ya declaradas con lote+caducidad. Derivado, nunca denormalizado. */
  declarado: number;
  /** Retenidas por un 🔴 sin autorizar: no entraron a stock. */
  retenido: number;
  /** Lo que falta fechar: recibido − declarado − retenido. */
  faltaFechar: number;
  /** Se completó la puerta 2 (fechado + acomodado) en esta sesión de pantalla. */
  resuelta: boolean;
  /** Se fechó pero el put-away falló: NO está terminada. */
  sinUbicar: boolean;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class AndenState {
  // ── Paso 0: identificar el vale ──
  readonly folio = signal('');
  readonly buscando = signal(false);
  readonly candidatos = signal<ErpOrderMatch[]>([]);
  readonly vale = signal<ReceivingSession | null>(null);
  readonly erp = signal<ErpOrderMatch | null>(null);

  // ── Navegación entre puertas ──
  readonly puerta = signal<Puerta>('folio');

  // ── Renglones ──
  readonly lineas = signal<AndenLinea[]>([]);
  readonly lineaActivaId = signal<string | null>(null);

  // ── Métrica del rediseño ──
  readonly toques = signal(0);
  /** Un toque = una acción del operario. Se cuenta acá y se muestra en pantalla. */
  toque(n = 1): void {
    this.toques.update((t) => t + n);
  }

  readonly cargando = signal(false);
  readonly guardando = signal(false);

  // ── Derivados ──

  /** El almacén SIEMPRE se hereda del vale. Si algo lo vuelve a pedir, se rompió el flujo. */
  readonly warehouseId = computed(() => this.vale()?.warehouse_id ?? null);
  readonly almacenLabel = computed(() => {
    const v = this.vale();
    if (!v) return '';
    return [v.warehouse_code, v.warehouse_name].filter(Boolean).join(' · ');
  });

  readonly proveedor = computed(
    () => this.erp()?.proveedor_nombre || this.vale()?.supplier_code || 'sin proveedor',
  );

  readonly lineaActiva = computed(() => {
    const id = this.lineaActivaId();
    return id ? this.lineas().find((l) => l.id === id) ?? null : null;
  });

  /** Puerta 2: lo que todavía no se fechó ni acomodó. */
  readonly pendientes = computed(() => this.lineas().filter((l) => !l.resuelta && l.faltaFechar > 0));
  readonly resueltas = computed(() => this.lineas().filter((l) => l.resuelta));

  /** Puerta 1: cuánto se contó vs lo que mandó Kepler. */
  readonly cotejo = computed(() => {
    const ls = this.lineas();
    const esperado = ls.reduce((a, l) => a + num(l.expected_qty), 0);
    const recibido = ls.reduce((a, l) => a + num(l.received_qty), 0);
    const contados = ls.filter((l) => l.discrepancy_kind !== 'pending').length;
    return { lineas: ls.length, contados, esperado, recibido, diff: recibido - esperado };
  });

  readonly puedeDarAcceso = computed(() => {
    const c = this.cotejo();
    return c.lineas > 0 && c.contados === c.lineas;
  });

  /** Ya no queda nada por fechar: la puerta 2 terminó. */
  readonly fechadoCompleto = computed(
    () => this.lineas().length > 0 && this.pendientes().length === 0,
  );

  // ── Mutaciones ──

  /**
   * Vuelca el detalle del vale a renglones de pantalla. `faltaFechar` se DERIVA
   * (recibido − declarado − retenido), igual que en el detalle del vale: un
   * contador denormalizado se desfasa en cuanto un supervisor autoriza un rojo.
   */
  cargarDesdeVale(s: ReceivingSession): void {
    this.vale.set(s);
    const previas = new Map(this.lineas().map((l) => [l.id, l]));
    this.lineas.set(
      (s.lines ?? []).map((l) => {
        const recibido = num(l.received_qty);
        const declarado = num(l.declared_qty);
        const retenido = num(l.held_qty);
        const prev = previas.get(l.id);
        const faltaFechar = Math.max(0, recibido - declarado - retenido);
        return {
          ...l,
          uxc: null,
          declarado,
          retenido,
          faltaFechar,
          // Sólo cuenta como resuelta si además quedó ubicada.
          resuelta: faltaFechar === 0 && recibido > 0 && !prev?.sinUbicar,
          sinUbicar: prev?.sinUbicar ?? false,
        };
      }),
    );
  }

  parchear(lineId: string, patch: Partial<AndenLinea>): void {
    this.lineas.update((ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
  }

  /** Salta al siguiente pendiente. Es el acelerador 01: un toque menos por renglón. */
  siguientePendiente(desdeId?: string | null): string | null {
    const pend = this.pendientes();
    if (!pend.length) return null;
    if (!desdeId) return pend[0].id;
    const orden = this.lineas().map((l) => l.id);
    const i = orden.indexOf(desdeId);
    const despues = pend.find((l) => orden.indexOf(l.id) > i);
    return (despues ?? pend[0]).id;
  }

  reset(): void {
    this.folio.set('');
    this.candidatos.set([]);
    this.vale.set(null);
    this.erp.set(null);
    this.lineas.set([]);
    this.lineaActivaId.set(null);
    this.puerta.set('folio');
    this.toques.set(0);
  }
}
