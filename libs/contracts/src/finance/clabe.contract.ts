/**
 * `[PGP.46]` — **La CLABE, en un solo lugar.**
 *
 * Nació en `[TP.16]` dentro de `payment-calendar.service.ts`, que era su único consumidor. Hoy la
 * necesitan **dos**: el Calendario, para rechazar un error de dedo antes de que lo rechace el
 * banco; y el catálogo de cuentas de proveedor, para decidir si lo que alguien tecleó al preparar
 * un pago merece quedar pedido de alta.
 *
 * ⛔ **Por qué se mudó acá y no se importó de allá.** `payment-calendar.service` va a llamar al
 * servicio de cuentas, así que si el servicio de cuentas importara de `payment-calendar.service`
 * quedaría un **ciclo de importación entre archivos**. Un ciclo en TypeScript no falla al
 * compilar: falla en tiempo de ejecución, con uno de los dos módulos a medio inicializar y un
 * `undefined` donde debía haber una función. Es la clase de defecto que aparece en producción y no
 * en las pruebas.
 *
 * ⭐ Y es lo que pide ADR-056: un primitivo que usan dos fases vive en `libs/`, no en la fase que
 * lo inventó. `payment-calendar.service` lo **re-exporta** para no tocar a sus consumidores.
 */

/**
 * ¿El dígito de control de esta CLABE cuadra? (Banxico: pesos 3·7·1 sobre los primeros 17
 * dígitos, se suma `(dígito × peso) mod 10`, y el control es `(10 − suma mod 10) mod 10`.)
 *
 * ⚠️ Un `true` dice que la CLABE **está bien formada**, no que la cuenta exista ni que sea de ese
 * proveedor. El dígito de control caza el error de dedo, no el error de persona.
 */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(clabe[i]) * pesos[i % 3]) % 10;
  return (10 - (suma % 10)) % 10 === Number(clabe[17]);
}

/**
 * La ÚNICA CLABE que lleva un texto libre como «BBVA · CLABE 012180001234567891», o `null`.
 *
 * ⛔ Devuelve `null` —en vez de la primera que encuentre— cuando el texto trae **más de una**
 * corrida de 18 dígitos válida. Si alguien pegó dos cuentas, elegir una por el orden en que
 * quedaron escritas es inventar a cuál va el dinero.
 *
 * ⛔ Y sólo mira corridas de dígitos **contiguas**: juntar grupos separados por espacios
 * fabricaría una CLABE que nadie escribió. Es la misma regla que ya aplica el Calendario al
 * validar lo capturado a mano.
 */
export function clabeDeTexto(texto: string | null | undefined): string | null {
  // El tipo se anota: `match(...) ?? []` da `RegExpMatchArray | never[]`, y sobre esa unión el
  // `.filter` de abajo infiere `never` (TS2339 sobre `.length`). Lo cazó `tsc`, no vitest.
  const corridas: string[] = (texto ?? '').match(/\d+/g) ?? [];
  const validas = [...new Set(corridas.filter((r) => r.length === 18 && clabeValida(r)))];
  return validas.length === 1 ? validas[0] : null;
}

/**
 * El nombre del banco que acompaña a la CLABE en ese mismo texto libre, o `null`.
 *
 * ⚠️ Es **lo que la persona escribió**, no una resolución del código de banco: se toma el tramo
 * anterior a la CLABE, sin la palabra «CLABE» ni los separadores. Si no quedó nada legible
 * devuelve `null`, y quien lo use tiene que decidir qué hacer con eso — nunca inventarle un banco.
 */
export function bancoDeTexto(texto: string | null | undefined): string | null {
  const t = (texto ?? '').trim();
  const clabe = clabeDeTexto(t);
  if (!clabe) return null;
  const antes = t.slice(0, t.indexOf(clabe));
  const limpio = antes.replace(/clabe/gi, '').replace(/[·|,;:\-–—/]+/g, ' ').replace(/\s+/g, ' ').trim();
  return limpio || null;
}
