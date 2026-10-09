// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RA.CAP]` — El candado del puente entre el pedido y la deuda del proveedor (punto 3 de Edgar).
 *
 * ⛔ **Lo que esta fase NO entrega, y hay que decirlo cada vez:** la *capacidad de pago*. Medido
 * contra prod el 2026-10-09, `budget.daily_capacity` tiene **22 filas, todas de septiembre** (o
 * sea vencidas al 9 de octubre), y `finance.payment_calendar_lots`,
 * `finance.financial_commitments` y `commercial.supplier_payment_obligations` están **en 0**.
 * Nadie captura cuánto se puede pagar por día. Condicionar el pedido a una capacidad inventada
 * sería peor que no condicionarlo.
 *
 * Lo que sí entrega es la mitad que tiene dato: **lo que YA se le debe** a ese proveedor.
 */

const DIR = __dirname;
const CTRL = readFileSync(join(DIR, 'creditor-statements.controller.ts'), 'utf8');
const SVC = readFileSync(join(DIR, 'creditor-statements.service.ts'), 'utf8');

/**
 * ⛔⛔ **Quita los comentarios antes de medir.** Es la TERCERA vez en este repo que un candado de
 * rutas nace roto por lo mismo: el bloque de una ruta llega hasta el decorador siguiente y por el
 * camino se traga el **JSDoc de la que viene** — que, siendo un comentario que EXPLICA la regla,
 * nombra justo las palabras que la aserción busca. Así, escribir un comentario entre dos rutas
 * pone el candado rojo con el código correcto, y una negativa (`not.toContain`) falla por prosa.
 *
 * Pasó en `requisicion.autorizar.spec.ts`, en `existencia.filtros.spec.ts` y acá. La diferencia es
 * que esta vez el arreglo no es mover el corte: es **medir código, no redacción**.
 */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const CODIGO = sinComentarios(CTRL);

function pos(ruta: string): number {
  return CODIGO.indexOf(ruta === '' ? '@Get()' : `@Get('${ruta}')`);
}

