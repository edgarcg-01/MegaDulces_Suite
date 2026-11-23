import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrTipoIncidenciaDto } from '@megadulces/contracts';
import { RhService } from '../rh.service';
import { formNuevo } from '../incidencia-captura';
import { RhCapturaIncidenciaComponent } from './rh-captura-incidencia.component';

/**
 * `[RH.18.4]` La captura con la propuesta A: lo que más usan para el día, en botones con el nombre de Mega Talento; un
 * toque elige (nada viene elegido); «Tráfico» trae su motivo; «quién lo autorizó» recuerda el último; los 19 siguen en
 * «Otro tipo…». Sin sugeridos (el panel de Incidencias), la lista de siempre.
 */
const TIPOS: HrTipoIncidenciaDto[] = [
  { tipo: 'vacaciones', etiqueta: 'Vacaciones', codigo: 'VAC', excusaFalta: true },
  { tipo: 'permiso_sin_goce', etiqueta: 'Permiso sin goce de sueldo', codigo: 'PSG', excusaFalta: true },
  { tipo: 'incapacidad', etiqueta: 'Incapacidad', codigo: 'INC', excusaFalta: true },
  { tipo: 'otros', etiqueta: 'Otros', codigo: 'OTR', excusaFalta: true },
  { tipo: 'horario_distinto', etiqueta: 'Horario distinto', codigo: 'HD', excusaFalta: false },
];
const LLAVE = 'rh.incidencias.ultimoAutorizo';

describe('[RH.18.4] RhCapturaIncidenciaComponent (propuesta A)', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  async function montar(sugeridos: string[]) {
    api = { capturar: vi.fn(() => of({ id: 'i-1', status: 'capturada' })), bancoHorasExtra: vi.fn(() => of({ personas: [] })) };
    await TestBed.configureTestingModule({
      imports: [RhCapturaIncidenciaComponent],
      providers: [{ provide: RhService, useValue: api }],
    }).compileComponents();
    const fix = TestBed.createComponent(RhCapturaIncidenciaComponent);
    fix.componentRef.setInput('site', 'PH');
    fix.componentRef.setInput('tipos', TIPOS);
    fix.componentRef.setInput('sugeridos', sugeridos);
    fix.componentRef.setInput('persona', 'Prueba Dos Ejemplo');
    fix.componentInstance.form.set({ ...formNuevo('118', '2026-10-06'), entrada: '08:25', salida: '18:00' });
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix;
  }
  const el = (fix: { nativeElement: unknown }) => fix.nativeElement as HTMLElement;
  const botones = (fix: { nativeElement: unknown }) => Array.from(el(fix).querySelectorAll('button.ci-boton'))
    .map((b) => b.textContent?.replace(/\s+/g, ' ').trim());

  beforeEach(() => { try { localStorage.removeItem(LLAVE); } catch { /* sin almacenamiento */ } });
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ los del día en botones, con el nombre que usan arriba y el tipo oficial abajo; los 19 en «Otro tipo…»', async () => {
    const fix = await montar(['permiso_sin_goce', 'incapacidad', 'otros', 'vacaciones', 'horario_distinto']);
    expect(botones(fix)).toEqual([
      'Personal Permiso sin goce de sueldo', 'Cita médica Incapacidad', 'No registrada Otros', 'Vacaciones',
      'Otro tipo… los 19, se buscan tecleando',
    ]);
    // ⛔ Nada viene elegido, y sin la lista no hay selector.
    expect(el(fix).querySelector('.ci-boton.sel')).toBeNull();
    expect(el(fix).querySelector('p-select')).toBeNull();
    (Array.from(el(fix).querySelectorAll('button.ci-boton')).at(-1) as HTMLButtonElement).click();
    fix.detectChanges();
    expect(el(fix).querySelector('p-select')).not.toBeNull();
  });

  it('⭐ «Tráfico» en un toque: Horario distinto, con «Tráfico» de motivo y quien autorizó la última vez', async () => {
    localStorage.setItem(LLAVE, 'Jefa de Prueba');
    const fix = await montar(['horario_distinto', 'otros']);
    (el(fix).querySelector('button.ci-boton') as HTMLButtonElement).click();
    fix.detectChanges();
    const f = fix.componentInstance.form()!;
    expect([f.incident_type, f.reason, f.authorized_by_name]).toEqual(['horario_distinto', 'Tráfico', 'Jefa de Prueba']);
    expect(el(fix).querySelector('button.ci-boton')?.getAttribute('aria-pressed')).toBe('true');
    // Lo que ya escribieron no se pisa.
    fix.componentInstance.form.update((x) => (x ? { ...x, reason: 'Junta', authorized_by_name: 'Otra Persona', incident_type: '' } : x));
    fix.componentInstance.elegir('horario_distinto');
    expect([fix.componentInstance.form()!.reason, fix.componentInstance.form()!.authorized_by_name]).toEqual(['Junta', 'Otra Persona']);
  });

  it('⭐ al guardar se recuerda quién autorizó; ⛔ un tipo sin autorización no lo pisa', async () => {
    const fix = await montar(['horario_distinto', 'otros']);
    fix.componentInstance.form.update((x) => (x ? { ...x, incident_type: 'horario_distinto', reason: 'Tráfico', authorized_by_name: 'Jefa Nueva' } : x));
    fix.componentInstance.guardar();
    expect(api['capturar']).toHaveBeenCalledWith(expect.objectContaining({ incident_type: 'horario_distinto', reason: 'Tráfico', authorized_by_name: 'Jefa Nueva' }));
    expect(localStorage.getItem(LLAVE)).toBe('Jefa Nueva');
    fix.componentInstance.form.set({ ...formNuevo('118', '2026-10-06'), incident_type: 'otros', note: 'Vino y no checó', authorized_by_name: 'Nadie' });
    fix.componentInstance.guardar();
    expect(localStorage.getItem(LLAVE)).toBe('Jefa Nueva');
  });

  it('⛔ NEGATIVA — sin sugeridos (el panel de Incidencias) no hay botones: la lista de siempre', async () => {
    const fix = await montar([]);
    expect(botones(fix)).toEqual([]);
    expect(el(fix).querySelector('p-select')).not.toBeNull();
  });
});
