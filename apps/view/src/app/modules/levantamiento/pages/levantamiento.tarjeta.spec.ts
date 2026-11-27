import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { Router } from '@angular/router';
import type { LevantamientoEscaneoRespuesta } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent, tarjetaDe, type TarjetaEscaneo } from './levantamiento.component';

/**
 * `[NP.7.L.25]` Un escaneo que no abre la captura se ve en una TARJETA (título, producto, mensaje, código), no en un
 * renglón de 13 px: en la prueba en celular del 2026-11-26 se leyó como «no hizo nada».
 */
const r = (o: Partial<LevantamientoEscaneoRespuesta>) =>
  ({ action: 'no_registrado', message: 'Este código no está registrado en tus sucursales.', name: null, code: '7501000000001', candidates: [], ...o }) as LevantamientoEscaneoRespuesta;

describe('[NP.7.L.25] tarjetaDe: cada resultado con su palabra', () => {
  it('no registrado → aviso con «Buscarlo por nombre»', () => {
    expect(tarjetaDe(r({}))).toMatchObject({ tono: 'warn', titulo: 'No está en tus sucursales', buscar: true, codigo: '7501000000001' });
  });
  it('ya tiene ficha / en revisión → «Ya tiene fotos» con el nombre del producto', () => {
    expect(tarjetaDe(r({ action: 'ya_esta', name: 'TRIDENT' }))).toMatchObject({ tono: 'ok', titulo: 'Ya tiene fotos', nombre: 'TRIDENT', buscar: false });
    expect(tarjetaDe(r({ action: 'en_revision' })).tono).toBe('ok');
  });
  it('alguien más lo toma → tono neutro, con su icono', () => {
    expect(tarjetaDe(r({ action: 'apartado_por_otro' }))).toMatchObject({ tono: 'curso', icono: 'pi-clock' });
  });
  it('⭐ código compartido → los candidatos para elegir (antes el servidor los mandaba y la pantalla no los mostraba)', () => {
    const t = tarjetaDe(r({ action: 'codigo_compartido', candidates: [{ sku: 'A', name: 'COMPARTIDO A' }, { sku: 'B', name: null }] }));
    expect(t.candidatos).toHaveLength(2);
    expect(t.titulo).toBe('¿Cuál de estos es?');
  });
  it('el mensaje es el del servidor, tal cual', () => {
    expect(tarjetaDe(r({ action: 'demasiados_apartados', message: 'Tienes 3 productos apartados.' })).mensaje).toBe('Tienes 3 productos apartados.');
  });
});

describe('[NP.7.L.25] la pantalla muestra la tarjeta', () => {
  type Estado = { escanear(c: string): Promise<void>; resultado(): TarjetaEscaneo | null; aviso(): string | null; paso(): string; abrirBuscador(): void };
  let escanear: ReturnType<typeof vi.fn>;
  async function montar(): Promise<Estado> {
    escanear = vi.fn();
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [
        { provide: LevantamientoService, useValue: { escanear, buscar: vi.fn(() => of([])), contexto: vi.fn(() => of({})), sugeridos: vi.fn(() => of({ rows: [], total: 0 })) } },
        { provide: AuthService, useValue: {} },
        { provide: UsoService, useValue: { registrarFotoRechazada: vi.fn() } },
      ],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    return TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ escaneo de un código que no está → tarjeta, NO el renglón de texto', async () => {
    const c = await montar();
    escanear.mockReturnValue(of(r({})));
    await c.escanear('7501000000001');
    expect(c.resultado()?.titulo).toBe('No está en tus sucursales');
    expect(c.aviso()).toBeNull();
  });

  it('sin señal → tarjeta de error con el motivo', async () => {
    const c = await montar();
    escanear.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0, error: null })));
    await c.escanear('7501000000001');
    expect(c.resultado()).toMatchObject({ tono: 'bad', titulo: 'No se pudo revisar el código' });
    expect(c.resultado()?.mensaje).toMatch(/Sin conexión/);
  });

  it('⛔ negativa: el siguiente escaneo que sí abre la captura borra la tarjeta vieja', async () => {
    const c = await montar();
    escanear.mockReturnValueOnce(of(r({})));
    await c.escanear('7501000000001');
    escanear.mockReturnValueOnce(of(r({ action: 'capturar', sheet_id: 'f1', faces: ['frente'], faces_done: [], faces_skipped: [], rungs: [], principal: null })));
    await c.escanear('7622210571403');
    expect(c.resultado()).toBeNull();
    expect(c.paso()).toBe('confirmar');
  });

  it('[NP.7.L.26] la pantalla va sin el marco de la app: «Volver a Mi trabajo» lleva a /projects', async () => {
    const c = (await montar()) as unknown as { volverASuite(): void };
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    c.volverASuite();
    expect(nav).toHaveBeenCalledWith(['/projects']);
  });

  it('«Buscarlo por nombre» lleva al buscador y quita la tarjeta', async () => {
    const c = await montar();
    escanear.mockReturnValue(of(r({})));
    await c.escanear('7501000000001');
    c.abrirBuscador();
    expect(c.paso()).toBe('buscar');
    expect(c.resultado()).toBeNull();
  });
});
