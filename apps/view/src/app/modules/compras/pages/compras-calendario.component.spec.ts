import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { CalendarioCompras, GuardarReglaRespuesta, PropuestaDiaFijo, PropuestaSinRegla, PropuestasCalendario } from '@megadulces/contracts';
import { ComprasCalendarioComponent } from './compras-calendario.component';
import { CalendarioComprasService } from '../calendario-compras.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[PQ.3.14]` «Sin regla» con el día fijo por sucursal. El fixture copia DOS propuestas medidas en prod el
 * 2026-11-21 (con claves y nombres de prueba): un proveedor que en Yurécuaro entrega un viernes sí y otro no, y uno
 * que en Morelia Abastos cae en jueves y ya tiene su regla corporativa.
 */
const HOY = '2026-11-21';
const SUC = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];

const cal = (): CalendarioCompras => ({
  hoy: HOY, reglas: [], resumen: { rezagada: 0, toca_hoy: 0, sin_ancla: 0, al_dia: 0, fuera_de_ciclo: 0 },
  zonas: [{ code: 'LP', nombre: 'La Piedad', sucursales: ['01', '02', '03', '04'] }, { code: 'MOR', nombre: 'Morelia', sucursales: ['07', '08'] }],
  sucursales: SUC, actividad_desde: '2026-09-20', fuente: 'prueba', tu_alcance: { todas: true, sucursales: SUC },
} as unknown as CalendarioCompras);

const dia = (o: Partial<PropuestaDiaFijo>): PropuestaDiaFijo => ({
  branch_code: '04', weekday: 5, every_days: 14, dias: 13, en_el_dia: 13, recientes: { en_el_dia: 5, esperadas: 6 }, ultima: '2026-11-13', ...o,
});
const prov = (o: Partial<PropuestaSinRegla>): PropuestaSinRegla => ({
  supplier_code: 'PT1', supplier_name: 'TOSTADAS DE PRUEBA', supplier_record: 'ficha_viva', proposal_status: 'propuesto',
  cycle_days_proposed: 14, next_date_proposed: '2026-11-27', rounds_12m: 20, last_order_date: '2026-11-13', branches_12m: ['02', '04'],
  reglas_vivas: 0, dias_fijos: [], ...o,
});

function montar(prop: PropuestasCalendario, vista?: string) {
  const api = {
    calendario: vi.fn(() => of(cal())), propuestas: vi.fn(() => of(prop)),
    guardarRegla: vi.fn(() => of({ id: 'R-NUEVA', accion: 'creada' } as GuardarReglaRespuesta)),
  };
  const perms = { has$: () => signal(true), has: () => true, isAdmin: () => false };
  TestBed.configureTestingModule({
    imports: [ComprasCalendarioComponent],
    providers: [
      provideRouter([]), { provide: CalendarioComprasService, useValue: api }, { provide: PermissionsService, useValue: perms },
      ...(vista ? [{ provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ vista })) } }] : []),
    ],
  });
  const f = TestBed.createComponent(ComprasCalendarioComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, el: f.nativeElement as HTMLElement, api };
}
/** El detalle que se abre tras guardar (privado: lo que el side-peek va a mostrar). */
const abiertaId = (c: ComprasCalendarioComponent) => (c as unknown as { abiertaId: () => string | null }).abiertaId();

