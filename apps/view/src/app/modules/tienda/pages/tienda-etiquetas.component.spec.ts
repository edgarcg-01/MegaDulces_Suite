import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';
import { LabelModel } from '../components/label.component';
import { EtiquetasService, ResolveResult } from '../etiquetas.service';
import { VerificadorService } from '../verificador.service';
import { AuthService } from '../../../core/services/auth.service';
import { TiendaEtiquetasComponent } from './tienda-etiquetas.component';

// `p-table` (scrollable) observa su tamaño con ResizeObserver, que jsdom no trae.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
}

/**
 * La PANTALLA de la etiquetera: la cola, la hoja y lo que declara. El servicio se sustituye
 * (no hay API en jsdom); lo que se comprueba es lo que ve el operador y lo que llega a la
 * hoja oculta que se clona a la impresora.
 */
const FRESH: Freshness = { data_as_of: '2026-09-08T10:00:00Z', status: 'fresh', stale: false, age_human: '2 min', inputs: [] };
const UNKNOWN: Freshness = { data_as_of: null, status: 'unknown', stale: true, age_human: null, inputs: [] };
const STALE: Freshness = {
  data_as_of: '2026-09-02T10:00:00Z', status: 'stale', stale: true, age_human: '6 días',
  inputs: [{ key: 'ods_live_hot', label: 'Carril del ODS (precios del ERP)', at: '2026-09-02T10:00:00Z', age_human: '6 días', status: 'stale', stale: true }],
};

const modelo = (sku: string): LabelModel => ({
  code: sku, product_id: `p-${sku}`, sku, name: `PRODUCTO ${sku}`, content: null,
  barcode: null, barcode_format: null,
  piece_price: 12.5, wholesale_piece_min_qty: null, wholesale_piece_price: null,
  pack_size: null, pack_price: null, wholesale_pack_price: null, wholesale_pack_min_qty: null,
  box_size: null, box_price: null, unit_base: 'PZA', sold_by_kg: false,
});

class EtiquetasStub {
  proximo: ResolveResult = { labels: [], not_found: [], freshness: FRESH };
  /** `[ETQ-PLAZA.1]` Con qué plaza se pidió cada resolución. Es lo que el gate tiene que probar. */
  plazas: (string | null | undefined)[] = [];
  search() { return of([]); }
  resolve(_codes: string[], sucursal?: string | null) { this.plazas.push(sucursal); return of(this.proximo); }
}

/** `[ETQ-PLAZA.1]` Sólo se usa el catálogo de plazas; lo demás del verificador no se toca acá. */
class VerificadorStub {
  sucursales() {
    return of([
      { codigo: '00', nombre: 'OFICINAS', direccion: '', ciudad: '', almacenes: [], datos_al: null },
      { codigo: '01', nombre: 'PADRE HIDALGO', direccion: '', ciudad: '', almacenes: [], datos_al: null },
      { codigo: '03', nombre: '8 ESQUINAS', direccion: '', ciudad: '', almacenes: [], datos_al: null },
    ]);
  }
}

