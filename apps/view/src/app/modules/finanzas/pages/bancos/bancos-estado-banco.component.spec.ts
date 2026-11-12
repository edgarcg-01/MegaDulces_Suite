import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { BancosEstadoBancoComponent } from './bancos-estado-banco.component';
import { ArchivoEstadoBanco, ArchivosDelBanco, BankService, ContraElLibro, CuentaContraElLibro, RevisionEstadoBanco, UsoDelBanco } from '../../bank.service';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';

/**
 * `[CB.59]` Se sueltan una o varias descargas: cada una en su fila con su veredicto, la cuenta que
 * coincide por saldo se elige sola, lo que nadie pudo comprobar no se cuenta como listo sin
 * confirmarlo, y un guardado parcial deja los que fallaron con su motivo. Datos inventados.
 */
const ARCHIVO: ArchivoEstadoBanco = {
  id: 'f1', bank: 'banbajio', alias: 'BB 1111', account_label: '1111', file_name: 'x.xlsx', date_from: '2026-10-01', date_to: '2026-10-31',
  lines_in_file: 10, lines_new: 10, opening_balance: 100, closing_balance: 200, total_in: 150, total_out: 50,
  balance_ok: true, declared_ok: true, account_check: 'sin_testigo', created_at: '2026-11-05T18:00:00Z', created_by: 'prueba',
};
const cta = (alias: string, hasta: string | null, con_lector = true, sin_testigo = 0) =>
  ({ id: alias, bank: alias.split(' ')[0], alias, hasta, archivos: hasta ? 1 : 0, sin_testigo, con_lector });
const DATOS: ArchivosDelBanco = {
  archivos: [ARCHIVO], total: 1, tope: 100,
  cuentas: [cta('BB 1111', '2026-10-31', true, 1), cta('BB 2222', null), cta('BBVA 3333', null), cta('BNMX 9999', null, false)],
};
function revision(p: Partial<RevisionEstadoBanco>): RevisionEstadoBanco {
  return {
    banco: 'banbajio', archivo: 'x.xlsx', cuenta_en_archivo: null, cliente_en_archivo: null, cuenta: null, como_se_fijo: null,
    candidatas: [{ id: 'a', alias: 'BB 1111', saldo_conocido: 500, coincide: true }, { id: 'b', alias: 'BB 2222', saldo_conocido: 9, coincide: false }],
    desde: '2026-11-01', hasta: '2026-11-04', movimientos: 4, nuevos: 4, ya_cargados: 0, saldo_inicial: 500, saldo_final: 700,
    total_abonos: 300, total_cargos: 100, cuadra: true, eslabones_rotos: [], totales_declarados_coinciden: true, no_leidos: [],
    motivos_bloqueo: ['el archivo no dice de qué cuenta es: elige la cuenta'], puede_confirmar: false, ya_subido: null, ...p,
  };
}
const LISTO = (alias = 'BB 1111', id = 'a') => revision({ cuenta: { id, alias }, como_se_fijo: 'saldo_continuo', motivos_bloqueo: [], puede_confirmar: true });

const resumenC = (p: Partial<CuentaContraElLibro['resumen']>) => ({ cuadra: 0, difiere: 0, sin_libro: 0, abierto: 1, solo_banco: 0, solo_libro: 0, monto_solo_banco: 0, monto_solo_libro: 0, ...p });
const CONTRA: ContraElLibro = { desde: '2026-09-25', cuentas: [
  { id: 'a', alias: 'BB 1111', desde: '2026-11-01', hasta: '2026-11-03', dias: [], resumen: resumenC({ cuadra: 2 }) },
  { id: 'c', alias: 'BBVA 3333', desde: '2026-11-01', hasta: '2026-11-03', resumen: resumenC({ cuadra: 1, difiere: 1, solo_banco: 1 }), dias: [
    { fecha: '2026-11-02', veredicto: 'difiere', movimientos_banco: 3, renglones_libro: 2, pareados: 2, fecha_distinta: 0, cierre_banco: 100, cierre_libro: 103.51,
      solo_banco: [{ id: 'x', fecha: '2026-11-02', lado: 'sale', importe: 3.51, concepto: 'COMISION' }], solo_libro: [] }] },
  { id: 'd', alias: 'BTE 4444', desde: '2026-11-03', hasta: '2026-11-03', dias: [], resumen: resumenC({}) },
] };

