import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OPCIONES_PERIODO, fechaCortaPeriodo, periodoDe, textoPeriodo } from './periodo-ficha';
import { PeriodoFichaComponent } from './components/periodo-ficha.component';

describe('[PF.23] periodo de la ficha — funciones', () => {
  const HOY = new Date(2026, 10, 4);

  it('los presets salen del util compartido (el mismo «Este mes» de toda la app)', () => {
    expect(periodoDe('mes', null, HOY)).toEqual({ desde: '2026-11-01', hasta: '2026-11-04' });
    expect(periodoDe('mes_prev', null, HOY)).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(periodoDe('d90', null, HOY)).toEqual({ desde: '2026-08-07', hasta: '2026-11-04' });
    expect(periodoDe('anio_prev', null, HOY)).toEqual({ desde: '2025-01-01', hasta: '2025-12-31' });
    expect(OPCIONES_PERIODO.map((o) => o.label)).toEqual(['Este mes', 'Mes pasado', 'Últimos 90 días', 'Este año', 'Año pasado', 'Elegir fechas']);
  });

  it('«Elegir fechas»: con dos, el rango; con una, ese día', () => {
    expect(periodoDe('otro', [new Date(2025, 5, 1), new Date(2025, 5, 30)])).toEqual({ desde: '2025-06-01', hasta: '2025-06-30' });
    expect(periodoDe('otro', [new Date(2025, 5, 1), null])).toEqual({ desde: '2025-06-01', hasta: '2025-06-01' });
  });

  it('⛔ [negativa] «Elegir fechas» sin elegir nada no es un periodo (no se manda nada)', () => {
    expect(periodoDe('otro', null)).toBeNull();
    expect(periodoDe('otro', [])).toBeNull();
    expect(periodoDe('otro', [null, null])).toBeNull();
  });

  it('el texto del periodo, sin pasar por Date (la fecha de calendario no tiene zona)', () => {
    expect(textoPeriodo({ desde: '2025-01-01', hasta: '2025-12-31' })).toBe('del 1 ene 2025 al 31 dic 2025');
    expect(textoPeriodo({ desde: '2026-11-04', hasta: '2026-11-04' })).toBe('el 4 nov 2026');
    expect(textoPeriodo(null)).toBe('');
    expect(fechaCortaPeriodo('basura')).toBe('');
  });
});

describe('[PF.23] PeriodoFichaComponent (calendario)', () => {
  const montarCal = async (porOmision: 'mes' | 'd90' = 'mes') => {
    await TestBed.configureTestingModule({ imports: [PeriodoFichaComponent] }).compileComponents();
    const fix = TestBed.createComponent(PeriodoFichaComponent);
    fix.componentRef.setInput('porOmision', porOmision);
    fix.detectChanges();
    await Promise.resolve();
    fix.detectChanges();
    const emitidos: unknown[] = [];
    fix.componentInstance.cambio.subscribe((p) => emitidos.push(p));
    return { fix, c: fix.componentInstance, emitidos };
  };
  const iso = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);

  it('⭐ es un calendario de rango y al abrir MUESTRA el periodo de por omisión (nunca un campo vacío)', async () => {
    const { fix, c } = await montarCal('d90');
    expect(fix.nativeElement.querySelector('p-datepicker')).not.toBeNull();
    expect(fix.nativeElement.querySelector('p-select')).toBeNull();
    const d90 = periodoDe('d90', null)!;
    expect(c.rango()!.map(iso)).toEqual([d90.desde, d90.hasta]);
  });

  it('⭐ elegir dos fechas y cerrar emite el rango; «Limpiar» vuelve al de por omisión (null)', async () => {
    const { c, emitidos } = await montarCal();
    c.rango.set([new Date(2025, 0, 1), new Date(2025, 11, 31)]);
    c.aplicar();
    expect(emitidos).toEqual([{ desde: '2025-01-01', hasta: '2025-12-31' }]);
    c.limpiar();
    expect(emitidos[1]).toBeNull();
    const mes = periodoDe('mes', null)!;
    expect(c.rango()!.map(iso)).toEqual([mes.desde, mes.hasta]);
  });

  it('una sola fecha es ese día', async () => {
    const { c, emitidos } = await montarCal();
    c.rango.set([new Date(2025, 5, 3), null]);
    c.aplicar();
    expect(emitidos).toEqual([{ desde: '2025-06-03', hasta: '2025-06-03' }]);
  });

  it('⛔ [negativa] cerrar sin elegir, o con el MISMO periodo, no emite nada (no recarga en balde)', async () => {
    const { c, emitidos } = await montarCal();
    c.rango.set(null);
    c.aplicar();
    const mes = periodoDe('mes', null)!;
    c.rango.set([new Date(mes.desde + 'T00:00:00'), new Date(mes.hasta + 'T00:00:00')]);
    c.aplicar();
    c.limpiar(); // ya estaba en el de por omisión
    expect(emitidos).toEqual([]);
  });
});
