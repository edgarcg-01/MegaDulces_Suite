import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { AuthService } from '../../../core/services/auth.service';
import { EstadoSnapshot, ResultadoBusqueda, VerificadorService } from '../verificador.service';
import { TiendaVerificadorComponent } from './tienda-verificador.component';

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

  it('el feed pone lo último arriba y no crece sin límite (es mostrador, no bandeja)', () => {
    svc.proximo = { estado: 'encontrado', origen: 'live', snapshotAl: null, producto: PRODUCTO };
    for (let i = 0; i < 12; i++) fix.componentInstance.consultar('17083');
    expect(fix.componentInstance.feed().length).toBe(8);
  });
});
