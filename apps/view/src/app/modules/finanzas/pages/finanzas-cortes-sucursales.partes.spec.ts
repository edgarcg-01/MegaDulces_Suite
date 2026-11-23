import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { CorteArqueo, CorteDeclaracionCajero, CorteDesgloseKepler, CorteRow, CortesSucursalesResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FinanzasCortesSucursalesComponent, lecturaDelEfectivo, partesDelEfectivo } from './finanzas-cortes-sucursales.component';

/**
 * `[CSU.24]` **El efectivo, parte por parte: cajero contra Kepler.** El renglón «Efectivo» del cuadre se
 * abre en billetes y monedas del cajón, créditos y cheques, y lo retirado en el turno, y una frase dice
 * dónde se separan los dos testigos.
 *
 * Lo que este candado cuida es que la frase no mienta. Medido en prod (noviembre 2026, 418 cortes con los
 * dos lados), tres separaciones NO son dinero de menos y no se pueden pintar como diferencia:
 * - el cajón da igual y sólo cambia el reparto entre billetes y monedas (22 cortes);
 * - Kepler trae dentro de su cajón los créditos y cheques del cajero (43);
 * - Kepler retiró más de lo que el cajero contó: se toma como bueno (CSU.16), no es faltante.
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const decl = (p: Partial<CorteDeclaracionCajero>): CorteDeclaracionCajero => ({
  cajon: 6108.5, cajon_billetes: 6060, cajon_monedas: 48.5, retiros: 31440, retiros_n: 4, retiros_kepler: 31440,
  retiros_sin_verificar: 0, documentos: 0, efectivo: 37548.5, tarjeta: null, transferencia: null, electronico: null,
  total: null, diferencia: 0.44, fisico_con_documentos: null, creditos_fuera_del_desglose: false,
  concuerda_con_kepler: true, capturado_at: null, ligado: 'folio', ...p,
} as CorteDeclaracionCajero);
const kep = (p: Partial<CorteDesgloseKepler> = {}): CorteDesgloseKepler => ({ billetes: 6060, monedas: 48.5, retirado: 31440, ...p });
const arq = (d: CorteDeclaracionCajero | null, k: CorteDesgloseKepler | null): CorteArqueo =>
  ({ declaracion_cajero: d, desglose_kepler: k, conteos_cajero: [] }) as unknown as CorteArqueo;

describe('[CSU.24] el efectivo, parte por parte', () => {
  it('cuando todo coincide: billetes, monedas y retirado, sin marcar nada, y lo dice', () => {
    const a = arq(decl({}), kep());
    const p = partesDelEfectivo(a);
    expect(p.map((x) => [x.etiqueta, x.cajero, x.kepler, x.difiere])).toEqual([
      ['Billetes en el cajón', 6060, 6060, false],
      ['Monedas en el cajón', 48.5, 48.5, false],
      ['Retirado en el turno · 4 retiros', 31440, 31440, false],
    ]);
    expect(lecturaDelEfectivo(a)).toBe('El cajero y Kepler coinciden parte por parte.');
  });

  it('⭐ un cajón que difiere marca SU familia y dice cuánto', () => {
    const a = arq(decl({}), kep({ billetes: 5360 }));
    const p = partesDelEfectivo(a);
    expect(p.filter((x) => x.difiere).map((x) => x.etiqueta)).toEqual(['Billetes en el cajón']);
    expect(lecturaDelEfectivo(a)).toBe('El cajón difiere: el cajero contó +$700.00 contra Kepler (billetes +$700.00, monedas $0.00).');
  });

  it('⛔ NEGATIVA: el mismo cajón repartido distinto entre billetes y monedas NO es diferencia', () => {
    const a = arq(decl({ cajon_billetes: 6040, cajon_monedas: 68.5 }), kep());
    expect(partesDelEfectivo(a).some((x) => x.difiere)).toBe(false);
    expect(lecturaDelEfectivo(a)).toBe('El cajón da lo mismo; sólo cambia el reparto entre billetes y monedas.');
  });

  it('⛔ NEGATIVA: los créditos que Kepler cuenta dentro de su cajón NO son sobrante de Kepler', () => {
    const a = arq(decl({ documentos: 225.23, efectivo: 37773.73 }), kep({ billetes: 6285.23 }));
    const p = partesDelEfectivo(a);
    expect(p.some((x) => x.difiere)).toBe(false);
    expect(p.find((x) => x.etiqueta === 'Créditos y cheques en el cajón')).toMatchObject({ cajero: 225.23, kepler: null, nota: 'no los separa' });
    expect(lecturaDelEfectivo(a)).toBe('Kepler cuenta dentro de su cajón los $225.23 de créditos y cheques; sin ellos, el cajón da lo mismo.');
  });

  it('⛔ NEGATIVA: lo que Kepler retiró y nadie contó se toma como bueno — se dice, no se marca como diferencia', () => {
    const a = arq(decl({ retiros: 0, retiros_n: 0 }), kep({ retirado: 38000 }));
    const r = partesDelEfectivo(a).find((x) => x.etiqueta === 'Retirado en el turno')!;
    expect([r.cajero, r.kepler, r.difiere]).toEqual([0, 38000, false]);
    expect(lecturaDelEfectivo(a)).toBe('Kepler registra $38,000.00 retirados que el cajero no contó; se toman como buenos.');
  });

  it('el cajero que contó MÁS retiros de los que Kepler registra sí se marca', () => {
    const a = arq(decl({ retiros: 13000, retiros_n: 1 }), kep({ retirado: 0 }));
    const r = partesDelEfectivo(a).find((x) => x.etiqueta.startsWith('Retirado'))!;
    expect([r.etiqueta, r.difiere]).toEqual(['Retirado en el turno · 1 retiro', true]);
    expect(lecturaDelEfectivo(a)).toBe('El cajero contó $13,000.00 más en retiros de lo que Kepler registra.');
  });

  it('un cierre que no se pudo partir va entero, como «Cajón al cerrar»', () => {
    const p = partesDelEfectivo(arq(decl({ cajon_billetes: null, cajon_monedas: null }), kep()));
    expect(p[0]).toMatchObject({ etiqueta: 'Cajón al cerrar', cajero: 6108.5, kepler: 6108.5, difiere: false });
    expect(p.some((x) => x.etiqueta.startsWith('Billetes'))).toBe(false);
  });

  it('⛔ NEGATIVA: sin uno de los dos lados no hay lectura, y lo que falta es «—», no cero', () => {
    const sinKepler = arq(decl({}), null);
    expect(partesDelEfectivo(sinKepler).every((x) => x.kepler === null && !x.difiere)).toBe(true);
    expect(lecturaDelEfectivo(sinKepler)).toBeNull();
    const sinCierre = arq(decl({ cajon: null, cajon_billetes: null, cajon_monedas: null, efectivo: null }), kep());
    expect(partesDelEfectivo(sinCierre).slice(0, 2).map((x) => x.cajero)).toEqual([null, null]);
    expect(lecturaDelEfectivo(sinCierre)).toBeNull();
    expect(partesDelEfectivo(arq(null, null))).toEqual([]);
  });

  it('sin retiros de ningún lado no se pinta un renglón de $0 contra $0', () => {
    const p = partesDelEfectivo(arq(decl({ retiros: 0, retiros_n: 0 }), kep({ retirado: 0 })));
    expect(p.some((x) => x.etiqueta.startsWith('Retirado'))).toBe(false);
  });
});

describe('[CSU.24] en la pantalla', () => {
  const ARQUEO = {
    fecha: '2026-11-18', efectivo_esperado: 37548.06, efectivo_contado: 37548.06, tarjeta_esperado: 0, tarjeta_contado: 0,
    transfer_esperado: 0, transfer_contado: 0, esperado_total: 37548.06, esperado_neto: 37548.06, contado_total: 37548.06,
    cajero: null, cajero_nombre: null, conteo_fisico: 36848, fisico_diferencia: -700.06, electronico_kepler: null, arqueo_declarado: true,
    declaracion_cajero: decl({}), desglose_kepler: kep({ billetes: 5360 }), conteos_cajero_sin_ligar: 0, conteos_cajero: [],
  } as unknown as CorteArqueo;
  const CORTE = {
    clave: '05-UD2301-0000012', sucursal: '05', sucursal_nombre: 'Zamora Centro', documento: 'UD2301-0000012', folio: '0000012',
    fecha: '2026-11-18', referencia: 'Caja 2-296', caja: '2', turno: '296', monto: 37548.06, cobrado: 0, saldo: 37548.06,
    estado_cobro: 'sin_cobro', cobros: [], cobros_cancelados: [], devoluciones: [], devoluciones_total: 0,
    arqueo: ARQUEO, cuadre: 'cuadra', diferencia: 0, sin_cuadrar: false,
  } as unknown as CorteRow;
  const RESPUESTA = {
    periodo: { from: '2026-11-01', to: '2026-11-30' }, alcance: { todas: true, sucursales: [] },
    totales: { cortes: 1, vendido: 37548.06, cobrado: 0, pendiente: 37548.06, sin_cobro: 1, con_diferencia: 0, sin_arqueo: 0, contado_igual_esperado: 1, con_declaracion_cajero: 1 },
    sucursales: [], cortes: [CORTE], conteos_fuera_de_corte: [], cortes_en_blanco: 0, ultimo_corte: '2026-11-18',
    umbral_descuadre: 50, plazo_cobro_dias: 3,
  } as unknown as CortesSucursalesResponse;

  it('las partes van debajo de «Efectivo», la que difiere lo dice sin depender del color, y la frase aparece', () => {
    TestBed.configureTestingModule({
      imports: [FinanzasCortesSucursalesComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: PermissionsService, useValue: { isAdmin: () => true, isSuperadmin: () => false, has: () => true, hasExplicit: () => true, hasAny: () => true } }],
    });
    const fixture = TestBed.createComponent(FinanzasCortesSucursalesComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne((r) => r.url.includes('/finance/cortes-sucursales')).flush(RESPUESTA);
    http.match(() => true);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    c.selCorte.set(c.data()!.cortes[0]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const filas = [...el.querySelectorAll<HTMLTableRowElement>('.cs-parte')].map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(filas).toHaveLength(3);
    expect(filas[0]).toContain('Billetes en el cajón (difieren)');
    expect(filas[0]).toContain('$5,360.00');
    expect(filas[1]).not.toContain('difieren');
    expect(el.querySelectorAll('.cs-parte-dif')).toHaveLength(1);
    expect(el.querySelector('.cs-donde')?.textContent).toContain('El cajón difiere: el cajero contó +$700.00 contra Kepler');
    // El renglón de arriba sigue siendo la suma de las partes de cada lado.
    expect(el.textContent).toContain('$37,548.50');
    expect(el.textContent).toContain('$36,848.00');
  });
});
