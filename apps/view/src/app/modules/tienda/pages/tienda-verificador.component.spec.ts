import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { EstadoSnapshot, ResultadoBusqueda, VerificadorService } from '../verificador.service';
import { TiendaVerificadorComponent } from './tienda-verificador.component';
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

  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    svc = new VerificadorStub();
    await TestBed.configureTestingModule({
      imports: [TiendaVerificadorComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: VerificadorService, useValue: svc },
        // La sucursal sale de la ficha del usuario: con warehouse_code no se ofrece elegir.
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '03', username: 'qa' }) } },
      ],
    }).compileComponents();

    fix = TestBed.createComponent(TiendaVerificadorComponent);
    fix.detectChanges();
  });

  it('arranca en espera, con la sucursal del usuario y sin ofrecer selector', () => {
    expect(html()).toContain('Listo para consultar');
    expect(html()).toContain('8 ESQUINAS');
    expect(fix.nativeElement.querySelector('p-select')).toBeNull();
    expect(fix.nativeElement.querySelector('input.vp-scan-input')).toBeTruthy();
  });

  it('un precio en línea se pinta en grande y se rotula como en línea', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: PRODUCTO };
    fix.componentInstance.consultar('17083');
    fix.detectChanges();

    const t = html();
    expect(t).toContain('ALTOS CAM CHICA COLOR 1KG CLASICA');
    expect(fix.nativeElement.querySelector('.vp-precio')?.textContent).toContain('62.99');
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
    expect(fix.nativeElement.querySelector('.vp-card.is-respaldo')).toBeTruthy();
  });

  it('distingue "no encontrado" de "sin conexión" — son dos pantallas', () => {
    svc.proximo = { estado: 'no_encontrado', origen: 'live', codigo: '99999', snapshotAl: null };
    fix.componentInstance.consultar('99999');
    fix.detectChanges();
    expect(html()).toContain('No encontramos');
    expect(html()).not.toContain('Sin conexión y sin respaldo');

    svc.proximo = { estado: 'sin_datos', codigo: '99999' };
    fix.componentInstance.consultar('99999');
    fix.detectChanges();
    expect(html()).toContain('Sin conexión y sin respaldo');
    expect(html()).not.toContain('No encontramos');
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

    const cifra = fix.nativeElement.querySelector('.vp-may-ahorro strong') as HTMLElement | null;
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

    const foco = fix.nativeElement.querySelectorAll('.vp-may-row.is-foco');
    expect(foco.length).toBe(1);
    expect(foco[0].textContent).toContain('8.71');   // el de pieza
    expect(foco[0].textContent).toContain('10');     // desde 10 piezas
    // El de paquete existe pero NO está en foco: su monto está en otra unidad.
    const sinFoco = fix.nativeElement.querySelectorAll('.vp-may-row:not(.is-foco)');
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

    const foco = fix.nativeElement.querySelector('.vp-may-row.is-foco') as HTMLElement;
    expect(foco).toBeTruthy();
    expect(foco.textContent).toContain('65.11');
    // La unidad del monto viene con el escalón. Cableada a "c/u", $65.11 se leía como el precio
    // de UNA pieza de un producto que cuesta $9.37: la cifra errada por 7x.
    expect(foco.querySelector('.vp-may-cu')?.textContent?.trim()).toBe('por paquete');
    // El primero del DOM es el destacado: el orden lo decide la unidad leída, no el backend.
    const filas = fix.nativeElement.querySelectorAll('.vp-may-row');
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

    const pastillas = fix.nativeElement.querySelectorAll('.vp-may-ahorro');
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
    const card = fix.nativeElement.querySelector('.vp-card') as HTMLElement;
    const primero = card.classList.contains('is-pase-b');

    fix.componentInstance.consultar('70001');
    fix.detectChanges();
    // MISMO nodo (si se recreara, el reinicio no haría falta) y clase distinta.
    expect(fix.nativeElement.querySelector('.vp-card')).toBe(card);
    expect(card.classList.contains('is-pase-b')).toBe(!primero);
  });

  it('el feed pone lo último arriba y no crece sin límite (es mostrador, no bandeja)', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: PRODUCTO };
    for (let i = 0; i < 12; i++) fix.componentInstance.consultar('17083');
    expect(fix.componentInstance.feed().length).toBe(8);
  });
});