function montar(opts: {
  contra?: ContraElLibro | Error;
  datos?: ArchivosDelBanco;
  revisar?: (nombre: string, id?: string | null) => RevisionEstadoBanco;
  confirmar?: (nombre: string) => unknown;
  usar?: (id: string) => UsoDelBanco | Error;
  sinPermiso?: boolean;
}) {
  const llamadas: [string, string | null | undefined][] = [];
  const guardados: unknown[][] = [];
  const usados: string[] = [];
  let cargas = 0;
  const api = {
    archivosDelBanco: () => { cargas++; return of(opts.datos ?? DATOS); },
    contraElLibro: () => (opts.contra instanceof Error ? throwError(() => opts.contra) : of(opts.contra ?? { desde: '2026-09-25', cuentas: [] })),
    revisarEstadoBanco: (_b: string, n: string, id?: string | null) => { llamadas.push([n, id]); return of(opts.revisar!(n, id)); },
    confirmarEstadoBanco: (...args: unknown[]) => {
      guardados.push(args);
      const r = opts.confirmar?.(args[1] as string);
      return r instanceof Error ? throwError(() => r) : of({ cuenta: { alias: 'x' }, nuevos: 1, ya_existia: false });
    },
    usarElBanco: (id: string) => { usados.push(id); const r = opts.usar!(id); return r instanceof Error ? throwError(() => r) : of(r); },
  };
  const auth = { user: signal({ permissions: { [Permission.FINANCE_BANK_GESTIONAR]: !opts.sinPermiso } }) };
  TestBed.configureTestingModule({
    imports: [BancosEstadoBancoComponent],
    providers: [provideZonelessChangeDetection(), MessageService, ConfirmationService,
      { provide: BankService, useValue: api }, { provide: AuthService, useValue: auth }],
  });
  const fx = TestBed.createComponent(BancosEstadoBancoComponent);
  fx.detectChanges();
  const cmp = fx.componentInstance;
  const soltar = async (...nombres: string[]) => { await cmp.agregarArchivos(nombres.map((nombre) => ({ nombre, b64: 'AAAA' }))); fx.detectChanges(); };
  const confirmaciones: { accept?: () => void; reject?: () => void; header?: string }[] = [];
  TestBed.inject(ConfirmationService).requireConfirmation$.subscribe((c) => { if (c) confirmaciones.push(c as never); });
  const toasts: { severity?: string; summary?: string; detail?: string }[] = [];
  TestBed.inject(MessageService).messageObserver.subscribe((m) => toasts.push(...(Array.isArray(m) ? m : [m])));
  return { fx, cmp, llamadas, guardados, usados, confirmaciones, toasts, cargas: () => cargas, soltar, el: fx.nativeElement as HTMLElement };
}

