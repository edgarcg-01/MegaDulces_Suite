import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { AcuerdoVista, ListaAcuerdos, OpcionesCitas } from '@megadulces/contracts';
import { ComprasAcuerdosComponent } from './compras-acuerdos.component';
import { AcuerdosProveedoresService } from '../acuerdos-proveedores.service';
import { CitasProveedoresService } from '../citas-proveedores.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[PQ.3.10]` Acuerdos · C3 — la pestaña montada: la respuesta primero, lo vencido arriba, «Míos» desde «Mi trabajo»,
 * los botones que dice la API y sólo con la llave de agendar, y el cierre siempre con nota. (Los tipos de la plantilla
 * los compila el build de la vista, no este TestBed.)
 */
const HOY = '2026-11-27';

const acuerdo = (o: Partial<AcuerdoVista> = {}): AcuerdoVista => ({
  id: 'a1', meeting_id: 'r1', supplier_code: 'PRV01', supplier_name: 'Dulcería de Prueba', meeting_date: '2026-11-24', area: 'supplier',
  description: 'Mandar la lista de precios 2027', supplier_contact: 'Ejecutivo', assigned_to: { user_id: 'U-YO', nombre: 'Compras Prueba' },
  due_date: '2026-11-25', status: 'pending', situacion: 'vencido', acciones: ['iniciar', 'cumplir', 'cancelar', 'editar'],
  closed_by: null, closed_at: null, closing_note: null, assigned_by: 'Compras Prueba', assigned_at: '2026-11-24T17:00:00Z', ...o,
});

const lista = (): ListaAcuerdos => ({
  hoy: HOY,
  abiertos: {
    total: 2, tope: 500, por_situacion: { vencido: 1, vence_hoy: 0, esta_semana: 1, al_dia: 0 },
    acuerdos: [
      acuerdo(),
      acuerdo({ id: 'a2', area: 'marketing', description: 'Armar la exhibición de diciembre', supplier_contact: null, due_date: '2026-12-01',
        situacion: 'esta_semana', assigned_to: { user_id: 'U-LUIS', nombre: 'Luis Mercadotecnia' } }),
    ],
  },
  cerrados: { total: 1, tope: 100, acuerdos: [acuerdo({ id: 'c1', status: 'done', situacion: 'cumplido', acciones: [], closed_by: 'Compras Prueba',
    closed_at: '2026-11-26T18:00:00Z', closing_note: 'Llegó el viernes.' })] },
});

function montar(o: { agendar?: boolean; error?: boolean; query?: Record<string, string> } = {}) {
  const api = {
    lista: vi.fn(() => (o.error ? throwError(() => ({ status: 500 })) : of(lista()))),
    deReunion: vi.fn(), capturar: vi.fn(), editar: vi.fn(() => of({ id: 'a2' })),
    iniciar: vi.fn(() => of({ id: 'a1' })), cumplir: vi.fn(() => of({ id: 'a1' })), cancelar: vi.fn(() => of({ id: 'a1' })),
  };
  const citas = { opciones: vi.fn(() => of({ personas: [{ user_id: 'U-LUIS', nombre: 'Luis Mercadotecnia', puesto: 'mkt', area: 'marketing' }] } as OpcionesCitas)) };
  const agendar = o.agendar ?? true;
  const perms = { has$: (p: string) => signal(p === Permission.COMPRAS_CITAS_AGENDAR ? agendar : true), has: () => true, isAdmin: () => false };
  TestBed.configureTestingModule({
    imports: [ComprasAcuerdosComponent],
    providers: [
      provideRouter([]), { provide: AcuerdosProveedoresService, useValue: api }, { provide: CitasProveedoresService, useValue: citas },
      { provide: PermissionsService, useValue: perms }, { provide: AuthService, useValue: { user: signal({ sub: 'U-YO' }) } },
      ...(o.query ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(o.query) } } }] : []),
    ],
  });
  const f = TestBed.createComponent(ComprasAcuerdosComponent);
  f.detectChanges();
  return { f, c: f.componentInstance, el: f.nativeElement as HTMLElement, api };
}

