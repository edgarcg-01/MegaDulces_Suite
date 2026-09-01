import { computed, signal } from '@angular/core';
import { ErpOrderMatch, ReceivingLine, ReceivingSession } from '../receiving-session.service';

/**
 * Fase WMS-REC — Andén de Entrada. Estado puro, sin red.
 *
 * **Dos puertas con dos relojes, y la segunda se parte en dos trabajos paralelos.**
 *
 *  - **Llegada** corre contra el chofer: identificar el vale con el folio del
 *    papel, contar contra lo que mandó Kepler, dar acceso. La mercancía entra sin
 *    fecha en lote `NA` y el camión se va. Todo lo lento queda afuera.
 *  - **Caducidad** y **Ubicación** corren contra el anaquel, y **NO son un paso
 *    encadenado**: son dos colas hermanas que pueden trabajar dos personas
 *    distintas en momentos distintos. Por eso son secciones, no pasos.
 *
 * El segmento activo **no vive en la ruta**: es estado de pantalla. El vale es el
 * contexto y se conserva al saltar; meterlo en la URL rompe el flujo con el back
 * del navegador.
 */

export type Seccion = 'llegada' | 'caducidad' | 'ubicacion';

/** Renglón enriquecido con lo que la pantalla deriva. */
export interface AndenLinea extends ReceivingLine {
  /** Piezas por unidad del código escaneado (24 = caja de 24). `null` = sin dato. */
  uxc: number | null;
  /** Piezas cotejadas en Llegada. `undefined` = todavía no se contó. */
  contado: number | undefined;
  /** Piezas ya declaradas con lote+caducidad. Derivado, nunca denormalizado. */
  declarado: number;
  /** Retenidas por un 🔴 sin autorizar: no entraron a stock. */
  retenido: number;
  /** Falta fechar: contado − declarado − retenido. */
  faltaFechar: number;
  /** Se acomodó en un rack durante esta sesión de pantalla. */
  ubicado: string | null;
  /** Rack sugerido por `pick-suggestion` — donde ya vive este SKU. */
  binSugerido: string | null;
}