describe('BancosEstadoBancoComponent', () => {
  it('sin nada subido no hay vacío grande: el resumen, la franja de una línea y nada más', () => {
    const { el } = montar({ datos: { archivos: [], total: 0, tope: 100, cuentas: [cta('BB 2222', null)] } });
    expect(el.querySelector('.eb-soltar')?.textContent).toContain('Arrastra aquí una o varias descargas');
    expect(el.querySelector('p-table')).toBeNull();
    expect(el.textContent).not.toContain('Todavía no se ha subido');
  });

  it('el resumen cuenta sólo las cuentas con lector, nombra las que faltan y dice cuál no se puede subir', () => {
    const { cmp, el } = montar({});
    const [con, atrasada, sinTestigo] = cmp.resumen();
    expect(con.value).toBe('1 de 3');
    expect(con.sub).toContain('BB 2222');
    expect(con.sub).not.toContain('BNMX');
    expect(atrasada.value).toBe('31/10/26');
    expect(sinTestigo.value).toBe(1);
    expect(el.textContent).toContain('BNMX 9999 no se puede subir aún');
  });

  it('[negativa] la lista trae tope, el resumen no: lo dice y no recorta las cuentas', () => {
    const { cmp, el } = montar({ datos: { ...DATOS, total: 250, cuentas: [cta('BB 1111', '2026-10-31'), cta('BB 2222', '2026-10-30'), cta('BBVA 3333', '2026-10-29')] } });
    expect(cmp.resumen()[0].value).toBe('3 de 3');
    expect(el.textContent).toContain('Se muestran los 1 más recientes de 250');
  });

  it('varios archivos a la vez: cada uno en su fila; el que coincide por saldo se elige solo y queda listo', async () => {
    const { cmp, llamadas, soltar, el } = montar({
      revisar: (n, id) => n === 'bbajio.xlsx' ? (id === 'a' ? LISTO() : revision({}))
        : revision({ candidatas: [{ id: 'c', alias: 'BBVA 3333', saldo_conocido: 1, coincide: false }, { id: 'd', alias: 'BBVA 4444', saldo_conocido: 2, coincide: false }] }),
    });
    await soltar('bbajio.xlsx', 'bbva.exp');
    expect(cmp.lote().length).toBe(2);
    expect(llamadas).toEqual([['bbajio.xlsx', null], ['bbajio.xlsx', 'a'], ['bbva.exp', null]]);
    expect(cmp.veredicto(cmp.lote()[0]).texto).toBe('Listo: 4 nuevos');
    expect(cmp.veredicto(cmp.lote()[1]).texto).toBe('Elige la cuenta');
    expect(cmp.textoGuardar()).toBe('Guardar 1 listo');
    expect(el.textContent).toContain('1 de 2 listos · 1 piden algo');
  });

  it('[negativa] sin testigo: no cuenta como listo hasta confirmar la cuenta, y la confirmación viaja al guardar', async () => {
    const { cmp, guardados, soltar } = montar({
      revisar: () => revision({ candidatas: [], cuenta: { id: 'b', alias: 'BB 2222' }, como_se_fijo: 'sin_testigo', motivos_bloqueo: [], puede_confirmar: true }),
    });
    await soltar('x.xlsx');
    const a = cmp.lote()[0];
    expect(cmp.veredicto(a).texto).toBe('Ningún saldo lo comprueba');
    expect(cmp.listos().length).toBe(0);
    cmp.aceptar(a, true);
    expect(cmp.listos().length).toBe(1);
    await cmp.guardar();
    expect(guardados[0][3]).toBe(true);
  });

  it('[negativa] guardado parcial: el que falla se queda con su motivo y el otro sale de la lista', async () => {
    const { cmp, soltar } = montar({
      revisar: (n) => LISTO(n),
      confirmar: (n) => (n === 'malo.csv' ? Object.assign(new Error('400'), { error: { motivos: ['el saldo no encadena en 1 renglón(es)'] } }) : null),
    });
    await soltar('bueno.csv', 'malo.csv');
    await cmp.guardar();
    expect(cmp.lote().map((a) => a.nombre)).toEqual(['malo.csv']);
    expect(cmp.veredicto(cmp.lote()[0]).texto).toContain('No se guardó: el saldo no encadena');
    expect(cmp.listos().length).toBe(0);
  });

  it('[negativa] el mismo archivo otra vez: se avisa y no cuenta como listo', async () => {
    const { cmp, soltar } = montar({
      revisar: () => ({ ...LISTO(), ya_subido: { archivo_id: 'f1', subido_el: '2026-11-05T18:00:00Z', subido_por: 'prueba' } }),
    });
    await soltar('x.xlsx');
    expect(cmp.veredicto(cmp.lote()[0]).texto).toContain('Ya se subió');
    expect(cmp.listos().length).toBe(0);
  });

  it('[CB.60] contra el libro: lo que difiere va primero, dice cuántas cuentas cuadran y nombra lo que sobra', () => {
    const { cmp, fx, el } = montar({ contra: CONTRA });
    expect(cmp.cuentasContra().map((c) => c.alias)).toEqual(['BBVA 3333', 'BB 1111', 'BTE 4444']);
    expect(cmp.estadoContra(cmp.cuentasContra()[0]).texto).toBe('difiere en 1 día');
    expect(cmp.estadoContra(cmp.cuentasContra()[2]).texto).toBe('sin días cerrados todavía');
    const item = cmp.resumen().find((m) => m.label === 'Cuadran con el libro');
    expect(item?.value).toBe('1 de 2'); // BTE 4444 no tiene días cerrados: no cuenta ni a favor ni en contra
    expect(item?.sub).toContain('BBVA 3333');
    const boton = el.querySelector('button[aria-label="Ver los días de BBVA 3333"]') as HTMLButtonElement | null;
    expect(boton).not.toBeNull();
    boton!.click();
    fx.detectChanges();
    expect(el.textContent).toContain('Sólo en el banco: sale');
  });

  it('el libro subido a medias y el cuadre por saldos se dicen en palabras, no como «difiere»', () => {
    const { cmp } = montar({ contra: CONTRA });
    const dia = (p: Partial<CuentaContraElLibro['dias'][number]>) => ({ fecha: '2026-11-09', veredicto: 'sin_libro' as const, movimientos_banco: 14, renglones_libro: 1, pareados: 1,
      fecha_distinta: 0, cierre_banco: null, cierre_libro: null, solo_banco: [], solo_libro: [], ...p });
    expect(cmp.diaTexto(dia({ libro_a_medias: true }))).toBe('el libro se subió antes de cerrar este día: tiene 1 de 14 (no se juzga hasta que traiga un día posterior)');
    expect(cmp.diaTexto(dia({ libro_a_medias: false, renglones_libro: 0 }))).toBe('el libro no tiene ese día');
    expect(cmp.diaTexto(dia({ veredicto: 'cuadra', cuadre_por: 'saldos' }))).toMatch(/^cuadra: todos los saldos son iguales/);
    expect(cmp.diaTexto(dia({ veredicto: 'cuadra', cuadre_por: 'cierre' }))).toBe('cuadra');
  });

  it('[negativa] si la comparación no se pudo leer, se dice y no aparece ningún «cuadran»', () => {
    const { cmp, el } = montar({ contra: Object.assign(new Error('500'), { status: 500 }) });
    expect(cmp.cuentasContra()).toEqual([]);
    expect(cmp.resumen().some((m) => m.label === 'Cuadran con el libro')).toBe(false);
    expect(cmp.contraError()).toBeTruthy();
    expect(el.textContent).not.toContain('Contra el libro');
  });

  describe('[CB.60b] usar el banco, cuenta por cuenta', () => {
    const listo = (n: number) => ({ dias_seguidos: n, requeridos: 10, cumple: n >= 10, ultimo_que_cuadra: n ? '2026-11-09' : null, desde: n ? '2026-11-10' : null });
    const cuentaB = (id: string, alias: string, p: Partial<CuentaContraElLibro>): CuentaContraElLibro =>
      ({ id, alias, desde: '2026-11-01', hasta: '2026-11-11', dias: [], resumen: resumenC({}), banco_desde: null, ...p });
    const CONTRA_B: ContraElLibro = { desde: '2026-09-27', cuentas: [
      cuentaB('p', 'BB 4166', { resumen: resumenC({ cuadra: 10 }), listo_para_banco: listo(10), sucursales: { con_sucursal_libro: 100, deducidas: 80, coinciden: 79, sin_senal: 20 } }),
      cuentaB('q', 'BBVA 6721', { resumen: resumenC({ cuadra: 8 }), listo_para_banco: listo(8) }),
      cuentaB('r', 'BTE 3041', { resumen: resumenC({ cuadra: 12, abierto: 0 }), listo_para_banco: listo(12), banco_desde: '2026-11-03' }),
      cuentaB('s', 'BBVA 4176', { resumen: resumenC({ cuadra: 8, difiere: 1 }), listo_para_banco: listo(0) }),
    ] };
    const USO: UsoDelBanco = { cuenta: 'BB 4166', desde: '2026-11-10', ya_estaba: false, llaves: 5, libro_borrados: 2, metidos: 30, en_cero: 0, sin_categoria: 0, sin_sucursal: 3 };
    const boton = (el: HTMLElement, alias: string) => el.querySelector(`button[aria-label="Usar el banco en ${alias}"]`) as HTMLButtonElement | null;

    it('la columna «Dejar el libro» en palabras, y el orden: difiere, lista, paralelo, ya usa el banco', () => {
      const { cmp, el } = montar({ contra: CONTRA_B });
      expect(cmp.cuentasContra().map((c) => c.alias)).toEqual(['BBVA 4176', 'BB 4166', 'BBVA 6721', 'BTE 3041']);
      expect(cmp.cuentasContra().map((c) => cmp.dejar(c).texto)).toEqual(['lleva 0 de 10 días seguidos', 'puede usar el banco', 'lleva 8 de 10 días seguidos', 'usa el banco desde el 03/11']);
      expect(boton(el, 'BB 4166')).not.toBeNull();
      expect(boton(el, 'BBVA 6721')).toBeNull(); // [negativa] sin la racha no hay botón
      expect(boton(el, 'BTE 3041')).toBeNull(); // [negativa] la que ya pasó no se ofrece otra vez
      expect(cmp.textoAlimenta()).toBe('En BTE 3041 ya alimenta Movimientos; las demás cuentas se comparan contra el libro día por día.');
      expect(cmp.resumen().find((m) => m.label === 'Cuadran con el libro')?.sub).toContain('BB 4166 ya puede usar el banco');
      expect(el.querySelector('.eb-leyenda')?.textContent).toContain('con 10 días seguidos que cuadran');
    });

    it('pulsar pide confirmar; nada pasa antes. Al aceptar pasa la cuenta, lo dice con lo que quedó sin sucursal y recarga', () => {
      const { cmp, fx, el, usados, confirmaciones, toasts, cargas } = montar({ contra: CONTRA_B, usar: () => USO });
      let emitidos = 0;
      cmp.guardado.subscribe(() => emitidos++);
      const antes = cargas();
      boton(el, 'BB 4166')!.click();
      fx.detectChanges();
      expect(confirmaciones.map((c) => c.header)).toEqual(['Usar el banco en BB 4166']);
      expect(usados).toEqual([]);
      expect(cmp.textoSucursal(cmp.aConfirmar()!)).toContain('acertó 79 de 80');
      confirmaciones[0].accept!();
      expect(usados).toEqual(['p']);
      const t = toasts.find((x) => x.summary === 'BB 4166 usa el banco desde el 10/11');
      expect(t?.severity).toBe('warn');
      expect(t?.detail).toBe('30 movimientos de la descarga entraron a Movimientos · 3 sin sucursal · 2 renglón(es) del libro de días sin cerrar quedaron reemplazados');
      expect(cargas()).toBe(antes + 1);
      expect(emitidos).toBe(1);
      expect(cmp.pasando()).toBeNull();
    });

    it('[negativa] cancelar no pasa nada', () => {
      const { cmp, fx, el, usados, confirmaciones } = montar({ contra: CONTRA_B, usar: () => USO });
      boton(el, 'BB 4166')!.click();
      fx.detectChanges();
      confirmaciones[0].reject!();
      expect(usados).toEqual([]);
      expect(cmp.aConfirmar()).toBeNull();
    });

    it('[negativa] si el servidor dice que no, se muestra su motivo y la cuenta sigue con el libro', () => {
      const { cmp, toasts } = montar({ contra: CONTRA_B,
        usar: () => Object.assign(new Error('400'), { error: { message: 'BB 4166 todavía no puede usar el banco', motivos: ['lleva 9 día(s) hábiles seguidos que cuadran con el libro; hacen falta 10'] } }) });
      let emitidos = 0;
      cmp.guardado.subscribe(() => emitidos++);
      cmp.usarElBanco(cmp.cuentasContra()[1]);
      const t = toasts.find((x) => x.severity === 'error');
      expect(t?.summary).toBe('BB 4166 sigue con el libro');
      expect(t?.detail).toContain('hacen falta 10');
      expect(emitidos).toBe(0);
      expect(cmp.pasando()).toBeNull();
    });

    it('[negativa] sin permiso de gestionar no hay botón: el estado se lee igual', () => {
      const { el } = montar({ contra: CONTRA_B, sinPermiso: true });
      expect(boton(el, 'BB 4166')).toBeNull();
      expect(el.textContent).toContain('puede usar el banco');
    });

    it('[negativa] una API sin la racha (anterior a CB.60b) se declara «no medido»: ni «0 de 10» ni botón', () => {
      const { cmp, el } = montar({ contra: CONTRA });
      expect(cmp.dejar(cmp.cuentasContra()[1]).texto).toBe('no medido');
      expect(el.querySelector('button[aria-label^="Usar el banco"]')).toBeNull();
      expect(cmp.requeridos()).toBeNull();
      expect(el.textContent).not.toContain('Dejar el libro:');
    });

    it('[CB.67] sin el paralelo: si la descarga cubre desde el último día del libro, puede; si no, dice qué falta y no hay botón', () => {
      const sinP = (cubre: boolean, motivo: string | null) => ({ desde: '2026-11-10', ultimo_del_libro: '2026-11-10', cubre, motivo });
      const contra: ContraElLibro = { desde: '2026-09-27', cuentas: [
        cuentaB('q', 'BBVA 6721', { resumen: resumenC({ cuadra: 8 }), listo_para_banco: listo(8), sin_paralelo: sinP(true, null) }),
        cuentaB('t', 'STDR 1621', { resumen: resumenC({ cuadra: 0 }), listo_para_banco: listo(0),
          sin_paralelo: sinP(false, 'el libro llega al 2026-11-03 y la descarga empieza el 2026-11-10: falta bajar del 2026-11-03 al 2026-11-09') }),
      ] };
      const { cmp, fx, el, confirmaciones, usados } = montar({ contra, usar: () => USO });
      const [b6721, s1621] = ['BBVA 6721', 'STDR 1621'].map((a) => cmp.cuentasContra().find((c) => c.alias === a)!);
      expect(cmp.dejar(b6721)).toMatchObject({ texto: 'puede usar el banco', accion: true });
      expect(cmp.dejar(s1621)).toMatchObject({ texto: 'no puede: el libro llega al 2026-11-03 y la descarga empieza el 2026-11-10: falta bajar del 2026-11-03 al 2026-11-09', accion: false });
      expect(boton(el, 'STDR 1621')).toBeNull();
      cmp.pedirUsarElBanco(s1621);
      expect(confirmaciones).toEqual([]); // [negativa] ni por código se puede pedir
      boton(el, 'BBVA 6721')!.click();
      fx.detectChanges();
      expect(cmp.desdeDe(b6721)).toBe('2026-11-10');
      expect(document.body.textContent).toContain('Sin el paralelo de 10 días');
      confirmaciones[0].accept!();
      expect(usados).toEqual(['q']);
    });

    it('[negativa] sin la comparación no se afirma si la descarga alimenta o no Movimientos', () => {
      const { cmp } = montar({ contra: Object.assign(new Error('500'), { status: 500 }) });
      expect(cmp.textoAlimenta()).toBe('');
    });
  });

  describe('[CB.63] lo que falta subir hoy', () => {
    // El jueves 12-nov-2026 a media mañana, como en prod: unas cuentas subidas hoy, otras el lunes o ayer, una nunca.
    const sub = (alias: string, bank: string, hasta: string | null, ultima_subida: string | null, con_lector = true) =>
      ({ id: alias, bank, alias, hasta, ultima_subida, archivos: ultima_subida ? 1 : 0, sin_testigo: 0, con_lector });
    const datos = (...cuentas: ReturnType<typeof sub>[]): ArchivosDelBanco => ({ archivos: [], total: 0, tope: 100, cuentas });
    const montarEl = (hoy: string, d: ArchivosDelBanco) => {
      const m = montar({ datos: d });
      m.cmp.hoy.set(hoy);
      m.fx.detectChanges();
      return m;
    };

    it('dice cuántas se subieron hoy y, por banco, cuáles faltan y desde qué día bajarlas', () => {
      const { cmp, el } = montarEl('2026-11-12', datos(
        sub('BB 3660', 'BBAJIO', '2026-11-06', '2026-11-10T15:43:00Z'),
        sub('BB 4166', 'BBAJIO', '2026-11-12', '2026-11-12T14:43:00Z'),
        sub('STDR 5565', 'SANTANDER', null, null),
        sub('BBVA 2182', 'BBVA', '2026-11-11', '2026-11-11T14:59:00Z'),
        sub('BNMX 9999', 'BANAMEX', null, null, false),
      ));
      const [subidas] = cmp.resumen();
      expect(subidas.label).toBe('Subidas hoy');
      expect(subidas.value).toBe('1 de 4');
      expect(subidas.sub).toBe('faltan 3');
      expect(cmp.resumen().map((i) => i.label)).not.toContain('La más atrasada llega al');
      const lista = el.querySelector('.eb-pend')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(lista).toContain('Por subir hoy: 3 cuentas.');
      expect(lista).toContain('STDR 5565 nunca se ha subido');
      expect(lista).toContain('BB 3660 desde el 06/11');
      expect(lista).toContain('BBVA 2182 desde el 11/11');
      expect(lista).not.toContain('BB 4166');
      expect(lista).not.toContain('BNMX');
      // Lo que nunca se subió va primero, después el banco de la cuenta más atrasada.
      expect(cmp.porSubir()!.porBanco.map((g) => g.banco)).toEqual(['Santander', 'BanBajío', 'BBVA']);
    });

    it('[negativa] una cuenta quieta bajada hoy está al día, aunque su último movimiento sea de hace días', () => {
      const { cmp, el } = montarEl('2026-11-12', datos(sub('BBVA 5712', 'BBVA', '2026-11-06', '2026-11-12T14:19:00Z')));
      expect(cmp.resumen()[0].value).toBe('1 de 1');
      expect(cmp.resumen()[0].sub).toBe('todas');
      expect(el.querySelector('.eb-pend')).toBeNull();
    });

    it('[negativa] el día se cuenta en la Ciudad de México: lo subido a las 23:30 del 11 no es de hoy', () => {
      // 2026-11-12T05:30Z = 11-nov 23:30 en MX. Con el día en UTC contaría como subida el 12.
      const { cmp } = montarEl('2026-11-12', datos(sub('BB 854', 'BBAJIO', '2026-11-11', '2026-11-12T05:30:00Z')));
      expect(cmp.porSubir()!.faltan).toBe(1);
    });

    it('en sábado se mide contra el viernes, y lo dice', () => {
      const { cmp, el } = montarEl('2026-11-14', datos(
        sub('BB 3660', 'BBAJIO', '2026-11-13', '2026-11-13T15:00:00Z'),
        sub('BB 506', 'BBAJIO', '2026-11-11', '2026-11-12T15:00:00Z'),
      ));
      expect(cmp.resumen()[0].label).toBe('Subidas desde el viernes');
      expect(cmp.resumen()[0].value).toBe('1 de 2');
      expect(el.querySelector('.eb-pend')?.textContent).toContain('Sin subir desde el viernes: 1 cuenta.');
    });

    it('[negativa] una API sin la última subida (anterior a CB.63) no afirma qué falta: queda el resumen de antes', () => {
      const { cmp, el } = montarEl('2026-11-12', DATOS);
      expect(cmp.porSubir()).toBeNull();
      expect(el.querySelector('.eb-pend')).toBeNull();
      expect(cmp.resumen()[0].label).toBe('Cuentas con descarga');
    });
  });
});
