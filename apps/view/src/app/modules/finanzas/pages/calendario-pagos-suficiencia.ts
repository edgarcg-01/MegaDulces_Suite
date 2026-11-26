import { conUnPagoMas, type CargoEsperadoDeLaCuenta, type PaymentCalendarSuficiencia, type SuficienciaDeCuenta } from '@megadulces/contracts';

/**
 * `[PGP.218]` **Qué dice el Calendario sobre el dinero de cada cuenta de origen** (anexo CR §3.0, DCR9). Pura, para
 * probarla sin montar el Calendario. La regla (el recorrido de la cuenta) vive en `@megadulces/contracts`; aquí sólo se
 * decide qué frase sale y dónde.
 *
 *  - La barra de la semana: UNA línea, sólo si alguna cuenta se queda corta. Lo que no se pudo leer o no se midió se
 *    dice; nada se calla como si alcanzara.
 *  - «Preparar pago» y «Autorizar»: lo que pasa CON ESTE PAGO en la cuenta elegida (`conUnPagoMas`).
 */

export interface Formatos {
  dinero: (n: number) => string;
  dia: (iso: string) => string;
}

/** El mismo nombre que el selector de cuenta de origen: el alias con su banco, o el banco con su cuenta. */
export function nombreCuenta(c: { bank: string; account_label: string; alias: string | null }): string {
  return c.alias ? `${c.alias} (${c.bank})` : `${c.bank} ${c.account_label}`;
}

/** Las que se quedan cortas: primero las que dejan un cargo del banco sin cubrir, y de cada grupo la que más falta. */
export function cuentasCortas(s: PaymentCalendarSuficiencia): SuficienciaDeCuenta[] {
  return s.cuentas
    .filter((c) => c.cargo_sin_cubrir !== null || c.programa_excede)
    .sort((a, b) => Number(b.cargo_sin_cubrir !== null) - Number(a.cargo_sin_cubrir !== null) || (b.faltan ?? 0) - (a.faltan ?? 0));
}

export type CargoConCuenta = CargoEsperadoDeLaCuenta & { cuenta: string; cuenta_id: string };

/**
 * Los cargos del banco del desglose, partidos: primero los de las cuentas que se quedan cortas (los que contestan la
 * pregunta del panel) y aparte los de las que sí alcanzan, que se pliegan con su número y su total. Medido en la prueba
 * visual del 2026-11-26: 25 cargos en 7 días, apilados en el celular, medían 6,185 px; 6 eran de las 2 cuentas cortas.
 * En orden de fecha, y del mismo día el más grande primero.
 */
export function cargosDelDesglose(s: PaymentCalendarSuficiencia | null): { deCortas: CargoConCuenta[]; otros: CargoConCuenta[]; otrosTotal: number } {
  if (!s) return { deCortas: [], otros: [], otrosTotal: 0 };
  const cortas = new Set(cuentasCortas(s).map((c) => c.bank_account_id));
  const todos = s.cuentas
    .flatMap((c) => c.cargos.map((x) => ({ ...x, cuenta: nombreCuenta(c), cuenta_id: c.bank_account_id })))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : b.importe - a.importe));
  const otros = todos.filter((x) => !cortas.has(x.cuenta_id));
  return { deCortas: todos.filter((x) => cortas.has(x.cuenta_id)), otros, otrosTotal: Math.round(otros.reduce((t, x) => t + x.importe * 100, 0)) / 100 };
}

export interface LineaDeLaSemana {
  /** `aviso` = una cuenta se queda corta (se abre el desglose); `quieta` = no se pudo saber, y se dice. */
  tipo: 'aviso' | 'quieta';
  texto: string;
}

const viejo = (c: SuficienciaDeCuenta) => (c.saldo_viejo ? ` (saldo de hace ${c.saldo_dias} días)` : '');

/** Sin la vista de cargos de `[PGP.209]` y sin cuenta corta: lo único que se puede decir. */
export const CARGOS_SIN_REVISAR = 'Los cargos que el banco cobra solo todavía no se pueden revisar: avisa a Sistemas.';

/**
 * La línea de la barra de la semana. `null` = no hay nada que decir (todo alcanza) o todavía está cargando.
 *
 * ⭐ Sin los cargos medidos, lo preparado SÍ se midió: la cuenta que no cubre lo preparado se nombra igual, y la
 * línea agrega que los cargos no se contaron. Medido el 2026-11-26 en la prueba visual: con la migración de PGP.209
 * sin aplicar, la línea sólo decía «no se pueden revisar» y callaba que BanBajío 4166 no cubría $610,906.94 de
 * pagos ya preparados (la tabla de abajo sí lo decía).
 */