const texto = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ');
const botones = (el: HTMLElement, etiqueta: string) => [...el.querySelectorAll('button')].filter((b) => texto(b).trim() === etiqueta);
const filas = (el: HTMLElement) => [...el.querySelectorAll('tbody tr')].map((f) => texto(f.querySelector('.ac-link') as Element).trim());

describe('[PQ.3.10] Acuerdos · la pestaña', () => {
  it('abre con la respuesta y lo vencido arriba (el orden de la API, sin reordenar)', () => {
    const { el } = montar();
    expect(texto(el.querySelector('.ac-respuesta') as Element).trim()).toBe('1 acuerdo venció sin cumplirse, 1 vence esta semana. 2 acuerdos abiertos en total.');
    expect(filas(el)).toEqual(['Mandar la lista de precios 2027', 'Armar la exhibición de diciembre']);
    expect(texto(el.querySelector('tbody tr') as Element)).toContain('Venció hace 2 días');
    // El del proveedor dice quién de él se comprometió y quién lo sigue en la Suite.
    expect(texto(el.querySelector('tbody tr') as Element)).toContain('Ejecutivo (proveedor)');
    expect(texto(el.querySelector('tbody tr') as Element)).toContain('Lo sigue Compras Prueba');
  });

  it('con error no dibuja la respuesta ni un cero', () => {
    const { el } = montar({ error: true });
    expect(el.querySelector('.ac-respuesta')).toBeNull();
    expect(el.querySelector('app-metric-strip')).toBeNull();
  });

  it('«Mi trabajo» llega con ?de=mios: sólo los de quien mira', () => {
    const { el } = montar({ query: { de: 'mios' } });
    expect(filas(el)).toEqual(['Mandar la lista de precios 2027']);
  });

  it('la cifra filtra: «Vencidos» deja sólo los vencidos; el chip lo quita', () => {
    const { c, f, el } = montar();
    c.irA('vencido');
    f.detectChanges();
    expect(filas(el)).toEqual(['Mandar la lista de precios 2027']);
    c.situacion.set(null);
    f.detectChanges();
    expect(filas(el)).toHaveLength(2);
    c.irA('cerrados');
    f.detectChanges();
    expect(filas(el)).toEqual(['Mandar la lista de precios 2027']); // el cerrado c1 tiene el mismo texto
    expect(c.vista()).toBe('cerrados');
  });

  it('«Cumplido» sólo con la llave de agendar', () => {
    const con = montar();
    expect(botones(con.el, 'Cumplido')).toHaveLength(2);
    TestBed.resetTestingModule();
    const sin = montar({ agendar: false });
    expect(botones(sin.el, 'Cumplido')).toHaveLength(0);
  });

  it('cumplir exige nota y manda la nota; después recarga', () => {
    const { c, api } = montar();
    const a = c.lista()!.abiertos.acuerdos[0];
    c.abrirCierre(a, 'cumplir');
    c.fNota = '   ';
    c.guardarCierre();
    expect(api.cumplir).not.toHaveBeenCalled();
    c.fNota = 'Llegó el viernes';
    c.guardarCierre();
    expect(api.cumplir).toHaveBeenCalledWith('a1', 'Llegó el viernes');
    expect(api.lista).toHaveBeenCalledTimes(2);
    expect(c.aviso()).toContain('Acuerdo cumplido');
  });

  it('?acuerdo= abre ese acuerdo en el detalle, con la liga a su reunión en Citas', () => {
    const { f, c, el } = montar({ query: { acuerdo: 'a2' } });
    f.detectChanges();
    expect(c.sel()?.id).toBe('a2');
    expect(texto(el)).toContain('Abrir la reunión en Citas');
    expect(el.querySelector('a[href*="reunion=r1"]')).not.toBeNull();
  });

  it('?acuerdo= de uno cerrado cambia a «Cerrados»; uno que no llegó lo dice', () => {
    const cerrado = montar({ query: { acuerdo: 'c1' } });
    expect(cerrado.c.vista()).toBe('cerrados');
    expect(cerrado.c.sel()?.id).toBe('c1');
    TestBed.resetTestingModule();
    const nada = montar({ query: { acuerdo: 'no-existe' } });
    expect(nada.c.sel()).toBeNull();
    expect(nada.c.aviso()).toContain('no está entre los que se cargaron');
  });
});
