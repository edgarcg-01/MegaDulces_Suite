import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { CorteArqueo, CorteConteoCajero, CorteConteoFuera, CorteRow, CortesSucursalesResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FinanzasCortesSucursalesComponent } from './finanzas-cortes-sucursales.component';

/**
 * `[CSU.23]` **Ver los arqueos del cajero, conteo por conteo** (Edgar, 2026-11-20: «agreguemos más
 * accesibilidad a datos, por ejemplo, ver los arqueos»). Hasta aquí el detalle del corte decía sólo la
 * SUMA de lo que declaró el cajero; cada retiro y el cierre, con sus piezas, vivían en /tienda/arqueo,
 * que Finanzas no tiene (SM.47).
 *
 * Monta la pantalla entera (compila la plantilla) y cuida lo que puede mentir:
 * - que un conteo sin piezas se lea como «contó cero» (se dice «no guardó las piezas»);
 * - que unas piezas que no dan el total pasen calladas;
 * - que el conteo abierto no se pueda cerrar o que se abran dos a la vez;
 * - que un conteo fuera de corte no se pueda abrir.
 *
 * Vectores SINTÉTICOS (el repo es público).
 */
const conteo = (p: Partial<CorteConteoCajero>): CorteConteoCajero => ({
  id: 'r1', tipo: 'retiro', fecha: '2026-11-18', hora: '16:04', total: 10000, usuario: 'Cajera Uno', nota: null,
  piezas: [
    { denom_key: '500', etiqueta: 'Billete de $500', valor: 500, piezas: 16, importe: 8000 },
    { denom_key: '200', etiqueta: 'Billete de $200', valor: 200, piezas: 10, importe: 2000 },
  ],
  piezas_diferencia: 0, medios: [], ligado: 'folio', ...p,
});
const CONTEOS: CorteConteoCajero[] = [
  conteo({}),
  conteo({ id: 'r2', hora: '18:30', total: 5000, piezas: [], piezas_diferencia: null }),
  conteo({
    id: 'c1', tipo: 'cierre', hora: '20:56', total: 1250, nota: 'faltó una moneda de 10', ligado: 'hora',
    piezas: [{ denom_key: '1000', etiqueta: 'Billete de $1,000', valor: 1000, piezas: 1, importe: 1000 }],
    piezas_diferencia: -250,
    medios: [{ clave: 'tarjeta', etiqueta: 'Tarjeta y transferencia', monto: 6482.95 }],
  }),
];
const ARQUEO = {
  fecha: '2026-11-18', efectivo_esperado: 16250, efectivo_contado: 16250, tarjeta_esperado: 6482.95, tarjeta_contado: 6482.95,
  transfer_esperado: 0, transfer_contado: 0, esperado_total: 22732.95, esperado_neto: 22732.95, contado_total: 22732.95,
  cajero: null, conteo_fisico: null, fisico_diferencia: null, electronico_kepler: null, arqueo_declarado: false,
  declaracion_cajero: null, conteos_cajero_sin_ligar: 0, conteos_cajero: CONTEOS,
} as unknown as CorteArqueo;
const CORTE = {
  clave: '05-UD2301-0000012', sucursal: '05', sucursal_nombre: 'Zamora Centro', documento: 'UD2301-0000012', folio: '0000012',
  fecha: '2026-11-18', referencia: 'Caja 2-296', caja: '2', turno: '296', monto: 22732.95, cobrado: 0, saldo: 22732.95,
  estado_cobro: 'sin_cobro', cobros: [], cobros_cancelados: [], devoluciones: [], devoluciones_total: 0,
  arqueo: ARQUEO, cuadre: 'cuadra', diferencia: 0, sin_cuadrar: false,
} as unknown as CorteRow;
const FUERA: CorteConteoFuera = {
  sucursal: '05', sucursal_nombre: 'Zamora Centro', fecha: '2026-11-18', hora: '09:00:00', tipo: 'sin_caja', caja: null,
  total: 700, por_que: 'sin_caja', motivo: 'DEPOSITO DOMINGO', folio: null, usuario: 'Cajera Uno',
  id: 'f1', piezas: [{ denom_key: '500', etiqueta: 'Billete de $500', valor: 500, piezas: 1, importe: 500 }, { denom_key: '200', etiqueta: 'Billete de $200', valor: 200, piezas: 1, importe: 200 }],
  piezas_diferencia: 0, nota: 'del domingo',
};
const RESPUESTA = {
  periodo: { from: '2026-11-01', to: '2026-11-30' }, alcance: { todas: true, sucursales: [] },
  totales: { cortes: 1, vendido: 22732.95, cobrado: 0, pendiente: 22732.95, sin_cobro: 1, con_diferencia: 0, sin_arqueo: 0, contado_igual_esperado: 1, con_declaracion_cajero: 0 },
  sucursales: [], cortes: [CORTE], conteos_fuera_de_corte: [FUERA], cortes_en_blanco: 0, ultimo_corte: '2026-11-18',
  umbral_descuadre: 50, plazo_cobro_dias: 3,
} as unknown as CortesSucursalesResponse;

