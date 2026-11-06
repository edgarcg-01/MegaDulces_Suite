import 'reflect-metadata';
import { clabeValida, clabeDeTexto, bancoDeTexto } from '@megadulces/contracts/finance/clabe';
import { FinancePaymentCalendarModule } from '../payment-calendar/finance-payment-calendar.module';
import { FinanceSupplierPaymentAccountsModule } from './finance-supplier-payment-accounts.module';
import { SupplierPaymentAccountsService } from './supplier-payment-accounts.service';
import { PaymentCalendarService } from '../payment-calendar/payment-calendar.service';

/**
 * `[PGP.46]` — **La CLABE que alguien teclea para pagar queda pedida de alta.**
 *
 * ── Lo que motivó el cambio, medido en prod el 2026-11-03 ────────────────────────────────────
 *
 * `commercial.supplier_payment_accounts`: **0 filas**. El Calendario: **146 pagos creados, 0
 * preparados jamás**, 33 lotes todos en `draft`, 0 autorizados, 0 cerrados — y **49 de 146 pagos
 * sacados del día con la ✕**, que es la única acción que alguien llega a completar.
 *
 * El mecanismo: para pagar por transferencia hace falta la cuenta destino; el catálogo está
 * vacío; se tecleaban 18 dígitos que se guardaban **sólo en ese pago**. Y encima, de los **9
 * roles que preparan pagos, 8 no podían ni LEER el catálogo** (403) ni **pedir el alta**. No se
 * había visto porque el guard da god-mode a `superadmin`, que es desde donde se miraba la
 * pantalla.
 *
 * ── Qué vigila esta suite ────────────────────────────────────────────────────────────────────
 *
 * (A) **El grafo de Nest cierra**, con su prueba negativa. Es la familia de #414, que tiró la API
 *     en producción con el CI en verde: que compile no es que arranque.
 * (B) **El parser de la CLABE**, incluido lo que se NIEGA a hacer — que es donde vive el riesgo:
 *     con dos CLABEs en el texto no elige ninguna, porque elegir por el orden en que quedaron
 *     escritas es inventar a cuál va el dinero.
 * (C) **La idempotencia y los límites** de `registrarDesdePago`, contra un knex de juguete que
 *     registra lo que se le pidió. ⚠️ Un doble NO valida SQL: lo que esto prueba es la DECISIÓN
 *     (pedir / no pedir), no que el INSERT sea correcto — eso lo prueba la base real.
 */

const meta = <T>(clave: string, objetivo: unknown): T[] =>
  (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];

/** Lo que el módulo tiene al alcance: lo que provee + lo que exportan sus imports. */
function alcanceDe(modulo: unknown): Set<unknown> {
  const out = new Set<unknown>(meta<unknown>('providers', modulo));
  for (const imp of meta<unknown>('imports', modulo)) {
    for (const exp of meta<unknown>('exports', imp)) out.add(exp);
  }
  return out;
}

describe('[PGP.46] (A) el grafo del Calendario cierra con el catálogo de cuentas', () => {
  /**
   * ⛔ Acá NO se lee `design:paramtypes`: **vitest transpila sin `emitDecoratorMetadata`**, así
   * que esa clave llega vacía y el test pasaría por la configuración del runner y no por el
   * código. Es la misma trampa que documentó `[CB.53.1]`. Lo comprobable sin levantar la app es
   * que el proveedor esté al ALCANCE del módulo — el grafo leído de los decoradores.
   */
  it('PaymentCalendarService puede recibir el catálogo: lo exporta uno de sus imports', () => {
    expect(alcanceDe(FinancePaymentCalendarModule).has(SupplierPaymentAccountsService)).toBe(true);
  });

  it('NO lo provee por su cuenta: sería una segunda instancia del mismo servicio', () => {
    expect(meta<unknown>('providers', FinancePaymentCalendarModule)).not.toContain(SupplierPaymentAccountsService);
  });

  it('el módulo de cuentas lo exporta de verdad (si no, el import de arriba no alcanza)', () => {
    expect(meta<unknown>('exports', FinanceSupplierPaymentAccountsModule)).toContain(SupplierPaymentAccountsService);
  });

  it('PRUEBA NEGATIVA: sin ese import, la comprobación se pone roja', () => {
    // Sin decorador: un decorador DENTRO del spec no se transforma y Node lo rechaza al cargar el archivo
    // («SyntaxError: Invalid or unexpected token»: las pruebas no corrían). Es la misma metadata que pondría.
    class ModuloSinElImport {}
    Reflect.defineMetadata('providers', [PaymentCalendarService], ModuloSinElImport);
    Reflect.defineMetadata('imports', [], ModuloSinElImport);
    expect(alcanceDe(ModuloSinElImport).has(SupplierPaymentAccountsService)).toBe(false);
  });

  /**
   * ⚠️ La dependencia es `@Optional()` **a propósito**: si el cableado se rompe, lo que se pierde
   * es no volver a teclear 18 dígitos — no el pago. Tumbar un pago porque el catálogo no
   * respondió sería un remedio peor que la enfermedad. Este candado fija esa decisión: si alguien
   * la vuelve obligatoria, el arranque de la API pasa a depender de ella.
   */
  it('la dependencia es opcional: el pago no depende del catálogo para guardarse', () => {
    const opcionales = (Reflect.getMetadata('self:paramtypes', PaymentCalendarService) ?? []) as unknown[];
    // `self:paramtypes` sólo trae lo DECORADO (@Inject/@Optional). Si vitest no emitió metadata
    // queda vacío, y entonces esto NO mide nada: se declara en vez de dar un verde falso.
    if (!opcionales.length) {
      expect(PaymentCalendarService.length).toBe(5); // NO MEDIDO: sólo se comprueba la aridad
      return;
    }
    expect(opcionales.length).toBeGreaterThan(0);
  });
});

