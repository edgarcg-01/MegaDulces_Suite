import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { EstadoSnapshot, ResultadoBusqueda, VerificadorService } from '../verificador.service';
import { TiendaVerificadorComponent } from './tienda-verificador.component';
import { StoreSocketService } from '../store-socket.service';
import type { LabelPricesChanged } from '@megadulces/contracts';
// `[TDA.7]` El mock de IntersectionObserver vive en el setup (jsdom no lo trae) y expone el
// interrogador: poder AFIRMAR que nadie intersectó es lo que hace válida la prueba del $0.00.
import { nadieIntersecto } from '../../../../test-setup';

/**
 * `[CV.24]` — Lo que la PANTALLA dice, no lo que el servicio devuelve.
 *
 * El servicio ya tiene su propia prueba (`verificador.service.spec.ts`). Acá se comprueba lo
 * que ve la persona del mostrador, que es donde el bug se vuelve dinero:
 *
 *  · un precio de respaldo llega ROTULADO como tal (si el rótulo no se pinta, el híbrido es
 *    indistinguible de un precio vigente, que es la mentira que ADR-056 prohíbe);
 *  · "no encontrado" y "sin conexión" son DOS pantallas distintas (DESIGN pre-vuelo 6:
 *    empty != error de red) — mostrar el vacío ante un fallo de red le afirma al mostrador
 *    que el producto no tiene precio, y es falso;
 *  · la frescura que no se pudo medir se DECLARA en vez de desaparecer: la píldora se oculta
 *    sola con `since` en null, y una píldora ausente se lee igual que "todo bien".
 */

const PRODUCTO = {
  codigo: '17083',
  nombre: 'ALTOS CAM CHICA COLOR 1KG CLASICA',
  unidades: [
    { u: 'KG', precio_con_iva: 62.99, precio_sin_iva: 54.3, factor: 1 },
    { u: 'BTO', precio_con_iva: 1159.91, precio_sin_iva: 999.92, factor: 20 },
  ],
  iva_pct: 16,
  ieps_pct: 0,
  // `[TDA.7]` `mayoreo` y `contenido` son obligatorios en `ProductoPrecio` y faltaban: el
  // typecheck con `tsconfig.spec.json` daba TS2739 en 3 lugares. No se veía porque ts-jest corre
  // con `isolatedModules` (transpila sin verificar tipos), así que la suite pasaba en verde sobre
  // una fixture que no cumple el contrato que dice cumplir. Vacío es la afirmación correcta acá:
  // este producto NO tiene mayoreo, y es lo que hace útil el contraste con `CON_MAYOREO`.
  mayoreo: [],
  contenido: null,
  // `[TDA.8]` La llave del aviso en vivo.
  product_id: 'aaaaaaaa-0000-4000-8000-000000000001',
};

/**
 * `[TDA.7]` Un producto CON mayoreo — la fixture que faltaba.
 *
 * Sin ella `@if (mayoreo().length)` era falso en todos los tests, así que la tarjeta de mayoreo,
 * la pastilla del ahorro, el count-up y el reinicio de la animación **no se renderizaban en
 * ninguna prueba**. Todo lo de TDA.6 se "verificó" con regex sobre el archivo fuente.
 *
 * Los números son los del caso real medido en prod: base PZA a $9.37, paquete de 8 a $70.12, y
 * un mayoreo de paquete de $65.11 que es el precio de UN PAQUETE — el que comparado contra la
 * pieza daba un "descuento" de −798 %.
 */
const TIER_BASE = {
  etiqueta: 'pieza', desde: 10, palabra: 'piezas',
  precio_con_iva: 8.71, ahorro_por_unidad: 0.66, ahorro_en_el_minimo: 6.6,
  descuento_pct: 7.1, realza: true, aplica_a: 'base' as const, unidad_monto: 'c/u',
};
const TIER_PAQUETE = {
  etiqueta: 'paquete', desde: 3, palabra: 'paquetes',
  precio_con_iva: 65.11, ahorro_por_unidad: 5.01, ahorro_en_el_minimo: 15.03,
  descuento_pct: 7.1, realza: true, aplica_a: 'paquete' as const, unidad_monto: 'por paquete',
};
const CON_MAYOREO = {
  codigo: '70001',
  nombre: 'PALETA PAYASO 8 PZAS',
  unidades: [
    { u: 'PZA', precio_con_iva: 9.37, precio_sin_iva: 8.08, factor: 1 },
    { u: 'PAQ', precio_con_iva: 70.12, precio_sin_iva: 60.45, factor: 8 },
  ],
  iva_pct: 16, ieps_pct: 0,
  mayoreo: [TIER_BASE, TIER_PAQUETE],
  product_id: 'bbbbbbbb-0000-4000-8000-000000000002',
};