function montar() {
  TestBed.configureTestingModule({
    imports: [FinanzasCortesSucursalesComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: { isAdmin: () => true, isSuperadmin: () => false, has: () => true, hasExplicit: () => true, hasAny: () => true } }],
  });
  const fixture = TestBed.createComponent(FinanzasCortesSucursalesComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne((r) => r.url.includes('/finance/cortes-sucursales')).flush(RESPUESTA);
  http.match(() => true);   // lo que pinten las pestañas: no es de esta prueba
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const c = fixture.componentInstance;
  const texto = () => (el.textContent ?? '').replace(/\s+/g, ' ');
  const render = () => fixture.detectChanges();
  return { fixture, c, el, texto, render };
}

describe('[CSU.23] los conteos del cajero, uno por uno', () => {
  it('el detalle del corte lista cada conteo con su hora, cuál es y quién, del más viejo al más nuevo', () => {
    const { c, el, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]);
    render();
    const filas = [...el.querySelectorAll<HTMLButtonElement>('.cs-conteo')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(filas).toHaveLength(3);
    expect(filas[0]).toContain('16:04');
    expect(filas[0]).toContain('Retiro 1 de 2');
    expect(filas[0]).toContain('Cajera Uno');
    expect(filas[1]).toContain('Retiro 2 de 2');
    expect(filas[2]).toContain('Cierre');
    expect(el.textContent).toContain('Lo que contó el cajero · 3 conteo(s)');
  });

  it('al abrir uno se ven sus piezas; se cierra con el mismo botón, y abrir otro NO cierra el primero (CSU.25)', () => {
    const { c, el, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]);
    render();
    const btn = () => [...el.querySelectorAll<HTMLButtonElement>('.cs-conteo')];
    expect(btn()[0].getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.cs-piezas')).toBeNull();
    btn()[0].click(); render();
    expect(btn()[0].getAttribute('aria-expanded')).toBe('true');
    expect(btn()[0].getAttribute('aria-controls')).toBe('cs-ct-r1');
    const det = el.querySelector('#cs-ct-r1')!;
    expect(det.textContent).toContain('Billete de $500');
    expect(det.textContent).toContain('16');
    expect(det.textContent).toContain('Suma de las piezas');
    // [CSU.25] Abrir otro deja el primero abierto: se comparan lado a lado.
    btn()[2].click(); render();
    expect(el.querySelector('#cs-ct-r1')).not.toBeNull();
    expect(el.querySelector('#cs-ct-c1')).not.toBeNull();
    expect(btn().map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'true']);
    // Cerrar uno cierra sólo ése.
    btn()[2].click(); render();
    expect(el.querySelector('#cs-ct-c1')).toBeNull();
    expect(el.querySelector('#cs-ct-r1')).not.toBeNull();
  });

  it('[CSU.25] el aviso «Cajero» de la lista abre el corte y lleva el foco a sus conteos', async () => {
    const { fixture, c, el, render } = montar();
    c.todosLosDias(true); render();
    const ir = el.querySelector<HTMLButtonElement>('button.cs-ir')!;
    expect(ir).not.toBeNull();
    expect(ir.getAttribute('aria-label')).toContain('Ver lo que contó el cajero en');
    expect(c.selCorte()).toBeNull();
    ir.click(); render();
    await fixture.whenStable();
    expect(c.selCorte()?.clave).toBe(c.data()!.cortes[0].clave);
    expect(document.activeElement?.id).toBe('cs-conteos-t');
  });

  it('[CSU.25] NEGATIVA: sin conteos del cajero, el aviso es sólo un aviso (no promete un salto a la nada)', () => {
    const { fixture, c, el, render } = montar();
    const corte = c.data()!.cortes[0];
    c.data.set({ ...c.data()!, cortes: [{ ...corte, arqueo: { ...corte.arqueo!, conteos_cajero: [] } }] });
    c.todosLosDias(true); render();
    expect(el.querySelector('button.cs-ir')).toBeNull();
    expect(fixture).toBeTruthy();
  });

  it('NEGATIVA: un conteo sin piezas NO se pinta como «contó cero»', () => {
    const { c, el, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]);
    render();
    el.querySelectorAll<HTMLButtonElement>('.cs-conteo')[1].click(); render();
    const det = el.querySelector('#cs-ct-r2')!;
    expect(det.textContent).toContain('No guardó las piezas');
    expect(det.querySelector('.cs-piezas')).toBeNull();
  });

  it('un conteo de $0 sin piezas es el cajón vacío, no «no guardó las piezas»', () => {
    const { c, el, render } = montar();
    const corte = c.data()!.cortes[0];
    const vacio = conteo({ id: 'r0', total: 0, piezas: [], piezas_diferencia: null });
    c.selCorte.set({ ...corte, arqueo: { ...corte.arqueo!, conteos_cajero: [vacio] } });
    render();
    el.querySelector<HTMLButtonElement>('.cs-conteo')!.click(); render();
    const t = el.querySelector('#cs-ct-r0')!.textContent ?? '';
    expect(t).toContain('el cajón estaba vacío');
    expect(t).not.toContain('No guardó las piezas');
  });

  it('el cierre dice lo que declaró aparte, su nota, cómo se ligó y si sus piezas no dan el total', () => {
    const { c, el, render } = montar();
    c.selCorte.set(c.data()!.cortes[0]);
    render();
    el.querySelectorAll<HTMLButtonElement>('.cs-conteo')[2].click(); render();
    const t = (el.querySelector('#cs-ct-c1')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(t).toContain('Declaró además');
    expect(t).toContain('Tarjeta y transferencia');
    expect(t).toContain('faltó una moneda de 10');
    expect(t).toContain('Ligado a este turno por caja y hora');
    expect(t).toContain('Las piezas no dan el total capturado');
  });

  it('un conteo fuera de corte también se abre en sus piezas y su nota', () => {
    const { c, el, render } = montar();
    c.todosLosDias(true); render();
    const tog = el.querySelector<HTMLButtonElement>('button[aria-controls="cs-ct-f1"]')!;
    expect(tog).not.toBeNull();
    expect(tog.getAttribute('aria-label')).toBe('Ver lo que contó a las 09:00');
    tog.click(); render();
    const t = (el.querySelector('#cs-ct-f1')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(t).toContain('Billete de $200');
    expect(t).toContain('del domingo');
    // NEGATIVA: sin medios que declarar, no aparece «Declaró además».
    expect(t).not.toContain('Declaró además');
  });
});
