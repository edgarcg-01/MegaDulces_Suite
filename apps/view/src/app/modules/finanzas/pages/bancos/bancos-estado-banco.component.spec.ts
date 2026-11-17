import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { BancosEstadoBancoComponent } from './bancos-estado-banco.component';
import { ArchivoEstadoBanco, ArchivosDelBanco, BankService, CuadreDeCuentas, CuadreDeLaDescarga, CuentaEnCuadre, RevisionEstadoBanco, UsoDelBanco } from '../../bank.service';
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

/** [CB.73] El cuadre de la descarga por cuenta, con la forma de los casos de prod del 2026-11-17 (importes inventados salvo BB 854). */
const q = (p: Partial<CuadreDeLaDescarga> = {}): CuadreDeLaDescarga => ({ desde: '2026-11-03', hasta: '2026-11-13', archivos: 2, entrada: 'cuadra',
  testigo: { fecha: '2026-10-31', saldo: 100 }, abre: 100, rotura: null, cuadra: true, motivo: null, ...p });
const cuentaQ = (id: string, alias: string, cuadre: CuadreDeLaDescarga, p: Partial<CuentaEnCuadre> = {}): CuentaEnCuadre =>
  ({ id, alias, banco_desde: null, cuadre, sucursales: null, ...p });
const MOTIVO_854 = 'el saldo no sigue entre el 10/11 y el 12/11 (cerró en $54,067.52 y abre en $120,284.42): baja un solo archivo del 10/11 a hoy';
const CUADRE: CuadreDeCuentas = { cuentas: [
  cuentaQ('p', 'BB 4166', q(), { sucursales: { con_sucursal_libro: 100, deducidas: 80, coinciden: 79, sin_senal: 20 } }),
  cuentaQ('r', 'BTE 3041', q(), { banco_desde: '2026-11-03' }),
  cuentaQ('n', 'BB 854', q({ cuadra: false, motivo: MOTIVO_854, rotura: { despues_de: '2026-11-10', antes_de: '2026-11-12', cierra: 54067.52, abre: 120284.42 } })),
  cuentaQ('z', 'STDR 5565', q({ desde: null, hasta: null, archivos: 0, entrada: null, abre: null, cuadra: false, motivo: 'no hay ninguna descarga subida: baja un solo archivo del 03/08 a hoy' })),
  cuentaQ('t', 'STDR 1621', q({ desde: '2026-11-10', hasta: '2026-11-10', archivos: 1, entrada: 'sin_testigo', testigo: null })),
] };