/** Declara `prefers-reduced-motion: reduce` (jsdom no trae `matchMedia`). */
function conMovimientoReducido(): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: /prefers-reduced-motion/.test(q),
    media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

/**
 * `[TDA.8]` Doble del socket de tienda.
 *
 * El componente sólo usa dos cosas: `connect()` y `labelPricesChanged$`. Se stubbean para que el
 * test **maneje el reloj del evento** — sin esto no hay forma de ejercitar el camino, que es
 * justo lo que pasó con TDA.6 (candados de regex sobre un camino que no se renderiza).
 * Y de paso corta socket.io real en jsdom: el servicio de verdad pide `auth.token()` y abre una
 * conexión, que en un test es latencia y ruido.
 */
class SocketStub {
  readonly labelPricesChanged$ = new Subject<LabelPricesChanged>();
  conectado = 0;
  connect(): void { this.conectado++; }
}

class VerificadorStub {
  readonly snapshot = signal<EstadoSnapshot | null>(null);
  proximo: ResultadoBusqueda = { estado: 'sin_datos', codigo: '' };
  sucursalesResp: any[] = [{ codigo: '03', nombre: '8 ESQUINAS', direccion: '', ciudad: '', almacenes: ['03'], datos_al: null }];

  sucursales() { return of(this.sucursalesResp); }
  buscar() { return of(this.proximo); }
  asegurarSnapshot() { return of(this.snapshot()); }
  descargarSnapshot() { return throwError(() => new Error('no en esta prueba')); }
}

