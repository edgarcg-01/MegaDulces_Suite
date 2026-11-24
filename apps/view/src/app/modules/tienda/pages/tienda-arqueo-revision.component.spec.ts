import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { ArqueoRevisionCajera, ArqueoRevisionResp, ArqueoRevisionTurno } from '@megadulces/contracts/http/arqueo-cajas';

import { TiendaArqueoRevisionComponent } from './tienda-arqueo-revision.component';
import { environment } from '../../../../environments/environment';

const BASE = `${environment.apiUrl}/store/arqueo-revision`;

const turno = (caja: string, cajero: string, kepler: number, suite: number, over: Partial<ArqueoRevisionTurno> = {}): ArqueoRevisionTurno => ({
  clave: `turno_sin_verificar:07:${caja}:2026-11-20:10${caja}`, fecha: '2026-11-20', warehouse_code: '07',
  warehouse_nombre: 'Sucursal demo', caja, folio: `10${caja}`, cajero_code: cajero, cajero_nombre: `CAJERA ${cajero}`,
  hora_apertura: '07:30:00', hora_cierre: '15:00:00',
  motivos: suite < kepler ? ['retiros_sin_contar'] : suite > kepler ? ['retiros_de_mas'] : [],
  retirado_kepler: kepler, retiros_contados: suite, retiros_diferencia: suite - kepler, cajon_contado: true,
  estado: suite === kepler ? 'cuadra' : 'por_justificar', justificacion: null, historial: [],
  ...over,
});
const causa = { causa: 'otra_caja', nota: 'Se capturó en la caja 2.', por: 'ENC07', por_nombre: 'ENCARGADA DEMO', at: '2026-11-21T16:00:00Z' };
const cajera = (code: string, over: Partial<ArqueoRevisionCajera>): ArqueoRevisionCajera => ({
  cajero_code: code, cajero_nombre: `CAJERA ${code}`, sucursales: ['07'], turnos: 2, con_problema: 2,
  motivos: { retiros_sin_contar: 1, retiros_de_mas: 0, cajon_sin_contar: 0 }, causas: {}, por_justificar: 1,
  retirado_kepler: 0, retiros_contados: 0, retiros_diferencia: 0, retiros_descuadre: 0, turnos_descuadre: 1, ...over,
});

// B tiene −5,000 y +2,000 (neta −3,000); A tiene −25,000 sin explicar y −10,000 ya explicado; C solo cuadra.
const resp = (): ArqueoRevisionResp => ({
  desde: '2026-11-14', hasta: '2026-11-20', datos_al: '2026-11-21T15:00:00Z', frescura: 'ok',
  turnos: [
    turno('1', 'A', 25000, 0),
    turno('2', 'A', 18000, 8000, { estado: 'en_seguimiento', justificacion: causa, historial: [{ tipo: 'causa', valor: 'otra_caja', nota: causa.nota, por: 'ENC07', por_nombre: null, at: causa.at }] }),
    turno('3', 'B', 10000, 5000),
    turno('4', 'B', 6000, 8000),
    turno('5', 'C', 4000, 4000, { motivos: ['cajon_sin_contar'], cajon_contado: false }),
  ],
  dias: [{ fecha: '2026-11-20', warehouse_code: '07', turnos: 5, cuadran: 1, por_justificar: 3, en_seguimiento: 1, cerrados: 0, revisado: null }],
  cajeras: [
    cajera('A', { retirado_kepler: 43000, retiros_contados: 8000, retiros_diferencia: -35000, retiros_descuadre: 35000, turnos_descuadre: 2,
      motivos: { retiros_sin_contar: 2, retiros_de_mas: 0, cajon_sin_contar: 1 } }),
    cajera('B', { retirado_kepler: 16000, retiros_contados: 13000, retiros_diferencia: -3000, retiros_descuadre: 7000, turnos_descuadre: 2, por_justificar: 2 }),
  ],
  sucursales: [],
  totales: { retirado_kepler: 63000, retiros_contados: 25000, retiros_diferencia: -38000, retiros_descuadre: 42000, turnos_descuadre: 4, cajeras_descuadre: 2, por_justificar: 3 },
});