describe('[PQ.3.14] Sin regla: el día fijo por sucursal', () => {
  const PROP: PropuestasCalendario = {
    hoy: HOY, con_regla: 1, dia_fijo: { measured: true, note: null },
    sin_regla: [prov({ dias_fijos: [dia({})] }), prov({ supplier_code: 'PX2', supplier_name: 'SIN DIA FIJO', dias_fijos: [] })],
    dia_fijo_pendiente: [prov({
      supplier_code: 'PB3', supplier_name: 'BEBIDAS DE PRUEBA', reglas_vivas: 1,
      dias_fijos: [dia({ branch_code: '08', weekday: 4, every_days: 7, dias: 43, en_el_dia: 38, recientes: { en_el_dia: 12, esperadas: 13 }, ultima: '2026-11-19' })],
    })],
  };

  it('la línea por sucursal dice el día, el periodo y lo reciente; abre la vista «Sin regla» (0 reglas)', () => {
    const { el } = montar(PROP);
    const t = el.textContent ?? '';
    expect(t).toContain('Yurécuaro: un viernes sí y otro no');
    expect(t).toContain('5 de 6 viernes en las últimas 13 semanas');
    expect(t).toContain('2 sucursales tienen día fijo');
  });

  it('el que YA tiene regla sigue en la lista con su pendiente, y NO cuenta como «sin regla»', () => {
    const { c, el } = montar(PROP);
    expect(c.sinRegla().map((p) => p.supplier_code)).toEqual(['PT1', 'PX2', 'PB3']);
    expect(el.textContent ?? '').toContain('ya tiene 1 regla; falta la de su sucursal con día fijo');
    expect(c.respuesta()).toContain('2 proveedores con compra en Kepler no tienen regla');
  });

  it('el clic abre el formulario LLENO: sucursal, «cada 14 días» desde la última de ESA sucursal, y la evidencia', () => {
    const { c, el, f } = montar(PROP);
    const btn = [...el.querySelectorAll<HTMLButtonElement>('button.cc-diafijo')].find((b) => b.textContent?.includes('Yurécuaro'));
    expect(btn?.getAttribute('aria-label')).toBe('Definir la regla de Yurécuaro: un viernes sí y otro no');
    btn?.click();
    f.detectChanges();
    expect(c.dlgRegla()).toBe(true);
    expect([c.rScope, c.rSucursal, c.rPatron, c.rCadaN, c.rProv?.ancla]).toEqual(['branch', '04', 'every_n_days', 14, '2026-11-13']);
    expect(c.rEvidencia).toContain('13 de los 13 días con orden o entrada de los últimos 12 meses cayeron en viernes');
    expect(c.problemaRegla()).toBeNull();
    expect(c.vistaPrevia().startsWith('vie 27 nov')).toBe(true);
  });

  it('cada semana se arma como «días de la semana» con ese día marcado', () => {
    const { c } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.dia_fijo_pendiente[0], PROP.dia_fijo_pendiente[0].dias_fijos[0]);
    expect([c.rScope, c.rSucursal, c.rPatron, c.rSemana.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)]).toEqual(['branch', '08', 'weekdays', [4]]);
  });

  it('NEGATIVA: abrir otra regla después limpia la evidencia (no se queda pegada a otro proveedor)', () => {
    const { c } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.sin_regla[0], PROP.sin_regla[0].dias_fijos[0]);
    c.abrirReglaDePropuesta(PROP.sin_regla[1]);
    expect(c.rEvidencia).toBeNull();
    expect(c.rScope).toBe('corporate');
  });

  it('aceptar desde «Sin regla» NO abre el detalle encima de la lista, y el aviso dice DÓNDE quedó (prueba visual 2026-11-21)', () => {
    const { c, api } = montar(PROP);
    c.abrirReglaDeDiaFijo(PROP.sin_regla[0], PROP.sin_regla[0].dias_fijos[0]);
    c.guardarRegla();
    expect(api.guardarRegla).toHaveBeenCalledTimes(1);
    expect(c.dlgRegla()).toBe(false);
    expect(abiertaId(c)).toBeNull();
    expect(c.aviso()).toBe('Regla creada: TOSTADAS DE PRUEBA en Yurécuaro, cada 14 días.');
  });

  it('NEGATIVA: desde «Reglas» guardar SÍ abre el detalle de la regla (el cambio es sólo de «Sin regla»)', () => {
    const { c } = montar(PROP, 'reglas');
    expect(c.vista()).toBe('reglas');
    c.abrirReglaDeDiaFijo(PROP.dia_fijo_pendiente[0], PROP.dia_fijo_pendiente[0].dias_fijos[0]);
    c.guardarRegla();
    expect(abiertaId(c)).toBe('R-NUEVA');
    expect(c.aviso()).toBe('Regla creada: BEBIDAS DE PRUEBA en Morelia Abastos, cada jueves.');
  });

  it('NEGATIVA: sin medir el día fijo, la pantalla lo DICE (no lo pinta como «ninguno»)', () => {
    const { el } = montar({ ...PROP, dia_fijo: { measured: false, note: 'No se pudo leer la actividad de Kepler de 12 meses: el día fijo por sucursal no se midió.' }, sin_regla: PROP.sin_regla.map((p) => ({ ...p, dias_fijos: [] })), dia_fijo_pendiente: [] });
    const t = el.textContent ?? '';
    expect(t).toContain('el día fijo por sucursal no se midió');
    expect(t).toContain('Las propuestas por ciclo sí están');
    expect(t).not.toContain('tienen día fijo');
  });
});
