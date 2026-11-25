import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import type { HrFirmasSemanaDto } from '@megadulces/contracts';

import { RhFirmasService } from '../rh-firmas.service';
import { RhFirmasSemanaComponent } from './rh-firmas-semana.component';

/**
 * `[RH.15.5]` La firma de la semana en pantalla: que diga cuántos faltan, ponga arriba lo pendiente, no deje guardar
 * sin lo que pide el servidor, no mande dos veces y avise cuando una hoja es de otra versión de la semana.
 */
const estado = (over: Partial<HrFirmasSemanaDto> = {}): HrFirmasSemanaDto => ({
  site_code: 'cedis', period_start: '2026-11-05', cerrada: true, closure_id: 'c1', firmaron: 2, total: 3,
  departamentos: [
    { department: 'ALMACEN', firmaron: 2, total: 2, personas: [
      { codigo: '15', nombre: 'PRUEBA UNO', firmo: true }, { codigo: '16', nombre: 'PRUEBA DOS', firmo: true }] },
    { department: 'CAJAS', firmaron: 0, total: 1, personas: [{ codigo: '17', nombre: 'PRUEBA TRES', firmo: false }] },
  ],
  hojas: [{ id: 'h1', department: 'ALMACEN', person_codes: ['15', '16'], jefe_nombre: 'JEFE DE PRUEBA', file_name: 'a.png',
    file_type: 'image/png', notes: null, created_at: '2026-11-12T10:30:00', created_by_name: 'rh', vigente: true, voided_at: null, void_reason: null }],
  ...over,
});

let enviados = 0;
let generadas: string[] = [];
/** `[RH.15.11]` Lo que devuelve el servidor al generar los QR: el token sólo viaja aquí. */
const ligas = (department: string) => ({ site_code: 'cedis', period_start: '2026-11-05', period_end: '2026-11-11', department,
  ligas: [{ person_code: '17', nombre: 'PRUEBA TRES', url: 'https://suite.prueba/mi-semana/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', expires_at: '2026-11-15T18:00:00.000Z' }],
  omitidas: [{ person_code: '18', nombre: 'PRUEBA CUATRO', motivo: 'Ya firmó en papel' }] });
let respuesta: Subject<unknown> | null = null;
let anuladas: string[] = [];
const montar = async (d: HrFirmasSemanaDto, puede = true) => {
  enviados = 0;
  generadas = [];
  anuladas = [];
  await TestBed.configureTestingModule({
    imports: [RhFirmasSemanaComponent],
    providers: [{ provide: RhFirmasService, useValue: {
      estado: () => of(d),
      registrar: () => { enviados++; respuesta = new Subject(); return respuesta; },
      archivo: () => of({ url: 'x' }), anular: () => of({ ok: true }),
      generarLigas: (b: { department: string }) => { generadas.push(b.department); return of(ligas(b.department)); },
      anularFirma: (_id: string, motivo: string) => { anuladas.push(motivo); enviados++; respuesta = new Subject(); return respuesta; },
      archivoFirma: () => of({ url: 'y' }),
    } }],
  }).compileComponents();
  const fix = TestBed.createComponent(RhFirmasSemanaComponent);
  fix.componentRef.setInput('site', 'cedis');
  fix.componentRef.setInput('semana', '2026-11-05');
  fix.componentRef.setInput('cierre', 'c1');
  fix.componentRef.setInput('puedeRegistrar', puede);
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  return fix;
};
const texto = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

