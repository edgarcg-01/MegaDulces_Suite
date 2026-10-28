import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';
import { Observable, of, throwError } from 'rxjs';
import type { ArqueoCajasConteo, ArqueoCajasResp, ArqueoCajasTurno } from '@megadulces/contracts/http/arqueo-cajas';
import { ArqueoService } from '../arqueo.service';
import { ArqueoCajasComponent } from './arqueo-cajas.component';

/**
 * [SM.48] «Sucursales y sus cajas»: lo que la vista DICE con datos reales de prod
 * (26-oct-2026, Canindo y 8 Esquinas).
 */
const conteo = (id: string, tipo: string, hora: string, total: number, den: Record<string, number>, extra: Partial<ArqueoCajasConteo> = {}): ArqueoCajasConteo => ({
  id, tipo, secuencia: 1, caja: '1', hora, captured_at: '2026-10-26T18:00:00Z', total,
  usuario: 'DULCE', usuario_nombre: null, denominations: den, medios: null, nota: null, incidencia_tipo: null,
  motivo: null, concepto: null, route_code: null, cash_cut_folio: null, validado_por: null, validado_at: null, ligado: 'hora', ...extra,
});

const turno = (over: Partial<ArqueoCajasTurno>): ArqueoCajasTurno => ({
  caja: '1', folio: '70', cajero_code: '50C01', cajero_nombre: 'DULCE MARIA CISNEROS GONZALEZ',
  hora_apertura: '06:15:40', hora_cierre: '17:22:47', abierto: false, esperado: 73131.88, retirado_kepler: 68280,
  retiros: [], cierres: [], relevos: [], retiros_contados: 0, retiros_estado: 'sin_retiros', retiros_diferencia: 0,
  cuadre: { medible: false, motivo: 'sin_conteo', diferencia: null, retiros_sin_verificar: 0, contado_total: null },
  ...over,
});

// Canindo caja 1: faltan $1,380 de retiros por contar → POR REVISAR.
const t70 = turno({
  retiros: [conteo('r1', 'retiro', '11:45:00', 18800, { 1000: 1, 500: 18, 200: 34, 100: 20 }), conteo('r2', 'retiro', '13:51:00', 18100, { 500: 21, 200: 18, 100: 40 })],
  cierres: [conteo('c1', 'cierre', '17:30:00', 4852, { 500: 1, 10: 76, '20m': 3 })],
  retiros_contados: 36900, retiros_estado: 'faltan', retiros_diferencia: -1380, retirado_kepler: 38280,
  cuadre: { medible: true, motivo: null, diferencia: -0.12, retiros_sin_verificar: 1380, contado_total: 43132 },
});
// Canindo caja 5: todo cuadra → desglose CERRADO por defecto.
const t42 = turno({
  caja: '5', folio: '42', cajero_code: '54TYSL', cajero_nombre: 'TANIA YAZMIN SANCHEZ LEAL', esperado: 17182.31, retirado_kepler: 17000,
  retiros: [conteo('r9', 'retiro', '13:19:00', 17000, { 500: 24, 200: 18, 100: 14 }, { caja: '5' })],
  cierres: [conteo('c9', 'cierre', '14:25:00', 182.5, { 100: 1, 50: 1, 1: 12, '0.5': 1 }, { caja: '5' })],
  retiros_contados: 17000, retiros_estado: 'cuadra', retiros_diferencia: 0,
  cuadre: { medible: true, motivo: null, diferencia: -0.19, retiros_sin_verificar: 0, contado_total: 17182.5 },
});

const RESP: ArqueoCajasResp = {
  fecha: '2026-10-26', umbral: 50,
  sucursales: [
    { warehouse_code: '03', nombre: '8 Esquinas', turnos: [turno({ folio: '226', caja: '4', retiros_contados: 19154, retirado_kepler: 11500, retiros_estado: 'de_mas', retiros_diferencia: 7654 })], sin_turno: [], sin_caja: [] },
    { warehouse_code: '06', nombre: 'Canindo', turnos: [t70, t42], sin_turno: [],
      sin_caja: [conteo('v1', 'rv', '16:39:00', 24173, { 500: 40 }, { caja: 'RV', route_code: '5V001' })] },
  ],
};

