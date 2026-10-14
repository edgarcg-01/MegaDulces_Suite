import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { HrCandidatoFichaDto, HrCasilleroDto, HrDocumentoDto } from '@megadulces/contracts';
import { ReclutamientoService } from '../reclutamiento.service';
import { RhCandidatoFichaComponent, expedienteDe, historiaDe } from './rh-candidato-ficha.component';

/**
 * `[RH.2.3]` La ficha del candidato. Lo que se defiende: la historia junta los dos registros de una fusión, el
 * expediente dice qué falta, la lista negra pide motivo antes de salir, y quien no gestiona no ve cómo cambiar nada.
 */
const CASILLEROS: HrCasilleroDto[] = [
  { key: 'cv', label: 'Currículum vitae', obligatorio: true },
  { key: 'ine', label: 'INE', obligatorio: true },
  { key: 'licencia', label: 'Licencia de manejo', obligatorio: false },
];
const doc = (o: Partial<HrDocumentoDto>): HrDocumentoDto => ({
  llave: 'k', slot: 'cv', file_name: 'cv.pdf', content_type: 'application/pdf', url: 'https://firmada/k', en_bucket: true, origen: 'suite',
  recibido_en: null, subido_por_nombre: 'rh', vigente: true, retired_at: null, retired_by_name: null, retire_reason: null, ...o,
});
const ID = 'c0000000-0000-4000-8000-000000000001';
const OTRO = 'c0000000-0000-4000-8000-000000000002';
function ficha(o: Partial<HrCandidatoFichaDto> = {}): HrCandidatoFichaDto {
  return {
    id: ID, full_name: 'Ana Prueba', phone: '3511234567', phone_key: '3511234567', city_branch: 'Zamora', position_interest: 'Cajera',
    stage: 'entrevista_rh', stage_raw: 'entrevista_rh', source: 'portal', traffic_light: null, has_cv: true, no_rehire: false, is_spam: false,
    created_at: '2026-10-01T15:00:00Z', last_activity_at: null, deleted_at: null, deletion_reason: null,
    email: null, legacy_portal_id: null, job_posting_id: null, origin: null, bot_state: null, commute_time: null, availability: null,
    previous_employer: null, desired_salary: null, rfc: null, nss: null, relative_in_company: null, rehire_note: null, cv_url: null,
    cv_back_url: null, cv_format: null, license_url: null, documents: [doc({})], documentos_faltantes: ['ine'], requested_documents: [],
    application: null, aptitude_rubric: null, aptitude_eval: null, portal_data: {}, no_rehire_reason: null, no_rehire_by_name: null,
    no_rehire_at: null, spam_reason: null, spam_by_name: null, spam_at: null, merged_into_id: null, absorbidos: [],
    transiciones: [{ id: 't1', candidate_id: ID, stage_from: 'filtro_inicial', stage_to: 'entrevista_rh', hours_in_from: 5.5, changed_by_name: 'rh', changed_at: '2026-10-02T15:00:00Z' }],
    eventos: [{ id: 'e1', candidate_id: OTRO, event_type: 'contacto', channel: 'whatsapp', note: 'le escribió el bot', actor_name: 'bot', occurred_at: '2026-10-01T16:00:00Z' }],
    mismo_telefono: [], ...o,
  };
}

describe('[RH.2.3] reglas de la ficha', () => {
  it('la historia junta etapas y eventos, del más reciente al más viejo, y marca lo del registro fusionado', () => {
    const h = historiaDe(ficha());
    expect(h.map((x) => [x.tipo, x.texto, x.deOtroRegistro])).toEqual([
      ['etapa', 'Filtro Inicial → Entrevista Orientación Conductual', false],
      ['evento', 'Contacto', true],
    ]);
    expect(h[0].detalle).toBe('5.5 h en la etapa anterior');
  });

  it('el expediente: por casillero, lo que falta, lo que no tiene casillero y lo retirado aparte', () => {
    const e = expedienteDe([doc({}), doc({ llave: 'x', slot: 'pasaporte' }), doc({ llave: 'r', slot: 'ine', vigente: false })], CASILLEROS, ['ine']);
    expect(e.filas.map((f) => [f.casillero.key, f.docs.length, f.falta])).toEqual([['cv', 1, false], ['ine', 0, true], ['licencia', 0, false]]);
    expect(e.otros.map((d) => d.llave)).toEqual(['x']);
    expect(e.retirados.map((d) => d.llave)).toEqual(['r']);
  });
});