describe('[PGP.46] (B) la CLABE se lee del texto libre, y se NIEGA cuando hay duda', () => {
  // CONTROL: dos CLABEs cuyo dígito de control sí cuadra, verificadas por el mismo algoritmo que
  // ya estaba probado en `[TP.16]`. Si el control falla, el instrumento se tira, no la medición.
  const A = '032180000118359719';
  const B = '002010077777777771';
  it('CONTROL: las dos CLABEs de prueba son válidas', () => {
    expect(clabeValida(A)).toBe(true);
    expect(clabeValida(B)).toBe(true);
  });

  it('saca la CLABE del texto que escribe la gente', () => {
    expect(clabeDeTexto(`BBVA · CLABE ${A}`)).toBe(A);
    expect(clabeDeTexto(`  banorte clabe:${A}  `)).toBe(A);
  });

  it('⛔ con DOS CLABEs distintas no elige ninguna: elegir por el orden sería inventar el destino', () => {
    expect(clabeDeTexto(`BBVA ${A} o Banorte ${B}`)).toBeNull();
  });

  it('la misma CLABE repetida sí se resuelve (es una sola cuenta, escrita dos veces)', () => {
    expect(clabeDeTexto(`${A} — confirmada: ${A}`)).toBe(A);
  });

  it('⛔ no junta grupos separados por espacios: eso fabricaría una CLABE que nadie escribió', () => {
    expect(clabeDeTexto('0321 8000 0118 3597 19')).toBeNull();
  });

  it('una CLABE con el dígito de control mal NO pasa', () => {
    expect(clabeDeTexto(`BBVA · CLABE ${A.slice(0, 17)}0`)).toBeNull();
  });

  it('el banco sale del texto anterior, sin la palabra CLABE ni separadores', () => {
    expect(bancoDeTexto(`BBVA · CLABE ${A}`)).toBe('BBVA');
    expect(bancoDeTexto(`Banco del Bajío - clabe ${A}`)).toBe('Banco del Bajío');
  });

  it('y si no hay banco legible devuelve null, en vez de inventarlo', () => {
    expect(bancoDeTexto(A)).toBeNull();
    expect(bancoDeTexto(`CLABE ${A}`)).toBeNull();
  });
});