function montar(opts: {
  cuadre?: CuadreDeCuentas | Error;
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
    cuadre: () => (opts.cuadre instanceof Error ? throwError(() => opts.cuadre) : of(opts.cuadre ?? { cuentas: [] })),
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

  describe('[CB.73] «Cuadre» en vez de «Contra el libro»: la descarga se juzga por sus saldos', () => {
    const USO: UsoDelBanco = { cuenta: 'BB 4166', desde: '2026-11-03', ya_estaba: false, llaves: 5, libro_borrados: 2, metidos: 30, en_cero: 0, sin_categoria: 0, sin_sucursal: 3 };
    const boton = (el: HTMLElement, alias: string) => el.querySelector(`button[aria-label="Usar el banco en ${alias}"]`) as HTMLButtonElement | null;

    it('el orden y las palabras: lo que no cuadra, lo que no tiene descarga, lo que puede pasar y lo que ya usa el banco', () => {
      const { cmp, el } = montar({ cuadre: CUADRE });
      expect(cmp.cuentasCuadre().map((c) => c.alias)).toEqual(['BB 854', 'STDR 5565', 'BB 4166', 'STDR 1621', 'BTE 3041']);
      expect(cmp.cuentasCuadre().map((c) => cmp.estadoCuadre(c).texto)).toEqual([
        MOTIVO_854, 'no hay ninguna descarga subida: baja un solo archivo del 03/08 a hoy', 'cuadra',
        'cuadra (no hay saldo anterior con que comparar la entrada)', 'cuadra']);
      expect(cmp.cuentasCuadre().map((c) => cmp.usar(c).texto)).toEqual(['todavía no', 'todavía no', 'puede usar el banco', 'puede usar el banco', 'usa el banco desde el 03/11']);
      expect(boton(el, 'BB 4166')).not.toBeNull();
      expect(boton(el, 'STDR 1621')).not.toBeNull();
      expect(boton(el, 'BB 854')).toBeNull();     // [negativa] lo que no cuadra no tiene botón
      expect(boton(el, 'STDR 5565')).toBeNull();  // [negativa] sin descarga tampoco
      expect(boton(el, 'BTE 3041')).toBeNull();   // [negativa] la que ya pasó no se ofrece otra vez
      const item = cmp.resumen().find((m) => m.label === 'Cuadran');
      expect(item?.value).toBe('3 de 4'); // STDR 5565 no tiene descarga: no cuenta ni a favor ni en contra
      expect(item?.sub).toBe('no cuadran BB 854 · 2 pueden usar el banco');
      expect(cmp.textoAlimenta()).toBe('En BTE 3041 ya alimenta Movimientos; las demás pasan cuando su descarga cuadra.');
      expect(el.textContent).not.toContain('Contra el libro');
      expect(el.textContent).not.toContain('Dejar el libro');
    });

    it('pulsar pide confirmar; nada pasa antes. Al aceptar pasa la cuenta desde el primer día de su descarga, lo dice y recarga', () => {
      const { cmp, fx, el, usados, confirmaciones, toasts, cargas } = montar({ cuadre: CUADRE, usar: () => USO });
      let emitidos = 0;
      cmp.guardado.subscribe(() => emitidos++);
      const antes = cargas();
      boton(el, 'BB 4166')!.click();
      fx.detectChanges();
      expect(confirmaciones.map((c) => c.header)).toEqual(['Usar el banco en BB 4166']);
      expect(usados).toEqual([]);
      expect(cmp.textoEntrada(cmp.aConfirmar()!)).toBe('Su descarga cuadra del 03/11 al 13/11, y abre en el saldo con que la cuenta cerró el 31/10.');
      expect(cmp.textoSucursal(cmp.aConfirmar()!)).toContain('acertó 79 de 80');
      expect(document.body.textContent).toContain('el primer día de su descarga');
      confirmaciones[0].accept!();
      expect(usados).toEqual(['p']);
      const t = toasts.find((x) => x.summary === 'BB 4166 usa el banco desde el 03/11');
      expect(t?.severity).toBe('warn');
      expect(t?.detail).toBe('30 movimientos de la descarga entraron a Movimientos · 3 sin sucursal · 2 renglón(es) del libro quedaron reemplazados por los del banco');
      expect(cargas()).toBe(antes + 1);
      expect(emitidos).toBe(1);
      expect(cmp.pasando()).toBeNull();
    });

    it('[negativa] cancelar no pasa nada', () => {
      const { cmp, fx, el, usados, confirmaciones } = montar({ cuadre: CUADRE, usar: () => USO });
      boton(el, 'BB 4166')!.click();
      fx.detectChanges();
      confirmaciones[0].reject!();
      expect(usados).toEqual([]);
      expect(cmp.aConfirmar()).toBeNull();
    });

    it('[negativa] una cuenta que no cuadra (o que ya pasó) no se puede pedir ni por código', () => {
      const { cmp, confirmaciones } = montar({ cuadre: CUADRE, usar: () => USO });
      cmp.pedirUsarElBanco(cmp.cuentasCuadre().find((c) => c.alias === 'BB 854')!);
      cmp.pedirUsarElBanco(cmp.cuentasCuadre().find((c) => c.alias === 'BTE 3041')!);
      expect(confirmaciones).toEqual([]);
    });

    it('[negativa] si el servidor dice que no, se muestra su motivo y la cuenta sigue con el libro', () => {
      const { cmp, toasts } = montar({ cuadre: CUADRE,
        usar: () => Object.assign(new Error('400'), { error: { message: 'BB 4166 todavía no puede usar el banco', motivos: [MOTIVO_854] } }) });
      let emitidos = 0;
      cmp.guardado.subscribe(() => emitidos++);
      cmp.usarElBanco(cmp.cuentasCuadre().find((c) => c.alias === 'BB 4166')!);
      const t = toasts.find((x) => x.severity === 'error');
      expect(t?.summary).toBe('BB 4166 sigue con el libro');
      expect(t?.detail).toContain('el saldo no sigue entre el 10/11 y el 12/11');
      expect(emitidos).toBe(0);
      expect(cmp.pasando()).toBeNull();
    });

    it('sin saldo anterior: cuadra y lo dice, y la confirmación no inventa un testigo', () => {
      const { cmp } = montar({ cuadre: CUADRE });
      const s1621 = cmp.cuentasCuadre().find((c) => c.alias === 'STDR 1621')!;
      expect(cmp.textoEntrada(s1621)).toBe('Su descarga cuadra del 10/11 al 10/11; no hay un saldo anterior de la cuenta con que comparar dónde abre.');
      expect(cmp.textoSucursal(s1621)).toBe('Del libro no se aprendió ninguna terminal ni tarjeta con su sucursal: los movimientos llegarán sin sucursal.');
    });

    it('[negativa] sin permiso de gestionar no hay botón: el estado se lee igual', () => {
      const { el } = montar({ cuadre: CUADRE, sinPermiso: true });
      expect(boton(el, 'BB 4166')).toBeNull();
      expect(el.textContent).toContain('puede usar el banco');
    });

    it('[negativa] si el cuadre no se pudo leer, se dice y no aparece ningún «Cuadran» ni se afirma qué alimenta Movimientos', () => {
      const { cmp, el } = montar({ cuadre: Object.assign(new Error('500'), { status: 500 }) });
      expect(cmp.cuentasCuadre()).toEqual([]);
      expect(cmp.resumen().some((m) => m.label === 'Cuadran')).toBe(false);
      expect(cmp.cuadreError()).toBeTruthy();
      expect(cmp.textoAlimenta()).toBe('');
      expect(el.querySelector('button[aria-label^="Usar el banco"]')).toBeNull();
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