describe('[RH.2.3] RhCandidatoFichaComponent', () => {
  let fix: ComponentFixture<RhCandidatoFichaComponent>;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const boton = (t: string) => [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

  async function render(f: HrCandidatoFichaDto, gestiona: boolean) {
    api = {
      moverEtapa: vi.fn(() => of(ficha({ stage: 'aptitudes', stage_raw: 'aptitudes' }))),
      noRecontratable: vi.fn(() => of(ficha({ no_rehire: true, no_rehire_reason: 'abandonó' }))),
      crearLiga: vi.fn(() => of({ url: 'https://suite/empleo/liga/tok', expires_at: '2026-10-20T00:00:00Z', mensaje: 'Hola Ana… https://suite/empleo/liga/tok',
        whatsapp_url: 'https://wa.me/523511234567?text=Hola' })),
      ficha: vi.fn(() => of(f)),
    };
    await TestBed.configureTestingModule({
      imports: [RhCandidatoFichaComponent],
      providers: [{ provide: ReclutamientoService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(RhCandidatoFichaComponent);
    fix.componentRef.setInput('ficha', f);
    fix.componentRef.setInput('casilleros', CASILLEROS);
    fix.componentRef.setInput('gestiona', gestiona);
    fix.detectChanges();
    await fix.whenStable();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ «Pasar a» la siguiente etapa llama al servidor y avisa con la ficha nueva', async () => {
    await render(ficha(), true);
    const nueva = vi.fn();
    fix.componentInstance.actualizada.subscribe(nueva);
    boton('Pasar a Aptitudes y Entrevista Técnica')?.click();
    expect(api['moverEtapa']).toHaveBeenCalledWith(ID, 'aptitudes');
    expect(nueva).toHaveBeenCalledWith(expect.objectContaining({ stage: 'aptitudes' }));
  });

  it('⭐ «Mandar liga para subir su CV» genera la liga y ofrece WhatsApp', async () => {
    await render(ficha(), true);
    boton('Mandar liga para subir su CV')!.click();
    fix.detectChanges();
    expect(api['crearLiga']).toHaveBeenCalledWith(ID, 'cv');
    const el = fix.nativeElement as HTMLElement;
    expect((el.querySelector('.cf-liga-url') as HTMLInputElement).value).toBe('https://suite/empleo/liga/tok');
    expect((el.querySelector('.cf-wa') as HTMLAnchorElement).href).toContain('https://wa.me/523511234567');
  });

  it('⭐ el cuestionario de liderazgo: resultado con el mismo cálculo del servidor; sin contestar, la liga', async () => {
    const doce = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 4]));
    await render(ficha({ portal_data: { cuestionarioLiderazgo: doce } }), true);
    expect(texto()).toContain('80%');
    expect(texto()).toContain('Liderazgo de Equipo');
    expect(texto()).toContain('califica');
    expect(boton('Mandar liga del cuestionario')).toBeUndefined(); // ya lo contestó
    TestBed.resetTestingModule();
    await render(ficha({ portal_data: { cuestionarioLiderazgo: { 1: 3, 2: 3 } } }), true);
    expect(texto()).toContain('Lleva 2 de 12 preguntas.');
    boton('Mandar liga del cuestionario')!.click();
    expect(api['crearLiga']).toHaveBeenCalledWith(ID, 'liderazgo');
  });

  it('⭐ aptitudes: muestra la evaluación del jefe, y la liga es para el jefe (no para el candidato)', async () => {
    await render(ficha({ aptitude_eval: { evaluador: 'Jefe Prueba', cargoEvaluador: 'Gerente', tiempo: '40 min', observaciones: 'Buen perfil',
      puntaje: 120, max: 150, pct: 80, banda: 'Recomendable', aprobado: true, completadaEn: '2026-10-13T16:00:00Z' } }), true);
    expect(texto()).toContain('120/150');
    expect(texto()).toContain('Recomendable');
    expect(texto()).toContain('Evaluó Jefe Prueba');
    boton('Liga para el jefe que entrevista')!.click();
    expect(api['crearLiga']).toHaveBeenCalledWith(ID, 'aptitudes');
    fix.detectChanges();
    expect(texto()).toContain('no al candidato');
  });

  it('el expediente dice qué falta', async () => {
    await render(ficha(), true);
    expect(texto()).toContain('Faltan 1 documento(s) obligatorio(s).');
    expect(texto()).toContain('INE · falta');
  });

  it('⛔ la lista negra no sale sin motivo', async () => {
    await render(ficha(), true);
    boton('No recontratable')?.click();
    fix.detectChanges();
    const marcar = boton('Marcar como no recontratable');
    expect(marcar).toBeTruthy();
    expect(marcar!.disabled).toBe(true);
    fix.componentInstance.motivo.set('abandonó el puesto');
    fix.detectChanges();
    expect(boton('Marcar como no recontratable')!.disabled).toBe(false);
    boton('Marcar como no recontratable')!.click();
    expect(api['noRecontratable']).toHaveBeenCalledWith(ID, true, 'abandonó el puesto');
  });

  it('⛔ NEGATIVA — quien sólo ve no tiene con qué cambiar nada', async () => {
    await render(ficha({ mismo_telefono: [{ id: OTRO, full_name: 'Ana', created_at: '2026-10-01T00:00:00Z', no_rehire: false }] }), false);
    for (const t of ['Corregir', 'No recontratable', 'Spam', 'Papelera', 'Fusionar aquí', 'Registrar', 'Retirar', 'Mandar liga para subir su CV',
      'Mandar liga del cuestionario', 'Liga para el jefe que entrevista']) expect(boton(t)).toBeUndefined();
    expect(texto()).not.toContain('Pasar a');
    expect(texto()).toContain('Mismo teléfono'); // pero sí lo ve
  });

  it('en la papelera: sólo restaurar, y si fue por fusión lo dice', async () => {
    await render(ficha({ deleted_at: '2026-10-05T00:00:00Z', deletion_reason: 'fusionado' }), true);
    expect(boton('Restaurar')).toBeTruthy();
    expect(boton('No recontratable')).toBeUndefined();
    expect(texto()).toContain('lo que ya se copió al otro se queda allá');
  });
});
