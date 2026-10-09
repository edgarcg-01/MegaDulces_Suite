import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { AndenLlegada, AndenLlegadas } from '@megadulces/contracts';
import { AlmacenLlegadasComponent } from './almacen-llegadas.component';
import { ReceivingSessionService } from '../receiving-session.service';

/**
 * `[WMS-REC.22]` Llegadas al andén — la pantalla con datos de ejemplo.
 *
 * Lo que se prueba: que los mosaicos cuenten lo de la vista y filtren, que el camión sin abrir
 * salga primero y lo diga en su detalle, y que la búsqueda encuentre por producto.
 */
const HOY = '2026-10-09';
const resumen = (p: Partial<AndenLlegada['resumen']> = {}): AndenLlegada['resumen'] => ({
  renglones: 1, listos: 1, faltan: 0, sin_caducidad: 0, verdes: 1, amarillos: 0, rojos: 0, por_autorizar: 0, ...p,
});
const base = {
  warehouse_id: 'w1', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  proveedor: null, origen_code: null, origen_nombre: null, salio: null, recibido_kepler: null, importe: null,
};

const DATA: AndenLlegadas = {
  hoy: HOY, desde: '2026-10-02', generado_en: '2026-10-09T16:00:00.000Z',
  llegadas: [
    {
      ...base, clave: '01/0004127', tipo: 'compra', estado: 'completa', dia: HOY, documento: '01/0004127', proveedor: 'KALU', importe: 2040,
      vale: { id: 'v1', folio: 'VE-2026-01866', status: 'closed', abierto_en: '2026-10-09T14:20:00.000Z', abierto_por: 'recibo.piedad', cerrado_en: '2026-10-09T14:41:00.000Z' },
      resumen: resumen({ sin_caducidad: 1, renglones: 2, listos: 2 }),
      renglones: [
        { sku: '95775', nombre: 'EST GOM PELAFRUT MANGO 800GR', cantidad: 24, unidad: 'PAQ', estado: 'fechado', lotes: [{ lote: 'K-0925', caducidad: '2027-04-30', cantidad: 24, semaforo: 'green', estatus: 'accepted' }] },
        { sku: '84030', nombre: 'VELA NUMERICA AZUL', cantidad: 3, unidad: 'PZA', estado: 'sin_caducidad', lotes: [{ lote: 'NA', caducidad: null, cantidad: 3, semaforo: 'green', estatus: 'accepted' }] },
      ],
    },
    {
      ...base, clave: '01/0004128', tipo: 'compra', estado: 'sin_abrir', dia: HOY, documento: '01/0004128', proveedor: 'DULCES DE LA ROSA', importe: 18420.5,
      vale: null, resumen: resumen({ listos: 0, faltan: 1, verdes: 0 }),
      renglones: [{ sku: '70056', nombre: 'LA ROSA MAZAPAN GIGANTE 50G', cantidad: 20, unidad: 'PAQ', estado: 'sin_vale', lotes: [] }],
    },
    {
      ...base, clave: 'UD41/06/2/0001045', tipo: 'traspaso', estado: 'a_medias', dia: '2026-10-08', documento: 'Embarque 06-2-0001045',
      origen_code: '06', origen_nombre: 'Canindo', salio: '2026-10-07', recibido_kepler: '2026-10-08', importe: 3200,
      vale: { id: 'v2', folio: 'VE-2026-01849', status: 'open', abierto_en: '2026-10-08T23:40:00.000Z', abierto_por: 'anden.ph', cerrado_en: null },
      resumen: resumen({ renglones: 2, listos: 1, faltan: 1 }),
      renglones: [{ sku: '99891', nombre: 'LECHE ENTERA 1L', cantidad: 120, unidad: 'PZA', estado: 'falta', lotes: [] }],
    },
    {
      ...base, clave: 'UD41/06/1/0001083', tipo: 'traspaso', estado: 'en_camino', dia: HOY, documento: 'Embarque 06-1-0001083',
      origen_code: '06', origen_nombre: 'Canindo', salio: HOY, recibido_kepler: null, importe: 6804,
      vale: null, resumen: resumen({ listos: 0, faltan: 1, verdes: 0 }),
      renglones: [{ sku: '27100', nombre: 'WINIS T7 SURTIDO', cantidad: 54, unidad: 'PAQ', estado: 'sin_vale', lotes: [] }],
    },
    {
      ...base, clave: '01/0004100', tipo: 'compra', estado: 'completa', dia: '2026-10-05', documento: '01/0004100', proveedor: 'RICOLINO', importe: 785,
      vale: { id: 'v3', folio: 'VE-2026-01800', status: 'closed', abierto_en: '2026-10-05T15:00:00.000Z', abierto_por: 'recibo.ph', cerrado_en: '2026-10-05T15:20:00.000Z' },
      resumen: resumen(), renglones: [],
    },
  ],
};

describe('[WMS-REC.22] AlmacenLlegadasComponent', () => {
  let fix: ComponentFixture<AlmacenLlegadasComponent>;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent || '';
  const kpi = (t: string): HTMLButtonElement =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('button.ll-kpi')).find((b) => (b.textContent || '').includes(t)) as HTMLButtonElement;

  async function montar(api: Partial<ReceivingSessionService>): Promise<AlmacenLlegadasComponent> {
    await TestBed.configureTestingModule({
      imports: [AlmacenLlegadasComponent],
      providers: [{ provide: ReceivingSessionService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenLlegadasComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix.componentInstance;
  }

  it('Hoy cuenta lo de hoy y lo de ayer sin terminar; lo de hace días ya completo, no', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    const r = c.resumen();
    expect(r).toMatchObject({ llegaron: 3, sin_abrir: 1, a_medias: 1, completas: 1, en_camino: 1, anteriores: 1, sin_caducidad: 1 });
    expect(kpi('Sin abrir en el Andén').textContent).toContain('$18,420.50');
    expect(c.filas().map((l) => l.clave)[0]).toBe('01/0004128');
  });

  it('un mosaico filtra la tabla, y tocarlo otra vez quita el filtro', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    kpi('Sin abrir en el Andén').click();
    fix.detectChanges();
    expect(c.filas().map((l) => l.clave)).toEqual(['01/0004128']);
    kpi('Sin abrir en el Andén').click();
    fix.detectChanges();
    expect(c.filas().length).toBe(4);
  });

  it('Últimos 7 días incluye lo de hace días', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    c.periodo.set('7d');
    fix.detectChanges();
    expect(c.resumen().llegaron).toBe(4);
  });

  it('la búsqueda encuentra el camión por un producto que trae, en cualquier orden de palabras', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    c.q.set('mazapan rosa');
    fix.detectChanges();
    expect(c.filas().map((l) => l.clave)).toEqual(['01/0004128']);
  });

  it('el detalle de un camión sin abrir lo dice y marca sus renglones sin vale', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    c.sel.set(DATA.llegadas[1]);
    fix.detectChanges();
    await fix.whenStable();
    expect(c.frase(DATA.llegadas[1])).toContain('nadie abrió el vale');
    expect(document.body.textContent).toContain('Nadie lo abrió');
  });

  it('un renglón declarado sin caducidad se dice así en la frase del camión', async () => {
    const c = await montar({ llegadas: () => of(DATA) });
    expect(c.frase(DATA.llegadas[0])).toBe('Ningún renglón espera fecha. Uno se declaró sin caducidad.');
  });

  it('sin permiso lo dice, en vez de quedarse en blanco', async () => {
    await montar({ llegadas: () => throwError(() => ({ status: 403 })) });
    expect(texto()).toContain('No tienes permiso para ver las llegadas.');
  });
});