/** El bloque de UNA ruta, YA sin comentarios: hasta el decorador de la siguiente. */
function bloqueDe(ruta: string): string {
  const i = pos(ruta);
  if (i < 0) throw new Error(`No existe la ruta @Get('${ruta}')`);
  const resto = CODIGO.slice(i + 1);
  const sig = resto.search(/@(Get|Post|Put|Patch|Delete)\(/);
  return sig < 0 ? CODIGO.slice(i) : CODIGO.slice(i, i + 1 + sig);
}

describe('[RA.CAP] el arnés', () => {
  it('encuentra las tres rutas', () => {
    expect(pos('')).toBeGreaterThan(0);
    expect(pos('por-proveedor')).toBeGreaterThan(0);
    expect(pos(':codigo')).toBeGreaterThan(0);
  });

  it('y falla fuerte si una se renombra', () => {
    expect(() => bloqueDe('no-existe')).toThrow(/No existe la ruta/);
  });
});

describe('[RA.CAP] el orden de las rutas — la trampa del 200 vacío', () => {
  it('⛔ `por-proveedor` va ANTES que `:codigo`', () => {
    // Si fuera después, Nest serviría /por-proveedor como "el estado de cuenta del acreedor cuyo
    // código es 'por-proveedor'": HTTP 200 con un estado vacío, que es peor que un error. Este
    // repo ya lo pagó en la Fase LC con `no-asociados` y otra vez en `[EX.7]`.
    expect(pos('por-proveedor')).toBeLessThan(pos(':codigo'));
  });
});

describe('[RA.CAP] el permiso: el comprador tiene que poder leerla', () => {
  it('⭐ `por-proveedor` acepta TAMBIÉN el permiso del Pedido', () => {
    // Un comprador no tiene permiso de Finanzas. Sin esto el panel le llega vacío y sin decir por
    // qué — indistinguible de "no le debemos nada", que es la trampa de `[EX.7]`.
    const b = bloqueDe('por-proveedor');
    expect(b).toContain('RequireAnyPermission');
    expect(b).toContain('COMPRAS_PEDIDO_VER');
    expect(b).toContain('FINANCE_PAYMENTS_VER');
  });

  it('⛔ NEGATIVA: el estado de cuenta COMPLETO sigue siendo sólo de Finanzas', () => {
    // Lo que se abrió es el SALDO, no el detalle de documentos de cada acreedor.
    const b = bloqueDe(':codigo');
    expect(b).toContain('FINANCE_PAYMENTS_VER');
    expect(b).not.toContain('COMPRAS_PEDIDO_VER');
  });

  it('⛔ y el resumen completo de Finanzas tampoco se abrió', () => {
    expect(bloqueDe('')).not.toContain('COMPRAS_PEDIDO_VER');
  });
});

describe('[RA.CAP] una sola definición de la deuda', () => {
  it('⭐⭐ `por-proveedor` REUSA `resumen()`, no una consulta nueva', () => {
    // Si la deuda se calculara dos veces, Compras y Finanzas publicarían números distintos del
    // mismo proveedor y nadie sabría cuál creer.
    expect(bloqueDe('por-proveedor')).toContain('this.svc.resumen()');
  });

  it('⛔ NEGATIVA: el controlador no CONSULTA nada por su cuenta', () => {
    // ⚠️ La primera versión buscaba la cadena `kdxe` y salía roja con el código correcto: el
    // `@ApiOperation` de `:codigo` la nombra EN SU TEXTO, a propósito, para que la documentación
    // diga de dónde sale el dato. Nombrar una tabla no es consultarla.
    // Lo que de verdad significa "no hay un segundo SQL" es que acá no se ejecuta ninguno.
    expect(CODIGO).not.toMatch(/\.raw\(/);
    expect(CODIGO).not.toMatch(/\bSELECT\b/);
    expect(CODIGO).not.toContain('tk.run');
  });

  it('el SQL canónico sigue viviendo en el servicio, uno solo', () => {
    const n = (SVC.match(/FROM kepler_ods\.kdxe/g) || []).length;
    expect(n).toBeGreaterThan(0);
    // SQL_RESUMEN + SQL_DOCS: dos consultas con PROPÓSITOS distintos (saldo vs detalle), no dos
    // definiciones de lo mismo. Si aparece una tercera, hay que mirarla.
    expect(n).toBeLessThanOrEqual(2);
  });
});

describe('[RA.CAP] el ancho del payload', () => {
  it('⭐ viaja el saldo, NUNCA el detalle', () => {
    // Se mide el OBJETO QUE SE ARMA, no el texto del `@ApiOperation` —que dice "Sin detalle de
    // documentos" y hacía fallar la negativa con el código correcto—. La forma del payload es lo
    // que el cliente recibe; la prosa es lo que el humano lee.
    const b = bloqueDe('por-proveedor');
    const mapeo = /\.map\(\(a\) => \(\{([^}]*)\}\)\)/.exec(b)?.[1] ?? '';
    expect(mapeo).toContain('pendiente');
    expect(mapeo).toContain('vencido');
    expect(mapeo).toContain('saldo');
    // Lo que NO sale: ni el detalle de documentos, ni el RFC, ni en qué sucursales opera.
    expect(mapeo).not.toContain('documentos_pendientes');
    expect(mapeo).not.toContain('rfc');
    expect(mapeo).not.toContain('sucursales');
  });

  it('sólo los acreedores que deben algo — el que no está es "no le debemos"', () => {
    // ⚠️ `[^)]*` NO sirve acá: el predicado trae su propio paréntesis en `(a) =>`. Un candado que
    // se cae con la forma de la lambda mide sintaxis, no intención.
    expect(bloqueDe('por-proveedor')).toMatch(/\.filter\([\s\S]{0,60}pendiente > 0/);
  });

  it('⭐ y la fecha de corte viaja: sin ella "vencido" no tiene contra qué', () => {
    expect(bloqueDe('por-proveedor')).toContain('al: r.al');
  });
});
