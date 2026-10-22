import type { PosicionCajaDto, PosicionRubro, RubroCaja } from '@megadulces/contracts';

/**
 * ⭐ `[CGS.35]` **Lo que hay en caja, rubro por rubro.** Puro: recibe los hechos ya leídos.
 *
 * Edgar, 2026-10-21, sobre la sección «¿Cuánto hay ahora?» de Arqueos: *«aquí debería ver lo que
 * tengo en caja general, CAOS o caja fuerte, en dólares, y todo lo que debo tener en caja»*. La
 * pantalla mostraba un cajón de **−$221,512.14** pintado como cifra y la caja fuerte «sin medir».
 *
 * ── De dónde sale cada rubro (medido en prod el 2026-10-21) ─────────────────────────────────
 *  · **Efectivo del cajón**: el último corte de la Suite + lo que el libro registró después + las
 *    dos piernas de CAOS. Es la misma fórmula que el esperado del corte. Si da negativo se declara
 *    `imposible` (un cajón no debe dinero): hoy pasa porque hay pagos a proveedor que no salieron
 *    del cajón y se restan como si sí.
 *  · **Caja fuerte (CAOS)**: el último arqueo de Control, en el rubro que Control llama «tarjeta».
 *    ⭐ Verificado: de un cierre al siguiente, ese rubro cambia EXACTAMENTE lo depositado menos lo
 *    dispensado en la máquina, al peso, en 18 de 21 días (19-sep → 20-oct); las 3 excepciones son
 *    días con vaciado/dotación (tipos que todavía no se clasifican, `[CGA-A.33]`) y un depósito de
 *    $5,000 que cayó a un lado y otro del corte. Después se suman los depósitos y se restan las
 *    dispensaciones; si hubo vaciado o dotación, queda `parcial`.
 *  · **Dólares, cheques y papeles**: el último arqueo de Control. La Suite no registra movimientos
 *    de esos rubros: vale lo contado, con su fecha (`medido`), y se dice que no se lleva registro.
 */
