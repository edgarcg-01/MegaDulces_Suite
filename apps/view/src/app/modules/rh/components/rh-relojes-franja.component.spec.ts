import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { HrRelojEstadoDto } from '@megadulces/contracts';
import { RhRelojesFranjaComponent } from './rh-relojes-franja.component';

/**
 * `[RH.1.7b]` La franja de relojes con el formato de Mega Talento. Lo que se defiende: el aviso «este sitio no ha
 * reportado» se ve AUNQUE la franja esté plegada (es lo que impide leer los números como de hoy), y sólo cuando
 * TODOS los relojes del sitio están sin señal.
 */
const r = (o: Partial<HrRelojEstadoDto>): HrRelojEstadoDto => ({
  serie: 'S1', sucursalId: 'ph', alias: 'Entrada PH', modo: 'agente', ip: '10.0.0.5', nota: '', ultimaSenal: null, ultimaChecada: null,
  ultimoBackfill: null, segundosSinSenal: 30, logsEnReloj: 100, logsEnBase: 100, desfaseRelojSeg: 0, ultimoError: '', agenteVersion: '',
  agenteHost: '', semaforo: 'ok', ...o,
});

@Component({
  standalone: true,
  imports: [RhRelojesFranjaComponent],
  template: `<app-rh-relojes-franja [relojes]="relojes()" [sitio]="sitio()" [abiertaAlInicio]="abierta" [editable]="editable" (editar)="editados.push($event)" />`,
})
class HostComponent {
  relojes = signal<HrRelojEstadoDto[]>([]);
  sitio = signal<string | null>('ph');
  abierta = false;
  editable = false;
  editados: string[] = [];
}

describe('[RH.1.7b] RhRelojesFranjaComponent', () => {
  let fix: ComponentFixture<HostComponent>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';

  async function render(relojes: HrRelojEstadoDto[], o: { abierta?: boolean; editable?: boolean; sitio?: string | null } = {}) {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fix = TestBed.createComponent(HostComponent);
    fix.componentInstance.relojes.set(relojes);
    fix.componentInstance.sitio.set(o.sitio === undefined ? 'ph' : o.sitio);
    fix.componentInstance.abierta = !!o.abierta;
    fix.componentInstance.editable = !!o.editable;
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('plegada: una línea con el peor estado y el resumen, sin la lista', async () => {
    await render([r({}), r({ serie: 'S2', semaforo: 'atrasado' })]);
    expect(el().querySelector('.rf')?.getAttribute('data-estado')).toBe('atrasado');
    expect(texto()).toContain('1 al día · 1 atrasado');
    expect(el().querySelector('.rf-lista')).toBeNull();
  });

  it('⭐ el aviso «no ha reportado» se ve aunque esté plegada', async () => {
    await render([r({ semaforo: 'mudo', segundosSinSenal: null })]);
    expect(el().querySelector('.rf-lista')).toBeNull();
    expect(el().querySelector('.rf-alerta')?.textContent).toContain('no ha reportado');
  });

  it('⛔ NEGATIVA — con un reloj del sitio vivo, no hay aviso', async () => {
    await render([r({ semaforo: 'mudo' }), r({ serie: 'S2', semaforo: 'ok' })]);
    expect(el().querySelector('.rf-alerta')).toBeNull();
  });

  it('⛔ NEGATIVA — sin sitio elegido (la pantalla de Relojes) no se acusa a ningún sitio', async () => {
    await render([r({ semaforo: 'mudo' })], { sitio: null });
    expect(el().querySelector('.rf-alerta')).toBeNull();
  });

  it('abierta: un renglón por reloj con desde cuándo, hora corrida, faltantes, push y motivo', async () => {
    await render([
      r({ alias: 'Corporativo', desfaseRelojSeg: 420, logsEnReloj: 5000, logsEnBase: 4988 }),
      r({ serie: 'S2', alias: 'Comedor', modo: 'push', semaforo: 'mudo', segundosSinSenal: null, ultimoError: 'No responde el puerto 4370' }),
    ], { abierta: true });
    const filas = Array.from(el().querySelectorAll('.rf-rel')).map((x) => x.textContent ?? '');
    expect(filas[0]).toContain('Corporativo');
    expect(filas[0]).toContain('hace 30 s');
    expect(filas[0]).toContain('hora corrida +7 min');
    expect(filas[0]).toContain('faltan 12');
    expect(filas[1]).toContain('push');
    expect(filas[1]).toContain('nunca ha reportado');
    expect(filas[1]).toContain('No responde el puerto 4370');
    expect(texto()).toContain('1 con la hora corrida');
  });

  it('⛔ NEGATIVA — «completo» no se pinta como chip, y sin permiso no hay «Editar»', async () => {
    await render([r({ logsEnReloj: 100, logsEnBase: 100 })], { abierta: true });
    expect(texto()).not.toContain('completo');
    expect(el().querySelector('.rf-editar')).toBeNull();
  });

  it('con permiso, «Editar» avisa qué reloj', async () => {
    await render([r({ serie: 'S9' })], { abierta: true, editable: true });
    (el().querySelector('.rf-editar') as HTMLButtonElement).click();
    expect(fix.componentInstance.editados).toEqual(['S9']);
  });

  it('el encabezado abre y cierra con el teclado (es un botón)', async () => {
    await render([r({})]);
    const head = el().querySelector('.rf-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    fix.detectChanges();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(el().querySelector('.rf-lista')).not.toBeNull();
  });
});
