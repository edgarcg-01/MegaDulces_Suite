import type { BloqueComisionPorRevisar, CargoComision, DiaComision, PropuestaComisiones } from '../../bank.service';
import type { MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';

/**
 * `[CB.62]` La vista «Comisiones» de Bancos, sin Angular: qué va en cada sección y en qué orden, para probarlo
 * solo. La pregunta que contesta: ¿qué comisiones del banco faltan en Kepler?
 *
 * Las secciones son las MISMAS cuatro del resumen de la API (`resumen`), que no se enciman:
 *   listos · Finanzas los dejó a medias · esperando a la sucursal · por revisar  (+ los ya completos, sólo el conteo).
 * La cifra de cada sección sale del resumen; las filas, de los días y bloques. Un día o bloque cuyos cargos ya tienen
 * todos su pago en Kepler no es trabajo de nadie y no sale en ninguna lista.
 */

export type SeccionComisiones = 'listos' | 'medias' | 'espera' | 'revisar';

/** Los depósitos que la sucursal aún no captura, juntos por cuenta: el banco no dice de qué sucursal son. */
export interface FilaEspera { cuenta: string; banco: string; depositos: number; cargos: number; total: number; desde: string }

/** Algo que no se escribe y no se adivina, con su porqué. */
export interface FilaRevisar {
  clave: string;
  /** La sucursal sólo se conoce si el depósito ya está en Kepler. */
  sucursal: string | null;
  banco: string;
  cuenta: string | null;
  fecha: string;
  cargos: number;
  total: number;
  motivo: string;
  /** El día, si lo hay, para abrir su detalle. */
  dia: DiaComision | null;
}

export interface VistaComisiones {
  listos: DiaComision[];
  medias: DiaComision[];
  espera: FilaEspera[];
  revisar: FilaRevisar[];
}

const cent = (n: number): number => Math.round(Number(n) * 100);
const sinPago = (cs: readonly CargoComision[]): CargoComision[] => cs.filter((c) => !c.kepler_pago);
/** Igual que la API (`gasto_capturado_sin_pago`): «a medias» es el día con una solicitud o gasto de Finanzas. */
const conGastoDeFinanzas = (d: DiaComision): boolean => d.cargos.some((c) => c.kepler_gasto);
/** Lo más reciente primero: lo que la persona viene a buscar es lo que acaba de llegar. */
const porDiaDesc = (a: DiaComision, b: DiaComision): number =>
  b.dia_venta.localeCompare(a.dia_venta) || a.sucursal.localeCompare(b.sucursal) || a.banco.localeCompare(b.banco);

export function vistaDeComisiones(p: PropuestaComisiones): VistaComisiones {
  const listos = p.dias.filter((d) => d.estado === 'lista').sort(porDiaDesc);
  const medias = p.dias.filter((d) => d.estado === 'parcial' && conGastoDeFinanzas(d) && sinPago(d.cargos).length).sort(porDiaDesc);

  const porCuenta = new Map<string, FilaEspera>();
  for (const b of p.por_revisar.filter((x) => x.espera)) {
    const f = porCuenta.get(b.deposito.cuenta) ?? { cuenta: b.deposito.cuenta, banco: b.deposito.banco, depositos: 0, cargos: 0, total: 0, desde: b.deposito.fecha };
    f.depositos++;
    f.cargos += b.cargos.length;
    f.total = (cent(f.total) + b.cargos.reduce((s, c) => s + cent(c.importe), 0)) / 100;
    if (b.deposito.fecha < f.desde) f.desde = b.deposito.fecha;
    porCuenta.set(b.deposito.cuenta, f);
  }
  const espera = [...porCuenta.values()].sort((a, b) => b.cargos - a.cargos || a.cuenta.localeCompare(b.cuenta));

  const fila = (clave: string, x: { sucursal: string | null; banco: string; cuenta: string | null; fecha: string; motivo: string; dia: DiaComision | null }, cs: readonly CargoComision[]): FilaRevisar =>
    ({ clave, ...x, cargos: cs.length, total: cs.reduce((s, c) => s + cent(c.importe), 0) / 100 });
  const revisar: FilaRevisar[] = [
    // El día con pagos sueltos de Finanzas pero sin su gasto, el que Finanzas tiene con otros importes (candado 3) o
    // el que el armador rechazó. Cuentan sus cargos SIN pago: los pagados ya son de «con su pago en Kepler».
    ...p.dias.filter((d) => (d.estado === 'parcial' && !conGastoDeFinanzas(d) && sinPago(d.cargos).length) || d.estado === 'rechazada')
      .map((d) => fila(`d|${d.sucursal}|${d.dia_venta}|${d.acreedor}`, { sucursal: d.sucursal, banco: d.banco, cuenta: null, fecha: d.dia_venta, motivo: d.motivos.join(' · '), dia: d }, sinPago(d.cargos))),
    // El depósito viejo sin capturar o con un día de venta ilegible; si Finanzas ya pagó todos sus cargos, no es trabajo.
    ...p.por_revisar.filter((b) => !b.espera && sinPago(b.cargos).length)
      .map((b: BloqueComisionPorRevisar) => fila(`b|${b.deposito.id}`, { sucursal: null, banco: b.deposito.banco, cuenta: b.deposito.cuenta, fecha: b.deposito.fecha, motivo: b.motivo, dia: null }, sinPago(b.cargos))),
    ...p.huerfanos.filter((c) => !c.kepler_pago)
      .map((c) => fila(`h|${c.id}`, { sucursal: null, banco: '', cuenta: c.cuenta, fecha: c.fecha, motivo: 'cargo de tarjeta sin el depósito de su terminal antes en la descarga', dia: null }, [c])),
  ].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.total - a.total);

  return { listos, medias, espera, revisar };
}

/** La franja de cifras: las secciones que NO están listas, cada una se abre (`drill`) en su lista. */
export function cifrasDeComisiones(p: PropuestaComisiones): MetricStripItem[] {
  const r = p.resumen;
  return [
    { label: 'Finanzas los dejó a medias', value: r.gasto_capturado_sin_pago, format: 'number', sub: 'gasto capturado, faltan pagos', drill: 'medias', drillLabel: 'Ver los días que Finanzas dejó a medias' },
    { label: 'Esperando a la sucursal', value: r.esperando_sucursal, format: 'number', sub: 'sin su depósito en Kepler', drill: 'espera', drillLabel: 'Ver lo que espera a la sucursal' },
    { label: 'Por revisar', value: r.por_revisar, format: 'number', tone: r.por_revisar ? 'warn' : 'default', sub: 'con su motivo', drill: 'revisar', drillLabel: 'Ver lo que hay que revisar' },
    { label: 'Con su pago en Kepler', value: r.ya_en_kepler, format: 'number', tone: 'muted', sub: 'cargos completos' },
  ];
}

/** Los renglones de la póliza del gasto como los verá la persona: cuenta, cargo o abono, importe. */
export function polizaDelGasto(d: DiaComision): { cuenta: string; lado: 'Cargo' | 'Abono'; importe: number }[] {
  return (d.plan?.gasto.poliza.renglones ?? []).map((r) => ({ cuenta: r.c3, lado: r.c4 === 'C' ? 'Cargo' : 'Abono', importe: Number(r.c5) }));
}