export function lineaDeLaSemana(s: PaymentCalendarSuficiencia | null, error: boolean, f: Formatos): LineaDeLaSemana | null {
  if (error) return { tipo: 'quieta', texto: 'No se pudo revisar si las cuentas cubren los cargos del banco.' };
  if (!s) return null;
  const cortas = cuentasCortas(s);
  if (!cortas.length) return s.cargos_medidos ? null : { tipo: 'quieta', texto: CARGOS_SIN_REVISAR };
  const sinCargos = s.cargos_medidos ? '' : ' · sin contar los cargos del banco, que no se pudieron revisar';
  if (cortas.length === 1) {
    const c = cortas[0];
    const x = c.cargo_sin_cubrir;
    return {
      tipo: 'aviso',
      texto: x
        ? `${nombreCuenta(c)} no cubre el cargo del banco del ${f.dia(x.fecha)}: faltan ${f.dinero(x.faltan)}${viejo(c)}`
        : `${nombreCuenta(c)}: lo preparado pasa su saldo por ${f.dinero(c.faltan ?? 0)}${viejo(c)}${sinCargos}`,
    };
  }
  const total = cortas.reduce((t, c) => t + (c.faltan ?? 0), 0);
  const conCargo = cortas.filter((c) => c.cargo_sin_cubrir).length;
  return {
    tipo: 'aviso',
    texto: `${cortas.length} cuentas no alcanzan para lo que sale en ${s.dias} días: faltan ${f.dinero(total)}` +
      (conCargo ? ` · ${conCargo === cortas.length ? 'todas' : conCargo} con cargos del banco sin cubrir` : '') + sinCargos,
  };
}

export interface AvisoDelOrigen {
  /** `true` = con este pago algo no se cubre (se pinta como aviso); `false` = se dice en voz baja. */
  mal: boolean;
  texto: string;
}

/**
 * La línea bajo «Cuenta de origen» (Preparar) y en «Autorizar»: lo que pasa en la cuenta si además sale este pago.
 * `null` = no hay cuenta elegida, o la suficiencia todavía está cargando.
 */
export function avisoDelOrigen(
  s: PaymentCalendarSuficiencia | null, error: boolean, cuentaId: string | null | undefined,
  pago: { allocation_id: string; fecha: string; importe: number }, f: Formatos,
): AvisoDelOrigen | null {
  if (!cuentaId) return null;
  if (error) return { mal: false, texto: 'No se pudo revisar el saldo de esta cuenta.' };
  if (!s) return null;
  const c = s.cuentas.find((x) => x.bank_account_id === cuentaId);
  if (!c) return { mal: false, texto: 'De esta cuenta no se lleva saldo: no se sabe si cubre este pago.' };
  const con = conUnPagoMas(c, s.hoy, pago);
  if (!con || c.saldo === null || c.saldo_fecha === null) {
    return { mal: false, texto: `${nombreCuenta(c)}: sin saldo medido; no se sabe si cubre este pago ni sus cargos del banco.` };
  }
  const saldo = `saldo ${f.dinero(c.saldo)} al ${f.dia(c.saldo_fecha)}${c.saldo_viejo ? `, de hace ${c.saldo_dias} días` : ''}`;
  const sinMedir = s.cargos_medidos ? '' : ' Los cargos que el banco cobra solo no se midieron.';
  const x = con.cargo_sin_cubrir;
  if (x) {
    return {
      mal: true,
      texto: `Con este pago, ${nombreCuenta(c)} no cubre el cargo del banco del ${f.dia(x.fecha)} (${x.concepto}${x.estimado ? ', estimado' : ''}, ` +
        `${f.dinero(x.importe)}): faltan ${f.dinero(x.faltan)}. ${saldo[0].toUpperCase()}${saldo.slice(1)}.`,
    };
  }
  const otros = c.programado - (con.ya_contado ? pago.importe : 0);
  const desglose = [
    otros > 0.005 ? `${f.dinero(otros)} ya preparado` : '',
    c.cargos_total > 0.005 ? `${f.dinero(c.cargos_total)} de cargos del banco en ${s.dias} días` : '',
  ].filter(Boolean).join(' y ');
  if (con.faltan > 0) {
    return { mal: true, texto: `Con este pago, ${nombreCuenta(c)} queda corta por ${f.dinero(con.faltan)}: ${saldo}${desglose ? `, ${desglose}` : ''}.${sinMedir}` };
  }
  return { mal: false, texto: `${nombreCuenta(c)}: ${saldo}. Con este pago${desglose ? ` y ${desglose}` : ''} quedan ${f.dinero(con.disponible)}.${sinMedir}` };
}