describe('[RH.15.5] firmas de la semana', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('dice cuántos firmaron y cuántos faltan, con lo pendiente ARRIBA y quién falta', async () => {
    const fix = await montar(estado());
    const el = fix.nativeElement as HTMLElement;
    expect(texto(el)).toContain('2 de 3 firmaron · faltan 1');
    const deps = [...el.querySelectorAll('.rf-dep-nom')].map((x) => x.textContent?.trim());
    expect(deps).toEqual(['CAJAS', 'ALMACEN']);
    expect(texto(el)).toContain('Sin firmar: PRUEBA TRES');
  });

  it('«Registrar hoja» trae marcadas a todas y no deja guardar sin jefe ni archivo', async () => {
    const fix = await montar(estado());
    const cmp = fix.componentInstance;
    cmp.abrir(estado().departamentos[1]);
    expect([...cmp.marcados()]).toEqual(['17']);
    expect(cmp.falta()).toContain('jefe de área');
    cmp.jefe.set('JEFE DE PRUEBA');
    expect(cmp.falta()).toContain('Sube la hoja');
    cmp.archivo.set(new File(['x'], 'hoja.png', { type: 'image/png' }));
    expect(cmp.falta()).toBeNull();
    cmp.alternar('17');
    expect(cmp.falta()).toContain('Marca a quienes firmaron');
  });

  it('el doble clic manda UNA sola hoja', async () => {
    const fix = await montar(estado());
    const cmp = fix.componentInstance;
    const dep = estado().departamentos[1];
    cmp.abrir(dep);
    cmp.jefe.set('JEFE DE PRUEBA');
    cmp.archivo.set(new File(['x'], 'hoja.png', { type: 'image/png' }));
    await Promise.all([cmp.guardar(dep), cmp.guardar(dep)]);
    expect(enviados).toBe(1);
  });

  it('una hoja de otra versión de la semana lo dice: hay que volver a firmar', async () => {
    const d = estado();
    d.hojas[0] = { ...d.hojas[0], vigente: false };
    const fix = await montar(d);
    expect(texto(fix.nativeElement)).toContain('De otra versión: la semana se reabrió después de firmar');
  });

  it('sin el permiso de cerrar la semana, sólo se ve (no se registra ni se anula)', async () => {
    const fix = await montar(estado(), false);
    const botones = [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(botones.some((b) => b?.includes('Registrar hoja') || b === 'Anular')).toBe(false);
  });
});

/** `[RH.15.11]` CAJAS: una persona firmó en su celular (ya cuenta) y otra tiene su QR vivo. */
const conCelular = () => estado({
  firmaron: 3, total: 4,
  departamentos: [
    { department: 'ALMACEN', firmaron: 2, total: 2, personas: [
      { codigo: '15', nombre: 'PRUEBA UNO', firmo: true, via: 'papel' }, { codigo: '16', nombre: 'PRUEBA DOS', firmo: true, via: 'papel' }] },
    { department: 'CAJAS', firmaron: 1, total: 2, personas: [
      { codigo: '17', nombre: 'PRUEBA TRES', firmo: true, via: 'celular', firma_id: 'f17', firmado_at: '2026-11-17T14:03:00' },
      { codigo: '18', nombre: 'PRUEBA CUATRO', firmo: false, via: null, liga: true }] },
  ],
});

describe('[RH.15.11] la firma desde el celular', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('la firma del celular CUENTA sola: dice quién firmó y cuándo, y quién tiene su QR; sin botón de confirmar', async () => {
    const fix = await montar(conCelular());
    const t = texto(fix.nativeElement as HTMLElement);
    expect(t).toContain('3 de 4 firmaron · faltan 1 · 1 en su celular');
    expect(t).toMatch(/PRUEBA TRES\s*firmó el 17\/11\/26 14:03/);
    expect(t).toContain('Sin firmar: PRUEBA CUATRO (tiene su QR)');
    expect(t).not.toContain('Confirmar');
    expect(t).toContain('PDF de firmas');
  });

  it('genera los QR, los DIBUJA con el nombre y dice quién se quedó sin QR y por qué', async () => {
    const fix = await montar(conCelular());
    const cmp = fix.componentInstance;
    cmp.generarQr(conCelular().departamentos[1]);
    await vi.waitFor(() => expect(cmp.qr()).not.toBeNull());
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    expect(generadas).toEqual(['CAJAS']);
    const svg = el.querySelector('.rf-qr-img path');
    expect(svg?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(texto(el.querySelector('.rf-qr-nom') as HTMLElement)).toBe('PRUEBA TRES');
    expect(texto(el)).toContain('Sin QR: PRUEBA CUATRO (ya firmó en papel)');
    expect(texto(el)).toContain('es la única llave');
  });

  it('anular una firma del celular pide motivo y manda UNA vez', async () => {
    const fix = await montar(conCelular());
    const cmp = fix.componentInstance;
    cmp.anulandoFirma.set('f17');
    cmp.motivo.set('firmó otra persona');
    fix.detectChanges();
    const anular = [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Anular');
    expect(anular?.disabled).toBe(false);
    cmp.anularFirma('f17', 'PRUEBA TRES');
    cmp.anularFirma('f17', 'PRUEBA TRES');
    expect(enviados).toBe(1);
    expect(anuladas).toEqual(['firmó otra persona']);
  });

  it('sin el permiso de cerrar la semana, ve las firmas del celular pero no las anula', async () => {
    const fix = await montar(conCelular(), false);
    const botones = [...(fix.nativeElement as HTMLElement).querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(botones).toContain('Ver firma');
    expect(botones.some((b) => b === 'Anular' || b?.includes('QR para el celular'))).toBe(false);
  });
});