/** Lo que se persiste como borrador. Sólo lo que no se puede re-derivar del server. */
export interface AndenBorrador {
  sessionId: string;
  seccion: Seccion;
  acceso: boolean;
  /** lineId → piezas contadas, para no perder el cotejo si muere la app. */
  contado: Record<string, number>;
  /** lineId → rack, para no re-escanear lo ya acomodado. */
  ubicado: Record<string, string>;
  /** Escaneos ya enviados, por `scan_uuid`: reenviar al recuperar no duplica. */
  scans: string[];
  guardadoEn: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export class AndenState {
  // ── Identificación del vale ──
  readonly folio = signal('');
  readonly buscando = signal(false);
  readonly candidatos = signal<ErpOrderMatch[]>([]);
  readonly vale = signal<ReceivingSession | null>(null);
  readonly erp = signal<ErpOrderMatch | null>(null);

  // ── Navegación entre secciones (NO va en la ruta) ──
  readonly seccion = signal<Seccion>('llegada');
  readonly acceso = signal(false);

  // ── Renglones ──
  readonly lineas = signal<AndenLinea[]>([]);
  /** Renglón abierto en Llegada para capturar cantidad. */
  readonly capturando = signal<AndenLinea | null>(null);
  /** Renglón abierto en Caducidad o Ubicación. */
  readonly actual = signal<AndenLinea | null>(null);

  readonly cargando = signal(false);
  readonly guardando = signal(false);
  /** El borrador está a salvo: el bodeguero puede cerrar la app. */
  readonly guardado = signal(false);

  // ── Derivados ──

  readonly abierto = computed(() => this.vale() !== null);

  /** El almacén SIEMPRE se hereda del vale. Si algo lo vuelve a pedir, se rompió el flujo. */
  readonly warehouseId = computed(() => this.vale()?.warehouse_id ?? null);

  readonly proveedor = computed(() => {
    const e = this.erp();
    const v = this.vale();
    if (!v) return 'Esperando camión';
    const partes = [e?.proveedor_nombre || v.supplier_code, e?.folio ? `Kepler ${e.folio}` : null,
      v.warehouse_name || v.warehouse_code].filter(Boolean);
    return partes.join(' · ');
  });

  readonly estado = computed(() => (!this.abierto() ? 'sin identificar' : this.acceso() ? 'con_acceso' : 'abierto'));

  /** Contadas ya en Llegada. */
  readonly contadas = computed(() => this.lineas().filter((l) => l.contado !== undefined).length);
  readonly porCotejar = computed(() => this.lineas().length - this.contadas());
  readonly cotejoListo = computed(() => this.lineas().length > 0 && this.porCotejar() === 0);

  /** Piezas cotejadas en total — lo que entra en lote `NA` al dar acceso. */
  readonly unidades = computed(() => this.lineas().reduce((a, l) => a + num(l.contado), 0));

  /** Renglones cuyo conteo no coincide con lo que mandó Kepler. */
  readonly diferencias = computed(
    () => this.lineas().filter((l) => l.contado !== undefined && l.contado !== num(l.expected_qty)).length,
  );

  /** Cola de Caducidad: contado pero sin fechar. */
  readonly pendientesFechar = computed(
    () => this.lineas().filter((l) => l.contado !== undefined && l.faltaFechar > 0),
  );
  /** Cola de Ubicación: contado pero sin rack. */
  readonly pendientesUbicar = computed(
    () => this.lineas().filter((l) => l.contado !== undefined && !l.ubicado),
  );

  readonly siguienteCotejar = computed(() => this.lineas().find((l) => l.contado === undefined) ?? null);
  readonly siguienteFechar = computed(() => this.pendientesFechar()[0] ?? null);
  readonly siguienteUbicar = computed(() => this.pendientesUbicar()[0] ?? null);

  // ── Mutaciones ──

  /**
   * Vuelca el detalle del vale a renglones de pantalla. `faltaFechar` se DERIVA
   * (contado − declarado − retenido): un contador denormalizado se desfasa en
   * cuanto un supervisor autoriza un rojo.
   *
   * Conserva lo que sólo vive en la pantalla (uxc resuelto, rack sugerido, y lo
   * ya acomodado) para no perderlo en cada recarga del detalle.
   */
  cargarDesdeVale(s: ReceivingSession): void {
    this.vale.set(s);
    if (s.status === 'closed') this.acceso.set(true);
    const previas = new Map(this.lineas().map((l) => [l.id, l]));
    this.lineas.set(
      (s.lines ?? []).map((l) => {
        const prev = previas.get(l.id);
        const recibido = num(l.received_qty);
        const declarado = num(l.declared_qty);
        const retenido = num(l.held_qty);
        // Antes del acceso, `received_qty` sólo es "contado" si alguien lo tocó:
        // el backend arranca las líneas en `pending` con received 0.
        const contado = l.discrepancy_kind !== 'pending' ? recibido : prev?.contado;
        return {
          ...l,
          uxc: prev?.uxc ?? null,
          contado,
          declarado,
          retenido,
          faltaFechar: Math.max(0, num(contado) - declarado - retenido),
          ubicado: prev?.ubicado ?? null,
          binSugerido: prev?.binSugerido ?? null,
        };
      }),
    );
  }

  parchear(lineId: string, patch: Partial<AndenLinea>): void {
    this.lineas.update((ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
  }

  /** Aplica un borrador recuperado sobre los renglones ya cargados del server. */
  aplicarBorrador(b: AndenBorrador): void {
    this.seccion.set(b.seccion);
    this.acceso.set(b.acceso);
    this.lineas.update((ls) =>
      ls.map((l) => {
        const contado = b.contado[l.id] ?? l.contado;
        return {
          ...l,
          contado,
          faltaFechar: Math.max(0, num(contado) - l.declarado - l.retenido),
          ubicado: b.ubicado[l.id] ?? l.ubicado,
        };
      }),
    );
  }

  aBorrador(scans: string[]): AndenBorrador | null {
    const v = this.vale();
    if (!v) return null;
    const contado: Record<string, number> = {};
    const ubicado: Record<string, string> = {};
    for (const l of this.lineas()) {
      if (l.contado !== undefined) contado[l.id] = l.contado;
      if (l.ubicado) ubicado[l.id] = l.ubicado;
    }
    return { sessionId: v.id, seccion: this.seccion(), acceso: this.acceso(), contado, ubicado, scans, guardadoEn: Date.now() };
  }

  reset(): void {
    this.folio.set('');
    this.candidatos.set([]);
    this.vale.set(null);
    this.erp.set(null);
    this.lineas.set([]);
    this.capturando.set(null);
    this.actual.set(null);
    this.seccion.set('llegada');
    this.acceso.set(false);
    this.guardado.set(false);
  }
}
