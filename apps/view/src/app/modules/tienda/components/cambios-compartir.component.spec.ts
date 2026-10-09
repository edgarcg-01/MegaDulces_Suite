import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { PriceChangeRow, PriceNoticeRecipientsDto, PriceNoticeShareResultDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { EtiquetasService } from '../etiquetas.service';
import { CambiosCompartirComponent } from './cambios-compartir.component';

/**
 * `[ETQ-AVISOS.3]` «Compartir» en Cambios de precio, vista como la ve Compras.
 */
const FECHA = '2026-10-08';
const fila = (sku: string, antes: number, ahora: number): PriceChangeRow => ({
  sku, name: `P ${sku}`, unidad: 'PAQ', precio_anterior: antes, precio_nuevo: ahora, delta: ahora - antes, es_baja: ahora === 0, hora: '10:00:00',
});
const PLAZAS: PriceNoticeRecipientsDto[] = [
  { plaza: '01', nombre: 'Padre Hidalgo', destinatarios: 3, ultimo_dia: FECHA },
  { plaza: '02', nombre: 'La Piedad', destinatarios: 0, ultimo_dia: FECHA },
  { plaza: '03', nombre: '8 Esquinas', destinatarios: 2, ultimo_dia: '2026-10-01' }, // su bitácora no llega a FECHA
];

class SvcStub {
  recipients = PLAZAS;
  resultado: PriceNoticeShareResultDto[] = [];
  falla = false;
  enviados: unknown[] = [];
  noticeRecipients() { return of(this.recipients); }
  shareNotices(body: unknown) {
    this.enviados.push(body);
    return this.falla ? throwError(() => ({ error: { message: 'Máximo 20 sucursales por envío.' } })) : of(this.resultado);
  }
}

describe('CambiosCompartirComponent', () => {
  let fix: ComponentFixture<CambiosCompartirComponent>;
  let svc: SvcStub;
  const body = (): HTMLElement => document.body;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };
  const boton = (texto: RegExp): HTMLButtonElement | undefined =>
    Array.from(body().querySelectorAll('button')).find((b) => texto.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

  async function montar(permiso: boolean, items: PriceChangeRow[] = [fila('1', 10, 12)]): Promise<void> {
    svc = new SvcStub();
    await TestBed.configureTestingModule({
      providers: [
        { provide: EtiquetasService, useValue: svc },
        { provide: PermissionsService, useValue: { has: () => permiso } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(CambiosCompartirComponent);
    fix.componentRef.setInput('items', items);
    fix.componentRef.setInput('plaza', '01');
    fix.componentRef.setInput('fecha', FECHA);
    fix.detectChanges();
    await tick();
  }
  afterEach(() => { body().querySelectorAll('.p-dialog-mask, .p-overlay').forEach((e) => e.remove()); });

  it('⭐ sin el permiso el botón NO EXISTE (se esconde, no se deshabilita)', async () => {
    await montar(false);
    expect(fix.nativeElement.textContent).not.toContain('Compartir');
    expect(boton(/Compartir/)).toBeUndefined();
  });

  it('con el permiso aparece, y al abrir lista las plazas con lo que se sabe de cada una', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    const t = body().textContent ?? '';
    expect(t).toContain('Padre Hidalgo');
    expect(t).toContain('3 personas');
    // D5: una plaza sin nadie con tienda asignada se DECLARA, no se esconde
    expect(t).toContain('nadie con tienda asignada');
    // sin dato no es «sin cambios»: se dice hasta dónde llega la bitácora
    expect(t).toContain('bitácora hasta 2026-10-01');
  });

  it('⛔ una plaza cuya bitácora no llega al día NO se puede elegir', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    const cb = (p: string) => body().querySelector(`input[aria-label="Avisar a ${p}"]`) as HTMLInputElement;
    expect(cb('8 Esquinas').disabled).toBe(true);
    expect(cb('Padre Hidalgo').disabled).toBe(false);
    // …ni entra con «todas las disponibles»
    boton(/Todas las disponibles/)!.click();
    await tick();
    const c = fix.componentInstance;
    expect(c.elegidas().sort()).toEqual(['01', '02']);
  });

  it('arranca con la plaza que se está viendo ya elegida', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    expect(fix.componentInstance.elegidas()).toEqual(['01']);
  });

  it('⭐ envía las plazas, el día de la pantalla y la nota; muestra el estado de CADA plaza y quita lo que ya salió', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    fix.componentInstance.alternar('02');
    fix.componentInstance.nota.set('  Reimprime primero la caja  ');
    svc.resultado = [
      { plaza: '01', estado: 'enviado', productos: 47, destinatarios: 3, id: 'x' },
      { plaza: '02', estado: 'sin_cambios', productos: 0, destinatarios: 0, id: null },
    ];
    fix.detectChanges();
    boton(/Enviar aviso/)!.click();
    await tick();
    expect(svc.enviados).toEqual([{ plazas: ['01', '02'], fecha: FECHA, nota: 'Reimprime primero la caja' }]);
    const t = body().textContent ?? '';
    expect(t).toContain('Enviado · 47 productos');
    expect(t).toContain('Ese día no hubo cambios: no se envió');
    // la que salió se quita de la selección; la que no, queda para reintentar
    expect(fix.componentInstance.elegidas()).toEqual(['02']);
  });

  it('un error del servidor se muestra con su motivo y no se queda en «enviando»', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    svc.falla = true;
    boton(/Enviar aviso/)!.click();
    await tick();
    expect(body().textContent).toContain('Máximo 20 sucursales por envío.');
    expect(fix.componentInstance.enviando()).toBe(false);
  });

  it('el botón de enviar está apagado mientras no haya ninguna plaza elegida', async () => {
    await montar(true);
    boton(/Compartir/)!.click();
    await tick();
    boton(/Ninguna/)!.click();
    await tick();
    expect((boton(/Enviar aviso/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('⭐ descargar genera el CSV de la lista con nombre de plaza y día, y libera el objeto', async () => {
    await montar(true, [fila('91059', 10, 12), fila('77', 5, 0)]);
    const crear = vi.fn().mockReturnValue('blob:x');
    const liberar = vi.fn();
    (URL as unknown as Record<string, unknown>)['createObjectURL'] = crear;
    (URL as unknown as Record<string, unknown>)['revokeObjectURL'] = liberar;
    let nombre = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { nombre = this.download; });
    boton(/Compartir/)!.click();
    await tick();
    boton(/Descargar CSV/)!.click();
    expect(nombre).toBe('cambios-de-precio_01_2026-10-08.csv');
    const blob = crear.mock.calls[0][0] as Blob;
    // jsdom no trae `Blob.text()`: se lee con FileReader.
    const texto = await new Promise<string>((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.readAsText(blob);
    });
    // El decodificador de texto se come el BOM al leer: se comprueba en los BYTES (EF BB BF).
    const bytes = await new Promise<Uint8Array>((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(new Uint8Array(fr.result as ArrayBuffer));
      fr.readAsArrayBuffer(blob);
    });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(texto).toContain('91059');
    expect(liberar).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
  });

  it('sin cambios en la vista no hay nada que descargar y el botón lo dice', async () => {
    await montar(true, []);
    boton(/Compartir/)!.click();
    await tick();
    expect((boton(/Descargar CSV/) as HTMLButtonElement).disabled).toBe(true);
    expect(body().textContent).toContain('No hay cambios que descargar');
  });
});
