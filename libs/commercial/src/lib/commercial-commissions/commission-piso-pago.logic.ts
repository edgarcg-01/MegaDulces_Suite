/**
 * `[RD.C1.0b]` — **El piso de cero del pago al chofer, y la deducción que no cupo.**
 *
 * ── El hecho, medido en prod el 2026-11-27 ───────────────────────────────────────────────
 * El **libro** (`commission_run_lines`, lo que el Excel pagó de verdad) tiene **304 líneas de
 * chofer**. En **48** de ellas la resta `comisión + bonos − nómina` daba **negativo**… y en las
 * **48** el libro pagó **$0.00**. Pagos negativos: **0**. O sea que el Excel **sí tiene un piso
 * en cero**, y lo ejerce en el **16 %** de sus líneas: no es un caso teórico.
 *
 * El motor no lo tenía: restaba sin piso. Hoy eso no cambia ningún peso publicado —medido el
 * mismo día: **0 de 721** líneas del motor salen negativas, y la más cerca del piso le sobran
 * **$244.83** (ruta 501)— porque el corte por `chofer_bajo_piso` llega antes. Es **deuda
 * latente**, no una pérdida activa, y por eso se cierra ahora que no mueve un número.
 *
 * ⛔ **El piso no puede tragarse la deducción en silencio.** Si la nómina es mayor que lo
 * ganado, hay pesos que el sistema mandó descontar y **no se descontaron**. Cada peso lleva una
 * explicación: la línea publica cuánto se aplicó, cuánto no, y lo dice con el estado
 * `tope_piso`. ⚠️ Los dos montos salen de columnas que la línea ya tiene
 * (`comision`, `bonos`, `nomina_banco`, `a_pagar`), así que esto **no agrega columnas**.
 *
 * ⭐ El piso es por **línea**, no por persona, igual que el libro. Medido el mismo día:
 * **ningún chofer activo tiene más de una ruta**, así que las dos lecturas coinciden hoy; si
 * mañana un chofer maneja dos rutas, la nómina se le restaría **una vez por ruta** y eso es
 * otro defecto, anotado en `[RD.C1.0d]`.
 */

/** Redondeo a centavos. Mismo criterio que el resto del motor. */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PagoDelChofer {
  /** Lo que se le paga. **Nunca negativo.** */
  a_pagar: number;
  /** De la nómina mandada a descontar, cuánto alcanzó a descontarse. */
  deduccion_aplicada: number;
  /** Lo que la nómina mandaba descontar y el piso no dejó. **Se publica, no se olvida.** */
  deduccion_no_aplicada: number;
  /**
   * `no_aplica` — no hay nómina que descontar · `aplicada` — se descontó entera ·
   * `tope_piso` — el pago llegó a cero y **quedó deducción sin aplicar**.
   */
  deduccion_status: 'no_aplica' | 'aplicada' | 'tope_piso';
}

/**
 * El pago de una línea de chofer, con el piso del libro.
 *
 * ⚠️ `bruto` puede llegar negativo sólo si alguien configura una comisión negativa; el piso lo
 * tapa igual y `deduccion_aplicada` no se vuelve negativa.
 */
export function pagoDelChofer(comision: number, bonos: number, nomina: number): PagoDelChofer {
  const bruto = comision + bonos;
  const mandada = Math.max(0, nomina);
  const aplicada = Math.min(mandada, Math.max(0, bruto));
  return {
    a_pagar: r2(Math.max(0, bruto - mandada)),
    deduccion_aplicada: r2(aplicada),
    deduccion_no_aplicada: r2(mandada - aplicada),
    deduccion_status: mandada <= 0 ? 'no_aplica' : (aplicada < mandada ? 'tope_piso' : 'aplicada'),
  };
}