describe('TiendaEtiquetasComponent · la cola, la hoja y lo que declara', () => {
  let fix: ComponentFixture<TiendaEtiquetasComponent>;
  let cmp: TiendaEtiquetasComponent;
  let svc: EtiquetasStub;
  const html = (): string => (fix.nativeElement as HTMLElement).textContent ?? '';
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  beforeEach(async () => {
    svc = new EtiquetasStub();
    await TestBed.configureTestingModule({
      imports: [TiendaEtiquetasComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: EtiquetasService, useValue: svc },
        { provide: VerificadorService, useValue: new VerificadorStub() },
        // `[ETQ-PLAZA.1]` Operador de tienda: trae su plaza y no elige. Sin esto la pantalla
        // ya no resuelve nada — ver el bloque de abajo, que es la prueba de que el gate muerde.
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '01', username: 'qa' }), token: () => null } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaEtiquetasComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
  });

  async function escanear(sku: string, freshness: Freshness): Promise<void> {
    svc.proximo = { labels: [modelo(sku)], not_found: [], freshness };
    cmp.onScan(sku);
    await tick();
  }

  it('⭐ el banner de rezago muestra la PEOR frescura de la cola, no la del último escaneo', async () => {
    await escanear('10001', STALE);
    expect(html()).toContain('El precio puede estar viejo');
    await escanear('10002', FRESH);
    // el lote viejo sigue en la cola → el aviso no se apaga
    expect(html()).toContain('El precio puede estar viejo');
    cmp.remove(0); // se va el ítem con rezago
    await tick();
    expect(html()).not.toContain('El precio puede estar viejo');
  });

  it('"no se pudo medir" pesa menos que "viejo" pero más que "al día"', async () => {
    await escanear('10001', UNKNOWN);
    expect(html()).toContain('No se pudo verificar');
    await escanear('10002', FRESH);
    expect(html()).toContain('No se pudo verificar');
    await escanear('10003', STALE);
    expect(html()).toContain('El precio puede estar viejo');
    expect(html()).not.toContain('No se pudo verificar');
  });

  it('la cola tiene tope y las copias no lo pueden saltar', async () => {
    await escanear('10001', FRESH);
    cmp.setCopies(0, 10_000);
    await tick();
    expect(cmp.totalLabels()).toBe(cmp.MAX_LABELS);
    // con la cola llena, un escaneo nuevo no entra y se DICE
    await escanear('10002', FRESH);
    expect(cmp.queue().length).toBe(1);
    expect(html()).toMatch(/tope/i);
  });

  it('la carga masiva devuelve al textarea lo que no cupo, en vez de perderlo', async () => {
    await escanear('10001', FRESH);
    cmp.setCopies(0, cmp.MAX_LABELS - 1);
    await tick();
    svc.proximo = { labels: [modelo('20001'), modelo('20002'), modelo('20003')], not_found: [], freshness: FRESH };
    cmp.bulk.set('20001\n20002\n20003');
    cmp.addBulk();
    await tick();
    expect(cmp.totalLabels()).toBe(cmp.MAX_LABELS);
    expect(cmp.bulk().split(/\s+/).filter(Boolean)).toEqual(['20002', '20003']);
  });

  it('la vista de hoja pagina, y la página se clampea cuando la cola se achica', async () => {
    await escanear('10001', FRESH);
    cmp.setCopies(0, 16);
    await tick();
    expect(cmp.totalSheets()).toBe(2);
    expect(cmp.sheetLabels().length).toBe(15);
    cmp.nextSheet();
    await tick();
    expect(cmp.sheetLabels().length).toBe(1);
    expect(html()).toContain('Hoja 2 de 2');
    cmp.setCopies(0, 3);
    await tick();
    expect(cmp.sheetLabels().length).toBe(3);
    expect(html()).toContain('Hoja 1 de 1');
  });

  /**
   * ⭐ La tipografía con la que se mide cambia el TAMAÑO del precio hasta 17% (ver la tabla en el
   * encabezado de `label.component`), y depende de si ESTE equipo alcanza fonts.googleapis.com.
   * Era la única variación por máquina que quedaba y era invisible: ahora se declara en pantalla.
   * Tres estados, no dos — "no se pudo verificar" no se puede pintar como ✓ (ADR-056).
   */
  it('⭐ declara con qué tipografía se mide, y "sin verificar" no se pinta como ✓', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    const poner = (fonts: unknown) => Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    const crear = async () => {
      const f = TestBed.createComponent(TiendaEtiquetasComponent);
      f.detectChanges();
      await new Promise((r) => setTimeout(r, 0));
      f.detectChanges();
      return f;
    };
    try {
      // La familia NO llegó (equipo de tienda sin salida a internet).
      poner({ check: () => false });
      const f1 = await crear();
      expect(f1.componentInstance.fuenteEtiqueta()).toBe('respaldo');
      expect((f1.nativeElement as HTMLElement).textContent).toContain('tipografía de respaldo');
      // …y DICE cuál falta. Mirar sólo Anton era el falso verde: la que decide el alto de la
      // caja del precio es Baloo 2, y con ella ausente el precio sale 25% más chico.
      expect(f1.componentInstance.fuentesFaltantes()).toContain('Baloo 2');
      expect((f1.nativeElement as HTMLElement).textContent).toContain('Baloo 2');

      // El navegador no deja preguntar → se DECLARA, no se asume que está bien.
      poner({ check: () => { throw new Error('no soportado'); } });
      const f2 = await crear();
      expect(f2.componentInstance.fuenteEtiqueta()).toBe('sin_medir');
      expect((f2.nativeElement as HTMLElement).textContent).not.toContain('tipografía ✓');
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original);
      else delete (document as unknown as Record<string, unknown>)['fonts'];
    }
  });

  it('⭐ imprimir espera a que TODAS las etiquetas de la hoja oculta se hayan ajustado', async () => {
    await escanear('10001', FRESH);
    cmp.setCopies(0, 3);
    await tick();
    const vistas: number[] = [];
    vi.spyOn(cmp as any, 'printIsolated').mockImplementation(() => {
      const hoja = (fix.nativeElement as HTMLElement).querySelector('.etqp-print')!;
      vistas.push(hoja.querySelectorAll('.etq-label[data-etq-settled]').length, hoja.querySelectorAll('.etq-label').length);
      (cmp as any).finishPrint();
    });
    fix.autoDetectChanges(true);
    await cmp.print();
    // [asentadas, totales]: las tres, y no antes.
    expect(vistas).toEqual([3, 3]);
  });

  it('⭐ la plaza del usuario VIAJA en cada resolución — sin ella se imprimía la moda de la red', async () => {
    await escanear('10001', FRESH);
    cmp.bulk.set('20001');
    cmp.addBulk();
    await tick();
    // Escaneo y lote: los dos con la plaza. Un camino que la olvide vuelve a traer el defecto.
    expect(svc.plazas).toEqual(['01', '01']);
  });
});