export interface HechosPosicion {
  ahora: string;
  corte: { folio: string; fecha: string; contado: number; cerrado_at: string | null } | null;
  /** Lo que el libro registró después de la jornada del último corte. */
  libro: { ingresos: number; gastos: number; depositos: number; movimientos: number } | null;
  /** Las piernas de CAOS posteriores a la jornada del último corte (para el cajón). */
  caosCajon: { depositado: number; dispensado: number } | null;
  control: {
    folio: string; at: string; caja_fuerte: number | null; efectivo: number | null;
    usd: number | null; tipo_cambio: number | null; cheques: number | null; papeles: number | null;
  } | null;
  /** Movimientos de CAOS posteriores al arqueo de Control (para la caja fuerte). */
  caosDesdeControl: { depositado: number; dispensado: number; otros: string[] } | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const mx = (n: number): string => `$${Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function posicionDeCaja(h: HechosPosicion): PosicionCajaDto {
  const rubros: PosicionRubro[] = [];

  // ── Efectivo del cajón ────────────────────────────────────────────────────────────────
  if (!h.corte) {
    rubros.push({
      rubro: 'efectivo', etiqueta: 'Efectivo del cajón', ultimo: null, desde: null,
      ahora: { monto: null, estado: 'no_medido', nota: 'No hay ningún corte cerrado del que partir.' },
    });
  } else {
    const l = h.libro ?? { ingresos: 0, gastos: 0, depositos: 0, movimientos: 0 };
    const c = h.caosCajon ?? { depositado: 0, dispensado: 0 };
    const entra = r2(l.ingresos + c.dispensado);
    const sale = r2(l.gastos + l.depositos + c.depositado);
    const esperado = r2(h.corte.contado + entra - sale);
    const detalle = `${l.movimientos} movimiento(s) del libro · la caja fuerte dio ${mx(c.dispensado)} al cajón y recibió ${mx(c.depositado)}`;
    rubros.push({
      rubro: 'efectivo', etiqueta: 'Efectivo del cajón',
      ultimo: { monto: h.corte.contado, fuente: `corte ${h.corte.folio} (jornada del ${h.corte.fecha})`, at: h.corte.cerrado_at },
      desde: { entra, sale, detalle },
      ahora: esperado < 0
        ? {
          monto: null, estado: 'imposible',
          nota: `La cuenta da ${mx(esperado)} negativo, y un cajón no debe dinero: se restan pagos que no salieron `
            + 'del cajón (transferencias o dinero de la caja fuerte) o falta registrar una entrada. Hay que arreglar la cuenta, no buscar efectivo.',
        }
        : { monto: esperado, estado: 'derivado', nota: 'Lo contado en el último corte más lo registrado desde entonces. No es un conteo.' },
    });
  }

  // ── Los rubros del arqueo de Control ─────────────────────────────────────────────────
  const ctl = h.control;
  const fuenteCtl = ctl ? `arqueo ${ctl.folio} de Control` : '';
  if (!ctl) {
    for (const [rubro, etiqueta] of [['caja_fuerte', 'Caja fuerte (CAOS)'], ['dolares', 'Dólares'], ['cheques', 'Cheques'], ['papeles', 'Papeles']] as const) {
      rubros.push({ rubro, etiqueta, ultimo: null, desde: null,
        ahora: { monto: null, estado: 'no_medido', nota: 'No hay un arqueo de Control con este rubro.' } });
    }
  } else {
    // Caja fuerte
    if (ctl.caja_fuerte == null) {
      rubros.push({ rubro: 'caja_fuerte', etiqueta: 'Caja fuerte (CAOS)', ultimo: null, desde: null,
        ahora: { monto: null, estado: 'no_medido', nota: 'El último arqueo de Control no trae la caja fuerte.' } });
    } else {
      const d = h.caosDesdeControl ?? { depositado: 0, dispensado: 0, otros: [] };
      const monto = r2(ctl.caja_fuerte + d.depositado - d.dispensado);
      const parcial = d.otros.length > 0;
      rubros.push({
        rubro: 'caja_fuerte', etiqueta: 'Caja fuerte (CAOS)',
        ultimo: { monto: ctl.caja_fuerte, fuente: `${fuenteCtl} (Control lo anota como «tarjeta»)`, at: ctl.at },
        desde: { entra: d.depositado, sale: d.dispensado, detalle: 'depositado en la máquina − lo que dispensó' },
        ahora: {
          monto, estado: parcial ? 'parcial' : 'derivado',
          nota: parcial
            ? `Además hubo ${d.otros.join(', ')} en la máquina, que no se suman: la cifra puede estar corrida.`
            : 'Lo último arqueado más lo depositado menos lo dispensado. No es un conteo de la máquina.',
        },
      });
    }
    // Dólares
    if (ctl.usd == null) {
      rubros.push({ rubro: 'dolares', etiqueta: 'Dólares', ultimo: null, desde: null,
        ahora: { monto: null, estado: 'no_medido', nota: 'El último arqueo de Control no trae dólares.' } });
    } else {
      const mxn = ctl.tipo_cambio != null ? r2(ctl.usd * ctl.tipo_cambio) : null;
      rubros.push({
        rubro: 'dolares', etiqueta: 'Dólares',
        ultimo: { monto: mxn, usd: ctl.usd, tipo_cambio: ctl.tipo_cambio, fuente: fuenteCtl, at: ctl.at },
        desde: null,
        ahora: {
          monto: mxn, usd: ctl.usd, estado: mxn == null ? 'no_medido' : 'medido',
          nota: mxn == null
            ? 'Se contaron los dólares pero no el tipo de cambio: no se convierten a pesos.'
            : `Lo contado, al tipo de cambio de ese arqueo (${ctl.tipo_cambio}). La Suite no registra movimientos en dólares.`,
        },
      });
    }
    for (const [rubro, etiqueta, v] of [['cheques', 'Cheques', ctl.cheques], ['papeles', 'Papeles', ctl.papeles]] as const) {
      rubros.push(v == null
        ? { rubro, etiqueta, ultimo: null, desde: null, ahora: { monto: null, estado: 'no_medido', nota: 'El último arqueo de Control no lo trae.' } }
        : { rubro, etiqueta, ultimo: { monto: v, fuente: fuenteCtl, at: ctl.at }, desde: null,
          ahora: { monto: v, estado: 'medido', nota: 'Lo contado en ese arqueo. La Suite no registra sus movimientos.' } });
    }
  }

  const fuera: RubroCaja[] = rubros.filter((r) => r.ahora.monto == null).map((r) => r.rubro);
  const monto = r2(rubros.reduce((a, r) => a + (r.ahora.monto ?? 0), 0));
  return { calculado_at: h.ahora, rubros, total: { monto, completo: fuera.length === 0, fuera } };
}