class Stub {
  resp: Observable<ArqueoCajasResp> = of(RESP);
  pedidas: string[] = [];
  validados: string[] = [];
  cajas(fecha: string) { this.pedidas.push(fecha); return this.resp; }
  validar(id: string) { this.validados.push(id); return of({}); }
}

describe('ArqueoCajasComponent · [SM.48] sucursales y sus cajas', () => {
  let fix: ComponentFixture<ArqueoCajasComponent>;
  let cmp: ArqueoCajasComponent;
  let svc: Stub;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent ?? '';
  const tick = async (): Promise<void> => { await fix.whenStable(); fix.detectChanges(); };

  /** Abre con clic todas las cajas de la sucursal visible (nacen minimizadas). */
  const abrirCajas = async () => {
    for (const b of Array.from(el().querySelectorAll<HTMLButtonElement>('button.ac-caja-h'))) b.click();
    await tick();
  };

  const montar = async (s: Stub = new Stub()) => {
    svc = s;
    await TestBed.configureTestingModule({
      imports: [ArqueoCajasComponent],
      providers: [MessageService, { provide: ArqueoService, useValue: svc }],
    }).compileComponents();
    fix = TestBed.createComponent(ArqueoCajasComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await tick();
  };

  it('⭐ pide el día de hoy y nombra las sucursales (nunca «06»)', async () => {
    await montar();
    const hoy = new Date();
    const ymd = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
    expect(svc.pedidas).toEqual([ymd]);
    const sucs = Array.from(el().querySelectorAll('.ac-suc-n')).map((x) => x.textContent?.trim());
    expect(sucs).toEqual(['8 Esquinas', 'Canindo']);
  });

  it('⭐ cajera con nombre y usuario de Kepler; estados dicen cuánto y de qué', async () => {
    await montar();
    cmp.activa.set('06'); await tick();
    await abrirCajas();
    expect(texto()).toContain('Dulce Maria Cisneros Gonzalez');
    expect(texto()).toContain('50C01');
    expect(texto()).toContain('Faltan $1,380.00 por contar');
    // Q.2: el cuadre se explica, y dice que hubo retiros que se tomaron de Kepler.
    expect(texto()).toContain('$1,380.00 de retiros que nadie contó');
    expect(texto()).toContain('Cuadran con Kepler');
  });

  it('⭐ todo nace MINIMIZADO: la caja es su renglón (con su estado) y se abre con clic; el desglose, aparte', async () => {
    await montar();
    cmp.activa.set('06'); await tick();
    // Cerrado: se ve el renglón de cada caja con su estado, nada de sus turnos.
    const renglones = Array.from(el().querySelectorAll('button.ac-caja-h')).map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(renglones[0]).toContain('Caja 1');
    expect(renglones[0]).toContain('retiros contados $36,900.00 de $38,280.00');
    expect(renglones[0]).toContain('1 por revisar');
    expect(renglones[1]).toContain('Todo cuadra');
    expect(el().querySelectorAll('.ac-turno').length).toBe(0);
    expect(el().querySelector('button.ac-caja-h')!.getAttribute('aria-expanded')).toBe('false');
    // Un clic abre la caja: sus turnos, pero el desglose sigue cerrado (ni el que hay que revisar).
    (el().querySelector('button.ac-caja-h') as HTMLButtonElement).click(); await tick();
    expect(el().querySelectorAll('.ac-turno').length).toBe(1);
    expect(el().querySelectorAll('table.ac-mx').length).toBe(0);
    // «Ver desglose» lo abre; otro clic en la caja la vuelve a cerrar.
    cmp.alternar(cmp.sucActiva()!, t70); await tick();
    expect(el().querySelectorAll('table.ac-mx').length).toBe(1);
    (el().querySelector('button.ac-caja-h') as HTMLButtonElement).click(); await tick();
    expect(el().querySelectorAll('.ac-turno').length).toBe(0);
  });

  it('⭐ el desglose: solo denominaciones usadas, billetes antes que monedas, y el total del turno', async () => {
    await montar();
    cmp.activa.set('06'); await tick();
    await abrirCajas();
    cmp.alternar(cmp.sucActiva()!, t70); await tick();
    const mx = el().querySelector('table.ac-mx')!;
    const filas = Array.from(mx.querySelectorAll('tbody th[scope="row"]')).map((x) => x.textContent?.trim());
    expect(filas).toEqual(['$1,000', '$500', '$200', '$100', 'Total billetes', '$20', '$10', 'Total monedas', 'Total']);
    // El $20 que aparece es la MONEDA ('20m'), debajo de Monedas — no se cuela en billetes.
    expect(mx.textContent).toContain('Retiro 1');
    expect(mx.textContent).toContain('Cierre (cajón)');
    expect(mx.textContent).toContain('$41,752.00'); // 18,800 + 18,100 + 4,852
  });

  it('las rutas van en su bloque y no se cuentan en ninguna caja', async () => {
    await montar();
    cmp.activa.set('06'); await tick();
    expect(texto()).toContain('RV · ruta 5V001');
    const sum = el().querySelector('.ac-sum')!.textContent!;
    expect(sum).not.toContain('24,173');
  });

  it('el filtro «por revisar» deja solo lo que hay que mirar', async () => {
    await montar();
    cmp.activa.set('06'); cmp.filtro.set('pend'); await tick();
    const cajas = Array.from(el().querySelectorAll('.ac-caja-n')).map((x) => x.textContent?.trim());
    expect(cajas).toEqual(['Caja 1']);
  });

  it('⭐ sin botón de validar (pedido de la operación); lo ya validado se sigue diciendo', async () => {
    const s = new Stub();
    const validado = { ...t70.retiros[0], validado_por: 'enc_canindo', validado_at: '2026-10-26T19:00:00Z' };
    s.resp = of({ ...RESP, sucursales: RESP.sucursales.map((x) => x.warehouse_code !== '06' ? x
      : { ...x, turnos: [{ ...t70, retiros: [validado, t70.retiros[1]] }, t42] }) });
    await montar(s);
    cmp.activa.set('06'); await tick();
    await abrirCajas();
    cmp.alternar(cmp.sucActiva()!, cmp.sucActiva()!.turnos[0]); await tick();
    const botones = Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(botones).not.toContain('Validar');
    expect(texto()).toContain('enc_canindo');
    expect(svc.validados).toEqual([]);
  });

  it('⭐ error ≠ vacío: un fallo se dice como fallo', async () => {
    const s = new Stub();
    s.resp = throwError(() => ({ error: { message: 'boom' } }));
    await montar(s);
    expect(cmp.error()).toBe('boom');
    expect(texto()).not.toContain('Sin turnos ni conteos ese día');
  });

  it('[SM.49] el encabezado del retiro dice su concepto; los viejos, sin él', async () => {
    await montar();
    const conConcepto = { ...t70.retiros[1], concepto: 'pago_proveedor' };
    const viejo = t70.retiros[0];
    const todos = [viejo, conConcepto];
    expect(cmp.titulo(conConcepto, todos)).toBe('Retiro 2 · Pago a proveedor');
    expect(cmp.titulo(viejo, todos)).toBe('Retiro 1');
  });

  it('⭐ salidas por concepto: por sucursal y por turno, sin abrir el desglose', async () => {
    const s = new Stub();
    const r = (id: string, total: number, concepto: string | null) => conteo(id, 'retiro', '12:00:00', total, { 500: 1 }, { concepto });
    const t = { ...t70, retiros: [r('a', 18800, 'retiro_caja'), r('b', 15000, 'pago_nomina'), r('c', 3200, 'pago_proveedor'), r('d', 900, null)] };
    s.resp = of({ ...RESP, sucursales: RESP.sucursales.map((x) => x.warehouse_code !== '06' ? x : { ...x, turnos: [t] }) });
    await montar(s);
    cmp.activa.set('06'); await tick();
    const chips = Array.from(el().querySelectorAll('.ac-chip')).map((c) => c.textContent?.replace(/s+/g, ' ').trim());
    expect(chips).toEqual(['Retiro de caja $18,800.00', 'Pago de nómina $15,000.00', 'Pago a proveedor $3,200.00', 'Sin concepto $900.00']);
    await abrirCajas();
    expect(el().querySelector('.ac-conc')?.textContent).toContain('Pago de nómina $15,000.00');
  });

  it('cambiar la fecha la vuelve a pedir', async () => {
    await montar();
    cmp.elegirFecha(new Date(2026, 9, 26)); await tick();
    expect(svc.pedidas[svc.pedidas.length - 1]).toBe('2026-10-26');
  });
});