describe('[SM.55] TiendaArqueoRevisionComponent — Retiros por revisar', () => {
  async function montar() {
    TestBed.configureTestingModule({
      imports: [TiendaArqueoRevisionComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(TiendaArqueoRevisionComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const req = http.expectOne((q) => q.url === BASE && q.method === 'GET');
    const desde = req.request.params.get('desde')!, hasta = req.request.params.get('hasta')!;
    req.flush(resp());
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, http, comp: fixture.componentInstance, desde, hasta };
  }
  const recargar = (http: HttpTestingController) => http.expectOne((q) => q.url === BASE && q.method === 'GET').flush(resp());

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('pide 7 días que terminan AYER', async () => {
    const { desde, hasta } = await montar();
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    expect(hasta < hoy).toBe(true);
    expect((Date.parse(hasta) - Date.parse(desde)) / 86400000).toBe(6);
  });

  it('⭐ arriba Kepler · Suite · Diferencia, y la diferencia dice cuánto no empata SIN signo (un + no esconde un −)', async () => {
    const { comp } = await montar();
    const k = comp.kpis();
    expect(k.map((x) => [x.label, x.value])).toEqual([['Retiros en Kepler', 63000], ['Contados en la Suite', 25000], ['Diferencia', -38000]]);
    expect(k[2].tone).toBe('bad');
    expect(k[2].sub).toContain('42,000.00 sin empatar en 4 turnos de 2 cajeras · 3 sin explicar');
  });

  it('la lista: solo turnos cuyos retiros no empatan, agrupados por cajera en el orden del servidor; el que solo dejó el cajón no sale', async () => {
    const { comp } = await montar();
    expect(comp.filas().map((f) => [f.grupo, f.caja])).toEqual([['A', '1'], ['A', '2'], ['B', '3'], ['B', '4']]);
  });

  it('la cajera trae la línea del cajón y su diferencia con signo; el aviso de la pestaña = por justificar', async () => {
    const { comp, fixture } = await montar();
    const txt = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('Además, 1 cierre sin contar el cajón');
    expect(comp.signo(2000)).toBe('+$2,000.00');
    expect(comp.signo(-3000)).toBe('-$3,000.00');
    expect(comp.aviso.tabs().find((t) => t.route === '/tienda/arqueo/revision')?.badge).toBe(3);
  });

  it('justificar manda el payload exacto, una sola vez aunque haya doble clic, y recarga del servidor', async () => {
    const { comp, http } = await montar();
    comp.abrir(comp.filas()[0]);
    comp.causa.set('no_capturado');
    comp.nota.set('  La cajera no lo capturó; está en la bóveda.  ');
    expect(comp.hasUnsavedChanges()).toBe(true);
    comp.guardar();
    comp.guardar();
    const req = http.expectOne((q) => q.url === BASE && q.method === 'POST');
    expect(req.request.body).toEqual({
      warehouse_code: '07', fecha: '2026-11-20', caja: '1', folio: '101', causa: 'no_capturado', nota: 'La cajera no lo capturó; está en la bóveda.',
    });
    req.flush(causa);
    expect(comp.peek()).toBe(false);
    recargar(http);
  });

  it('NEGATIVA: sin causa o con nota corta no se guarda (no sale ninguna petición)', async () => {
    const { comp } = await montar();
    comp.abrir(comp.filas()[0]);
    comp.nota.set('Nota suficientemente larga');
    expect(comp.valida()).toBe(false);
    comp.causa.set('no_capturado');
    comp.nota.set('corta');
    expect(comp.valida()).toBe(false);
    comp.guardar();
  });

  it('la lectura en llano dice de qué lado falta', async () => {
    const { comp } = await montar();
    const [a1, a2, , b4] = comp.filas();
    expect(comp.lectura(a1)).toBe('Kepler registró $25,000.00 en retiros y en la Suite no se contó ninguno.');
    expect(comp.lectura(a2)).toContain('faltan $10,000.00');
    expect(comp.lectura(b4)).toContain('$2,000.00 más de lo que registró Kepler');
  });

  it('si falla el guardado, lo escrito se queda y el panel sigue abierto', async () => {
    const { comp, http } = await montar();
    comp.abrir(comp.filas()[0]);
    comp.causa.set('faltante_real');
    comp.nota.set('Faltaron $500 del retiro de las 13:00.');
    comp.guardar();
    http.expectOne((q) => q.method === 'POST').flush({ message: 'sin red' }, { status: 503, statusText: 'x' });
    expect(comp.nota()).toBe('Faltaron $500 del retiro de las 13:00.');
    expect(comp.guardando()).toBe(false);
    expect(comp.peek()).toBe(true);
  });
});
