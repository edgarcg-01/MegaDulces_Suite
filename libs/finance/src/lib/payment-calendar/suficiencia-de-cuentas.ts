/**
 * `[PGP.218]` La regla de suficiencia vive en `@megadulces/contracts` (`finance/suficiencia-de-cuentas.contract.ts`):
 * la usan el servidor (`leerEntradaDeSuficiencia` + `armarSuficiencia`) y la pantalla de «Preparar pago»
 * (`conUnPagoMas`). Aquí sólo se re-exporta para la lectura del servidor y sus pruebas: una regla, no dos.
 */
export {
  DIAS_CARGO_DETENIDO, DIAS_DE_LA_VENTANA, DIAS_SALDO_VIEJO, armarSuficiencia, conUnPagoMas, masDias,
} from '@megadulces/contracts';
export type {
  CuentaDeOrigen, EntradaDeSuficiencia, PagoConCuenta, SerieEsperada, SaldoDeLaCuenta,
} from '@megadulces/contracts';
