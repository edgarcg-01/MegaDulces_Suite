import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrTipoIncidenciaDto } from '@megadulces/contracts';
import { RhService } from '../rh.service';
import { TRABAJO_CORRIDO, formNuevo } from '../incidencia-captura';
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

  it('⭐ [RH.18.6] todo en uno: los del día grandes, con su nombre, y enseguida TODOS los demás tipos; nada viene elegido', async () => {
    const fix = await montar(['permiso_sin_goce', 'incapacidad', 'otros', 'vacaciones']);
    expect(botones(fix)).toEqual(['Personal Permiso sin goce de sueldo', 'Cita médica Incapacidad', 'No registrada Otros', 'Vacaciones']);
    // Los demás, a la vista y con su nombre de Mega Talento si lo tienen; sin «Otro tipo…» ni lista que abrir.
    const resto = () => Array.from(el(fix).querySelectorAll('button.ci-chip'));
    expect(resto().map((b) => b.textContent?.trim())).toEqual(['Horario distinto · tráfico']);
    expect(el(fix).textContent).not.toContain('Otro tipo');
    expect(el(fix).querySelector('p-select')).toBeNull();
    expect(el(fix).querySelector('.sel')).toBeNull();
    // Uno de los demás también se elige en un toque (y Tráfico trae su motivo).
    (resto()[0] as HTMLButtonElement).click();
    fix.detectChanges();
    expect([fix.componentInstance.form()?.incident_type, fix.componentInstance.form()?.reason]).toEqual(['horario_distinto', 'Tráfico']);
    expect(resto()[0].getAttribute('aria-pressed')).toBe('true');
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

describe('[RH.19.1] «Trabajó corrido» en la captura', () => {
  const CON_COMIDA: HrTipoIncidenciaDto[] = [...TIPOS, { tipo: 'comida_distinta', etiqueta: 'Comida distinta', codigo: 'CD', excusaFalta: false }];
  async function montar(alias: Record<string, string>) {
    await TestBed.configureTestingModule({
      imports: [RhCapturaIncidenciaComponent],
      providers: [{ provide: RhService, useValue: { capturar: vi.fn(() => of({ id: 'i-1', status: 'capturada' })), bancoHorasExtra: vi.fn(() => of({ personas: [] })) } }],
    }).compileComponents();
    const fix = TestBed.createComponent(RhCapturaIncidenciaComponent);
    fix.componentRef.setInput('site', 'PH');
    fix.componentRef.setInput('tipos', CON_COMIDA);
    fix.componentRef.setInput('sugeridos', ['comida_distinta', 'horario_distinto']);
    fix.componentRef.setInput('alias', alias);
    fix.componentInstance.form.set({ ...formNuevo('118', '2026-10-06'), entrada: '08:00', salida: '18:00' });
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el botón dice «Trabajó corrido»; elegirlo pone 0 min de comida y deja el motivo VACÍO (es el justificante)', async () => {
    const fix = await montar({ comida_distinta: TRABAJO_CORRIDO });
    const b = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button.ci-boton'))[0] as HTMLButtonElement;
    expect(b.textContent?.replace(/\s+/g, ' ').trim()).toBe('Trabajó corrido Comida distinta');
    b.click();
    fix.detectChanges();
    const f = fix.componentInstance.form()!;
    expect([f.incident_type, f.minutos, f.reason]).toEqual(['comida_distinta', '0', '']);
    expect(fix.componentInstance.resumen()).toContain('Trabajó corrido');
  });

  it('⛔ NEGATIVA — sin el alias del día, «Comida distinta» no inventa los 0 minutos', async () => {
    const fix = await montar({});
    fix.componentInstance.elegir('comida_distinta');
    expect(fix.componentInstance.form()!.minutos).toBe('');
  });
});