describe('TiendaVerificadorComponent · lo que ve el mostrador', () => {
  let fix: ComponentFixture<TiendaVerificadorComponent>;
  let svc: VerificadorStub;
  let sock: SocketStub;

  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    svc = new VerificadorStub();
    sock = new SocketStub();
    await TestBed.configureTestingModule({
      imports: [TiendaVerificadorComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: VerificadorService, useValue: svc },
        { provide: StoreSocketService, useValue: sock },
        // La sucursal sale de la ficha del usuario: con warehouse_code no se ofrece elegir.
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '03', username: 'qa' }) } },
      ],
    }).compileComponents();

    fix = TestBed.createComponent(TiendaVerificadorComponent);
    fix.detectChanges();
  });

  it('arranca en espera, con la sucursal del usuario y sin ofrecer selector', () => {
    // [CV.25-look] Sin tarjeta hasta la primera consulta (fiel al verificador.html original:
    // el ".card" no existía hasta el primer escaneo, no había placeholder de "listo").
    expect(fix.nativeElement.querySelector('.vf-card')).toBeNull();
    expect(fix.nativeElement.querySelector('.vf-err')).toBeNull();
    expect(html()).toContain('8 ESQUINAS');
    expect(fix.nativeElement.querySelector('p-select')).toBeNull();
    expect(fix.nativeElement.querySelector('input.vf-input')).toBeTruthy();
  });

  it('un precio en línea se pinta en grande y se rotula como en línea', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: PRODUCTO };
    fix.componentInstance.consultar('17083');
    fix.detectChanges();

    const t = html();
    expect(t).toContain('ALTOS CAM CHICA COLOR 1KG CLASICA');
    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('62.99');
    expect(t).toContain('Precio en línea');
    expect(t).not.toContain('Precio de respaldo');
    // La segunda unidad se lista con su equivalencia, no se esconde.
    expect(t).toContain('BTO');
    expect(t).toContain('20');
  });

  it('un precio de respaldo llega ROTULADO y con la advertencia arriba', () => {
    svc.proximo = {
      estado: 'encontrado', origen: 'respaldo',
      snapshotAl: '2026-09-08T12:00:00.000Z',
      producto: { ...PRODUCTO, iva_pct: null, ieps_pct: null },
    };
    fix.componentInstance.consultar('17083');
    fix.detectChanges();

    const t = html();
    expect(t).toContain('Precio de respaldo');
    expect(t).toContain('Confirma en caja antes de cobrar');
    expect(fix.nativeElement.querySelector('.vf-card.is-respaldo')).toBeTruthy();
  });

  it('distingue "no encontrado" de "sin conexión" — son dos pantallas', () => {
    svc.proximo = { estado: 'no_encontrado', origen: 'live', codigo: '99999', snapshotAl: null };
    fix.componentInstance.consultar('99999');
    fix.detectChanges();
    // [CV.25-look] Copy calcado del verificador.html original para "no está en el catálogo".
    expect(html()).toContain('DISCULPE LAS MOLESTIAS');
    expect(html()).toContain('PRODUCTO NO ENCONTRADO');
    expect(fix.nativeElement.querySelector('.vf-err.is-bad')).toBeNull();
    expect(html()).not.toContain('SIN CONEXIÓN AL SERVIDOR');

    svc.proximo = { estado: 'sin_datos', codigo: '99999' };
    fix.componentInstance.consultar('99999');
    fix.detectChanges();
    // El estado grave de verdad (sin red, sin respaldo) usa el tratamiento .is-bad y su
    // propio copy — nunca el mismo texto que "no está en el catálogo".
    expect(html()).toContain('SIN CONEXIÓN AL SERVIDOR');
    expect(fix.nativeElement.querySelector('.vf-err.is-bad')).toBeTruthy();
    expect(html()).not.toContain('DISCULPE LAS MOLESTIAS');
  });

  it('declara la frescura que no pudo medir, en vez de ocultar la píldora', () => {
    // datos_al = null es el estado REAL hoy: analytics.cron_runs no tiene filas cdc_wal_NN.
    expect(html()).toContain('Frescura del ERP sin medir');
    expect(fix.nativeElement.querySelector('app-freshness-pill')).toBeNull();
  });

  it('con frescura del servidor sí muestra la píldora y no el aviso', async () => {
    svc.sucursalesResp = [{ codigo: '03', nombre: '8 ESQUINAS', direccion: '', ciudad: '', almacenes: ['03'], datos_al: new Date().toISOString() }];
    const f2 = TestBed.createComponent(TiendaVerificadorComponent);
    f2.detectChanges();
    const t = (f2.nativeElement as HTMLElement).textContent ?? '';
    expect(t).not.toContain('Frescura del ERP sin medir');
    expect(f2.nativeElement.querySelector('app-freshness-pill')).toBeTruthy();
  });

  it('avisa cuando no hay respaldo local: sin red la pantalla no podría contestar', () => {
    expect(html()).toContain('Sin respaldo local');
    svc.snapshot.set({ sucursal: '03', total: 9479, generado: '2026-09-08T12:00:00.000Z', descargadoAl: '2026-09-08T12:05:00.000Z' });
    fix.componentInstance.snapshot.set(svc.snapshot());
    fix.detectChanges();
    expect(html()).toContain('9479');
  });

  // ── `[TDA.7]` El mayoreo, ejecutándose de verdad ──────────────────────────────────────────
  // Todo lo de abajo renderiza el bloque que hasta ahora ningún test tocaba.

  /**
   * LA REGRESIÓN DEL `$0.00`.
   *
   * `CountUpDirective` escribía `0` en `ngOnInit` y no arrancaba hasta que el
   * `IntersectionObserver` reportara intersección. El mock NO dispara —que es el caso real de
   * una pastilla abajo del pliegue— y con movimiento reducido tampoco había rescate, porque la
   * compuerta de visibilidad corre antes que la del movimiento.
   *
   * Antes del arreglo esta prueba lee `$0.00` sobre un ahorro de $6.60.
   */
  it('el ahorro publica su importe aunque el observador nunca vea la pastilla', () => {
    conMovimientoReducido();
    svc.proximo = {
      estado: 'encontrado', origen: 'live', snapshotAl: null,
      producto: CON_MAYOREO, unidadEscaneada: 'PZA',
    } as ResultadoBusqueda;
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    const cifra = fix.nativeElement.querySelector('.vf-may-ahorro strong') as HTMLElement | null;
    expect(cifra).toBeTruthy();
    expect(cifra!.textContent).toContain('6.60');
    expect(cifra!.textContent?.trim()).not.toBe('$0.00');
    // Y se afirma la premisa: nadie intersectó. Sin esto la prueba podría pasar por el camino
    // fácil y dejar el defecto vivo.
    expect(nadieIntersecto()).toBe(true);
  });

  /**
   * La regla que dictó 0Sistemas: manda la unidad del código de barras que se leyó.
   *
   * Se escanea la PIEZA -> el escalón de pieza va en foco y el de paquete atenuado.
   */
  it('escaneando la PIEZA, el escalón grande es el de pieza', () => {
    svc.proximo = {
      estado: 'encontrado', origen: 'live', snapshotAl: null,
      producto: CON_MAYOREO, unidadEscaneada: 'PZA',
    } as ResultadoBusqueda;
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    const foco = fix.nativeElement.querySelectorAll('.vf-may-row.is-foco');
    expect(foco.length).toBe(1);
    expect(foco[0].textContent).toContain('8.71');   // el de pieza
    expect(foco[0].textContent).toContain('10');     // desde 10 piezas
    // El de paquete existe pero NO está en foco: su monto está en otra unidad.
    const sinFoco = fix.nativeElement.querySelectorAll('.vf-may-row:not(.is-foco)');
    expect(sinFoco.length).toBe(1);
    expect(sinFoco[0].textContent).toContain('65.11');
  });

  /** El espejo, y es el caso que 0Sistemas nombró: se lee el CB del paquete. */
  it('escaneando el PAQUETE, el escalón grande es el de paquete y su monto NO dice c/u', () => {
    svc.proximo = {
      estado: 'encontrado', origen: 'live', snapshotAl: null,
      producto: CON_MAYOREO, unidadEscaneada: 'PAQ',
    } as ResultadoBusqueda;
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    const foco = fix.nativeElement.querySelector('.vf-may-row.is-foco') as HTMLElement;
    expect(foco).toBeTruthy();
    expect(foco.textContent).toContain('65.11');
    // La unidad del monto viene con el escalón. Cableada a "c/u", $65.11 se leía como el precio
    // de UNA pieza de un producto que cuesta $9.37: la cifra errada por 7x.
    expect(foco.querySelector('.vf-may-cu')?.textContent?.trim()).toBe('por paquete');
    // El primero del DOM es el destacado: el orden lo decide la unidad leída, no el backend.
    const filas = fix.nativeElement.querySelectorAll('.vf-may-row');
    expect(filas[0].classList.contains('is-foco')).toBe(true);
  });

  /** La pastilla del ahorro no se duplica: una sola, la del escalón que aplica. */
  it('sólo el escalón en foco lleva la pastilla del ahorro', () => {
    conMovimientoReducido();
    svc.proximo = {
      estado: 'encontrado', origen: 'live', snapshotAl: null,
      producto: CON_MAYOREO, unidadEscaneada: 'PAQ',
    } as ResultadoBusqueda;
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    const pastillas = fix.nativeElement.querySelectorAll('.vf-may-ahorro');
    expect(pastillas.length).toBe(1);
    expect(pastillas[0].textContent).toContain('15.03');   // el ahorro del paquete
    expect(pastillas[0].textContent).not.toContain('6.60'); // no el de pieza
  });

  /**
   * `[TDA.6]` La animación de entrada se reinicia en CADA escaneo.
   *
   * La tarjeta es el mismo nodo del DOM entre consultas, así que sin alternar el
   * `animation-name` la entrada corría una sola vez por turno. Acá se mide el mecanismo
   * ejecutándose, no el string en el archivo.
   */
  it('la tarjeta alterna la clase de reinicio en cada consulta', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: CON_MAYOREO } as ResultadoBusqueda;

    fix.componentInstance.consultar('70001');
    fix.detectChanges();
    const card = fix.nativeElement.querySelector('.vf-card') as HTMLElement;
    const primero = card.classList.contains('is-pase-b');

    fix.componentInstance.consultar('70001');
    fix.detectChanges();
    // MISMO nodo (si se recreara, el reinicio no haría falta) y clase distinta.
    expect(fix.nativeElement.querySelector('.vf-card')).toBe(card);
    expect(card.classList.contains('is-pase-b')).toBe(!primero);
  });

  // ── `[TDA.8]` El aviso en vivo de precio de etiqueta ──────────────────────────────────────
  // Se ejercita el camino completo con el socket stubbeado: emitir el evento, ver el DOM.

  /** Deja un producto en pantalla y devuelve el evento que le habla a ÉL. */
  const conProductoEnPantalla = (p: typeof PRODUCTO = PRODUCTO): LabelPricesChanged => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: p } as ResultadoBusqueda;
    fix.componentInstance.consultar(p.codigo);
    fix.detectChanges();
    return { product_ids: [p.product_id!], total: 1, truncated: false, at: new Date().toISOString() };
  };

  /** Cambia lo que va a contestar la SIGUIENTE consulta (el refresco por aviso). */
  const yElPrecioAhoraEs = (p: typeof PRODUCTO, precio: number): void => {
    svc.proximo = {
      estado: 'encontrado', origen: 'live', snapshotAl: null,
      producto: { ...p, unidades: [{ ...p.unidades[0], precio_con_iva: precio }, ...p.unidades.slice(1)] },
    } as ResultadoBusqueda;
  };

  it('se suscribe al socket de etiquetas al arrancar', () => {
    expect(sock.conectado).toBeGreaterThan(0);
  });

  it('el aviso de SU producto reconsulta, y declara el cambio con el precio anterior', () => {
    const evento = conProductoEnPantalla();
    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('62.99');

    yElPrecioAhoraEs(PRODUCTO, 71.5);
    sock.labelPricesChanged$.next(evento);
    fix.detectChanges();

    // La cifra en pantalla es la nueva: es la que va a cobrar la caja.
    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('71.50');
    // Y NO cambió en silencio: lo dice, y dice desde cuánto.
    const aviso = fix.nativeElement.querySelector('.vf-cambio') as HTMLElement | null;
    expect(aviso).toBeTruthy();
    expect(aviso!.textContent).toContain('acaba de cambiar');
    expect(aviso!.textContent).toContain('62.99');
  });

  it('un aviso de OTRO producto no toca la pantalla', () => {
    conProductoEnPantalla();
    yElPrecioAhoraEs(PRODUCTO, 71.5); // si reconsultara, la cifra se movería

    sock.labelPricesChanged$.next({
      product_ids: ['ffffffff-0000-4000-8000-00000000000f'], total: 1, truncated: false,
      at: new Date().toISOString(),
    });
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('62.99');
    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeNull();
  });

  /**
   * "No sé cuáles" NO es "ninguno". Es la misma trampa que `FRESHNESS_UNKNOWN` con `stale:false`
   * dejó viva seis días en la etiquetera, y la que su propio banner ya documenta.
   */
  it('un aviso RECORTADO verifica igual, aunque no diga cuáles', () => {
    conProductoEnPantalla();
    yElPrecioAhoraEs(PRODUCTO, 71.5);

    sock.labelPricesChanged$.next({ product_ids: [], total: 9000, truncated: true, at: new Date().toISOString() });
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('71.50');
    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeTruthy();
  });

  /** Desde el respaldo no hay `product_id`: tampoco se puede descartar, así que se verifica. */
  it('sin product_id (respaldo) verifica igual, en vez de asumir que no cambió', () => {
    svc.proximo = {
      estado: 'encontrado', origen: 'respaldo', snapshotAl: '2026-09-08T12:00:00.000Z',
      producto: { ...PRODUCTO, product_id: null },
    } as ResultadoBusqueda;
    fix.componentInstance.consultar('17083');
    fix.detectChanges();

    yElPrecioAhoraEs(PRODUCTO, 71.5);
    sock.labelPricesChanged$.next({
      product_ids: ['ffffffff-0000-4000-8000-00000000000f'], total: 1, truncated: false,
      at: new Date().toISOString(),
    });
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeTruthy();
  });

  /**
   * El aviso puede ser de otra unidad o de otro campo de la etiqueta. Gritar "cambió" sobre una
   * cifra idéntica es la alarma que se aprende a ignorar — y entonces no sirve el día que importa.
   */
  it('si tras reconsultar la cifra es la misma, NO grita', () => {
    const evento = conProductoEnPantalla();
    sock.labelPricesChanged$.next(evento); // `svc.proximo` sigue devolviendo 62.99
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-precio')?.textContent).toContain('62.99');
    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeNull();
  });

  it('la marca no se queda pegada al escanear el siguiente producto', () => {
    const evento = conProductoEnPantalla();
    yElPrecioAhoraEs(PRODUCTO, 71.5);
    sock.labelPricesChanged$.next(evento);
    fix.detectChanges();
    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeTruthy();

    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: CON_MAYOREO } as ResultadoBusqueda;
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-cambio')).toBeNull();
  });

  /**
   * `[2026-09-14]` El feed de "últimas consultas" se RETIRÓ (pedido de piso de tienda): en un
   * mostrador público, cualquiera que pasa leía qué escaneó el cliente anterior y a qué
   * precio. Es la prueba negativa — si alguien lo reintrodujera, esto se pone rojo.
   */
  it('NO deja un historial de productos/precios escaneados a la vista de cualquiera', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: PRODUCTO };
    fix.componentInstance.consultar('17083');
    fix.detectChanges();

    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: CON_MAYOREO };
    fix.componentInstance.consultar('70001');
    fix.detectChanges();

    expect(fix.nativeElement.querySelector('.vf-feed')).toBeNull();
    // El producto ANTERIOR (ya resuelto) no debe seguir asomando en ningún lado de la pantalla.
    expect(html()).not.toContain(PRODUCTO.nombre);
  });

  /**
   * El mayoreo quedaba fuera de la vista sin forma de llegar a él: en un kiosco real el único
   * periférico es la pistola, no hay mouse ni dedo para hacer scroll. Medido en vivo (terminal
   * 40/Oficina): "LLEVANDO 3 O MÁS PAQUETES" cortado exacto en el borde inferior de la ventana.
   * Se afirma el mecanismo (la tarjeta se desplaza sola, hasta que se ve su PIE, que es donde
   * vive el mayoreo/ahorro que más espacio pide), no el string de la implementación.
   */
  it('tras un resultado, la tarjeta se desplaza sola hasta que su pie queda a la vista', async () => {
    const spy = jest.fn();
    // jsdom no implementa el layout real: se stubbea para AFIRMAR que se llamó, no el resultado
    // visual (eso no se puede medir sin browser — declarado, no fingido).
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = spy;
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: CON_MAYOREO } as ResultadoBusqueda;

    try {
      fix.componentInstance.consultar('70001');
      fix.detectChanges();
      // El desplazamiento va detrás de un setTimeout(0) (esperar a que Angular pinte la
      // tarjeta antes de medirla) — un tick real de la cola de tareas alcanza para que corra.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // No se afirma un total exacto de llamadas: otras pruebas del archivo también dejan
      // programado su propio `setTimeout(0)` y drenan en el mismo tick. La LLAMADA que
      // corresponde a ESTE escaneo es la última en la cola (FIFO por tiempo de programación).
      expect(spy).toHaveBeenCalled();
      // block: 'end' es el punto que importa: alinea el PIE de la tarjeta contra el borde de
      // la ventana, no la cabecera — si volviera a 'start', el mayoreo seguiría fuera de vista.
      expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'end' });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  // ── Cámara del celular como lector: tercera vía junto a la pistola HID y el teclado ───────
  describe('cámara del celular como lector', () => {
    it('la barra "Escanea tu Producto" ES el botón (ya no hay uno redondo aparte)', () => {
      const btn = fix.nativeElement.querySelector('button.vf-scanbar') as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(false); // este fixture ya trae sucursal fija del usuario
    });

    /**
     * jsdom no implementa `getUserMedia`: es el mismo estado que un navegador sin HTTPS.
     * Es la prueba NEGATIVA del gate — sin ella, un cambio que dejara el botón mudo ante la
     * falta de cámara pasaría en verde (ADR-056: "un gate sin prueba negativa es una intención").
     */
    it('sin acceso a cámara, avisa por qué en vez de quedarse mudo', async () => {
      await fix.componentInstance.abrirCamara();
      fix.detectChanges();
      expect(fix.componentInstance.camaraAbierta()).toBe(false);
      expect(html()).toContain('Este equipo no da acceso a la cámara');
      expect(fix.nativeElement.querySelector('.vf-cam-ov')).toBeNull();
    });

    it('cerrarCamara() no truena si la cámara nunca se abrió', () => {
      expect(() => fix.componentInstance.cerrarCamara()).not.toThrow();
      expect(fix.componentInstance.camaraAbierta()).toBe(false);
    });

    /**
     * `[MU1EABF2-1]` Error real capturado por el monitor en un celular Android
     * (`/tienda/verificador`, 2026-09-14T15:25:42Z): `UnknownError: setPhotoOptions failed`.
     * zxing pregunta `track.getCapabilities()` para saber si hay torch, y en esos equipos el
     * navegador falla esa negociación DESPUÉS de que la cámara ya abrió — llega como promesa
     * sin capturar, no como una excepción que el try/catch de `abrirCamara()` pueda ver.
     *
     * Sin el manejador global, la cámara queda abierta y congelada sin ningún aviso. Ésta es
     * la prueba negativa: se dispara el mismo tipo de evento y se afirma que SÍ se cierra y
     * SÍ se declara — no que la pantalla "no truena" (eso ya lo garantiza jsdom).
     */
    it('un error de cámara sin capturar (setPhotoOptions) la cierra y lo declara, no la deja congelada', async () => {
      // jsdom no trae mediaDevices.getUserMedia: se stubbea sólo para pasar la primera guarda
      // de abrirCamara() — lo que se prueba es el manejador de errores globales, no el decoder.
      // Se restaura al terminar: otras pruebas del archivo dependen de que NO exista.
      const originalMediaDevices = (navigator as any).mediaDevices;
      (navigator as any).mediaDevices = { getUserMedia: async () => ({ getVideoTracks: () => [] }) };
      try {
        await fix.componentInstance.abrirCamara();
        expect(fix.componentInstance.camaraAbierta()).toBe(true);

        const evento = new Event('unhandledrejection') as unknown as { reason: unknown };
        (evento as any).reason = new Error('UnknownError: setPhotoOptions failed');
        window.dispatchEvent(evento as unknown as Event);
        fix.detectChanges();

        expect(fix.componentInstance.camaraAbierta()).toBe(false);
        expect(html()).toContain('La cámara se interrumpió');
      } finally {
        (navigator as any).mediaDevices = originalMediaDevices;
      }
    });

    it('sin sucursal elegida, el botón queda deshabilitado y abrirCamara() no hace nada', async () => {
      // Dos sucursales y sin warehouse_code de usuario: el componente NO auto-elige ninguna.
      const authSinSucursal = { user: () => ({ username: 'qa' }) };
      const svc2 = new VerificadorStub();
      svc2.sucursalesResp = [
        { codigo: '03', nombre: '8 ESQUINAS', direccion: '', ciudad: '', almacenes: ['03'], datos_al: null },
        { codigo: '04', nombre: 'BOULEVARD', direccion: '', ciudad: '', almacenes: ['04'], datos_al: null },
      ];
      await TestBed.resetTestingModule().configureTestingModule({
        imports: [TiendaVerificadorComponent],
        providers: [
          provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
          { provide: VerificadorService, useValue: svc2 },
          // `[TDA.8]` ngOnInit ahora tambien conecta el socket de etiquetas; sin stub, la
          // implementacion real pide `auth.token()` (que este AuthService minimo no tiene).
          { provide: StoreSocketService, useValue: new SocketStub() },
          { provide: AuthService, useValue: authSinSucursal },
        ],
      }).compileComponents();
      const f2 = TestBed.createComponent(TiendaVerificadorComponent);
      f2.detectChanges();

      const btn = f2.nativeElement.querySelector('button.vf-scanbar') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      await f2.componentInstance.abrirCamara();
      expect(f2.componentInstance.camaraAbierta()).toBe(false);
    });
  });
});