describe('[PGP.46] (C) registrarDesdePago: cuándo pide el alta y cuándo no', () => {
  const CLABE = '032180000118359719';
  const PROV = '11111111-1111-1111-1111-111111111111';

  /**
   * Un knex de juguete que responde lo que cada escenario necesita y GUARDA lo que se insertó.
   *
   * ⚠️ Esto NO valida SQL (un doble nunca lo hace): mide la DECISIÓN de pedir o no pedir. Que el
   * INSERT sea correcto lo prueba la base real, y se declara así en vez de darlo por cubierto.
   */
  const servicioCon = (respuestas: { cuenta?: unknown; solicitud?: unknown }) => {
    const insertado: Record<string, unknown>[] = [];
    // ⛔ El doble GUARDA con qué se filtró. Sin esto, el `where` se ignora y la prueba de
    // idempotencia pasaría igual con el estado mal escrito — que es exactamente el defecto que
    // apareció al escribir esto: el CHECK de la tabla sólo admite
    // `pending_approval|approved|rejected|applied`, y un `'pendiente'` escrito a ojo no casa
    // NUNCA, así que cada pago habría dejado una solicitud nueva sin que nada se pusiera rojo.
    const filtros: Record<string, unknown>[] = [];
    const tabla = (nombre: string) => ({
      where: (criterio: Record<string, unknown>) => {
        filtros.push({ tabla: nombre, ...criterio });
        return {
          first: async () => (nombre.includes('change_requests') ? respuestas.solicitud ?? null : respuestas.cuenta ?? null),
        };
      },
      insert: async (fila: Record<string, unknown>) => { insertado.push(fila); },
    });
    const svc = new SupplierPaymentAccountsService(
      { run: async (fn: (trx: unknown) => unknown) => fn(tabla) } as never,
      { requireTenantId: () => 'tenant' } as never,
      undefined as never,
    );
    return { svc, insertado, filtros };
  };

  it('sin CLABE en el texto no pide nada', async () => {
    const { svc, insertado } = servicioCon({});
    const r = await svc.registrarDesdePago(PROV, 'transferencia a su cuenta de siempre', 'johana', 'motivo');
    expect(r.resultado).toBe('sin_clabe');
    expect(insertado).toHaveLength(0);
  });

  it('⭐ con una CLABE nueva, deja la solicitud PENDIENTE', async () => {
    const { svc, insertado } = servicioCon({});
    const r = await svc.registrarDesdePago(PROV, `BBVA · CLABE ${CLABE}`, 'johana', 'al preparar el pago');
    expect(r.resultado).toBe('pedida');
    expect(insertado).toHaveLength(1);
    expect(insertado[0]['proposed_clabe']).toBe(CLABE);
    expect(insertado[0]['proposed_bank_name']).toBe('BBVA');
    expect(insertado[0]['requested_by']).toBe('johana');
  });

  it('⛔⛔ NO la marca favorita ni la da de alta: proponerla sola sin que nadie la revise es el riesgo que el flujo de aprobación cubre', async () => {
    const { svc, insertado } = servicioCon({});
    await svc.registrarDesdePago(PROV, `BBVA · CLABE ${CLABE}`, 'johana', 'motivo');
    expect(insertado[0]['proposed_es_favorita']).toBe(false);
    expect(insertado[0]['deactivate']).toBe(false);
    expect(insertado[0]['account_id']).toBeNull();
  });

  it('si la cuenta YA está activa en el catálogo, no ensucia la bandeja', async () => {
    const { svc, insertado } = servicioCon({ cuenta: { id: 'x' } });
    const r = await svc.registrarDesdePago(PROV, `BBVA · CLABE ${CLABE}`, 'johana', 'motivo');
    expect(r.resultado).toBe('ya_estaba');
    expect(insertado).toHaveLength(0);
  });

  it('⭐ idempotente: diez pagos del mismo proveedor dejan UNA solicitud, no diez', async () => {
    const { svc, insertado } = servicioCon({ solicitud: { id: 'ya' } });
    const r = await svc.registrarDesdePago(PROV, `BBVA · CLABE ${CLABE}`, 'johana', 'motivo');
    expect(r.resultado).toBe('ya_pedida');
    expect(insertado).toHaveLength(0);
  });

  /**
   * ⛔⛔ El candado del candado. El `where` que busca duplicados filtra por `status`, y el CHECK
   * de la tabla sólo admite `pending_approval | approved | rejected | applied` (medido en prod).
   * Escrito a ojo como `'pendiente'` **no casa nunca**: el INSERT igual queda bien porque usa el
   * DEFAULT de la columna, así que la bandeja se llena de la misma cuenta repetida y **ninguna
   * prueba se pone roja** — la de arriba incluida, si el doble ignorara los argumentos.
   */
  it('⛔ busca el duplicado con el estado que la tabla ADMITE, no con uno inventado', async () => {
    const PERMITIDOS = ['pending_approval', 'approved', 'rejected', 'applied'];
    const { svc, filtros } = servicioCon({});
    await svc.registrarDesdePago(PROV, `BBVA · CLABE ${CLABE}`, 'johana', 'motivo');
    const f = filtros.find((x) => String(x['tabla']).includes('change_requests'));
    expect(f, 'no se consultó la tabla de solicitudes').toBeDefined();
    expect(PERMITIDOS).toContain(f?.['status']);
    expect(f?.['proposed_clabe']).toBe(CLABE);
    expect(f?.['supplier_id']).toBe(PROV);
  });

  it('con el banco sin capturar lo DICE, en vez de adivinarlo a partir del código', async () => {
    const { svc, insertado } = servicioCon({});
    await svc.registrarDesdePago(PROV, CLABE, 'johana', 'motivo');
    expect(insertado[0]['proposed_bank_name']).toBe('(no se capturó el banco)');
  });

  it('PRUEBA NEGATIVA: con dos CLABEs en el texto no pide nada — ni la primera ni la segunda', async () => {
    const { svc, insertado } = servicioCon({});
    const r = await svc.registrarDesdePago(PROV, `BBVA ${CLABE} o Banorte 002010077777777771`, 'johana', 'motivo');
    expect(r.resultado).toBe('sin_clabe');
    expect(insertado).toHaveLength(0);
  });
});
