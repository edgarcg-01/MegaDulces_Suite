/**
 * `[CB.73]` **El cuadre de la descarga: el banco se juzga por sus saldos, no contra el libro** (Edgar, 2026-11-17:
 * «ahora hay que usar cuadre en vez de usar el libro, usa los estados de cuenta nuevos»).
 *
 * Una cuenta puede usar el banco cuando sus descargas **cuadran de punta a punta**: cada archivo abre en el saldo con
 * que la cuenta ya iba, y la primera abre en el saldo con que la cuenta cerró antes (el testigo de la entrada). El
 * banco manda desde el PRIMER día de la descarga: lo que el libro tenga de ahí en adelante se reemplaza.
 *
 * Por qué por ARCHIVO y no por renglón ni por día (medido en prod el 2026-11-17, 18 cuentas):
 *  - por renglón (`movement_date`, `seq`) salían 46 roturas falsas: `seq` es del archivo, y dos archivos encimados
 *    se intercalan mal dentro del día;
 *  - por día salía rota BBVA 5712: BBVA fecha un cargo el 03-nov y lo aplica antes que los abonos del 02 (su saldo
 *    lo pone primero). El orden del banco sólo existe dentro de su archivo, y ahí el control del lector ya exige
 *    saldo inicial + abonos − cargos = saldo final (`balance_ok`).
 *
 * Entre archivos: si uno empieza DESPUÉS del último día cubierto, tiene que abrir en el saldo con que cerró ese día
 * (los días de en medio, si los hay, no tuvieron movimientos: el saldo no se movió). Si empieza dentro de lo ya
 * cubierto (encimado), tiene que abrir en un saldo por el que la cuenta pasó esa semana.
 *
 * ⛔ El cuadre no ve renglones que falten y se anulen entre sí (una entrada y una salida iguales en una cuenta de
 * paso): ese límite es el mismo del estado de cuenta del banco, y se declara, no se esconde.
 */
export interface ArchivoParaCuadre { desde: string; hasta: string; abre: number | string; cierra: number | string; subido: string }
export interface SaldoDelBanco { fecha: string; saldo: number | string }
export interface TestigoDeEntrada { fecha: string; saldo: number }

export interface RoturaDelCuadre { despues_de: string; antes_de: string; cierra: number; abre: number }

export interface CuadreDeLaDescarga {
  /** Primer día de la descarga: desde ahí mandaría el banco. */
  desde: string | null;
  /** Último día que cubre la descarga. */
  hasta: string | null;
  archivos: number;
  /** La primera descarga abre en el saldo con que la cuenta cerró antes, o no hay con qué compararla. */
  entrada: 'cuadra' | 'no_cuadra' | 'sin_testigo' | null;
  testigo: TestigoDeEntrada | null;
  abre: number | null;
  rotura: RoturaDelCuadre | null;
  /** Se puede usar el banco: hay descarga, sigue de punta a punta y la entrada no contradice al testigo. */
  cuadra: boolean;
  motivo: string | null;
}

const centavos = (v: number | string) => Math.round(Number(v) * 100);
const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export function cuadreDeLaDescarga(
  archivosTodos: readonly ArchivoParaCuadre[], saldos: readonly SaldoDelBanco[], testigo: TestigoDeEntrada | null, hoy: string,
): CuadreDeLaDescarga {
  // dd/MM (con el año sólo si no es el de hoy): lo lee Tesorería.
  const dm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}${f.slice(0, 4) === hoy.slice(0, 4) ? '' : `/${f.slice(0, 4)}`}`;
  const bajar = (f: string) => `baja un solo archivo del ${dm(f)} a hoy`;
  const $ = (c: number) => pesos.format(c / 100);

  const archivos = [...archivosTodos].sort((a, b) => a.desde.localeCompare(b.desde) || a.hasta.localeCompare(b.hasta) || a.subido.localeCompare(b.subido));
  if (!archivos.length) {
    return { desde: null, hasta: null, archivos: 0, entrada: null, testigo, abre: null, rotura: null, cuadra: false,
      motivo: testigo ? `no hay ninguna descarga subida: ${bajar(testigo.fecha)}` : 'no hay ninguna descarga subida' };
  }
  const primero = archivos[0];
  // El primer día es la fecha más vieja de sus renglones, no el `desde` del archivo (su primer renglón): BBVA pone
  // primero un cargo fechado el 03-nov y después los abonos del 02 (BBVA 5712, medido 2026-11-17). El testigo de la
  // entrada lo pide quien llama ANTES de ese día.
  const inicio = saldos.reduce((m, s) => (s.fecha < m ? s.fecha : m), primero.desde);
  const abre = centavos(primero.abre);
  const entrada: CuadreDeLaDescarga['entrada'] = !testigo ? 'sin_testigo' : centavos(testigo.saldo) === abre ? 'cuadra' : 'no_cuadra';

  let finFecha = primero.hasta, finSaldo = centavos(primero.cierra), finSubido = primero.subido;
  let rotura: RoturaDelCuadre | null = null;
  for (const a of archivos.slice(1)) {
    const abreA = centavos(a.abre);
    if (a.desde > finFecha) {
      if (abreA !== finSaldo) { rotura = { despues_de: finFecha, antes_de: a.desde, cierra: finSaldo / 100, abre: abreA / 100 }; break; }
    } else {
      // Encimado: abre en un saldo por el que la cuenta pasó esa semana (o en el de otro archivo que arranca igual).
      const semana = sumarDias(a.desde, -7);
      const conocido = saldos.some((s) => s.fecha >= semana && s.fecha <= a.desde && centavos(s.saldo) === abreA)
        || archivos.some((b) => b !== a && b.desde <= a.desde && centavos(b.abre) === abreA);
      if (!conocido) { rotura = { despues_de: sumarDias(a.desde, -1), antes_de: a.desde, cierra: finSaldo / 100, abre: abreA / 100 }; break; }
    }
    if (a.hasta > finFecha || (a.hasta === finFecha && a.subido > finSubido)) { finFecha = a.hasta; finSaldo = centavos(a.cierra); finSubido = a.subido; }
  }

  const base = { desde: inicio, hasta: finFecha, archivos: archivos.length, entrada, testigo, abre: abre / 100, rotura };
  if (rotura) {
    return { ...base, cuadra: false,
      motivo: `el saldo no sigue entre el ${dm(rotura.despues_de)} y el ${dm(rotura.antes_de)} (cerró en ${$(centavos(rotura.cierra))} y abre en ${$(centavos(rotura.abre))}): ${bajar(rotura.despues_de)}` };
  }
  if (entrada === 'no_cuadra' && testigo) {
    return { ...base, cuadra: false,
      motivo: `la descarga abre el ${dm(inicio)} en ${$(abre)} y la cuenta cerró el ${dm(testigo.fecha)} en ${$(centavos(testigo.saldo))}: ${bajar(testigo.fecha)}` };
  }
  return { ...base, cuadra: true, motivo: null };
}