/**
 * `[ETQ-PLAZA.1]` LA PRUEBA NEGATIVA — la razón de ser del gate.
 *
 * Medido en prod el 2026-09-24: **13 de 31 usuarios con permiso de etiquetas no tienen
 * `warehouse_code`** (superadmin, compras, supervisión, dirección) y hasta hoy imprimían la MODA
 * de las nueve plazas sin que nada lo dijera. En PH eso son 95 productos con precio equivocado,
 * el peor **−94 %** ($90.82 real contra $5.86 impreso).
 *
 * Este bloque existe para que la pantalla no pueda volver a resolver sin tienda. Se rompió a
 * propósito (quitando el `if (!suc) return` de `plazaOAviso`) y sólo este bloque se puso rojo.
 */
describe('TiendaEtiquetasComponent · sin plaza no se etiqueta', () => {
  it('⛔ el usuario de oficina no resuelve NADA hasta elegir tienda, y se le dice', async () => {
    const svc = new EtiquetasStub();
    await TestBed.configureTestingModule({
      imports: [TiendaEtiquetasComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: EtiquetasService, useValue: svc },
        { provide: VerificadorService, useValue: new VerificadorStub() },
        { provide: AuthService, useValue: { user: () => ({ username: 'oficina' }), token: () => null } }, // sin warehouse_code
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(TiendaEtiquetasComponent);
    const cmp = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();

    svc.proximo = { labels: [modelo('10001')], not_found: [], freshness: FRESH };
    cmp.onScan('10001');
    await fix.whenStable();
    fix.detectChanges();

    // Lo que importa: NO se preguntó el precio, y la cola quedó vacía.
    expect(svc.plazas).toEqual([]);
    expect(cmp.queue().length).toBe(0);
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Elige primero la tienda');

    // Y la 00 (Oficinas) no está entre las opciones: no tiene anaquel al público.
    expect(cmp.opcionesSucursal().map((o) => o.value)).toEqual(['01', '03']);

    // Al elegir tienda, el mismo escaneo sí resuelve — con esa plaza.
    cmp.cambiarSucursal('03');
    cmp.onScan('10001');
    await fix.whenStable();
    fix.detectChanges();
    expect(svc.plazas).toEqual(['03']);
  });
});
