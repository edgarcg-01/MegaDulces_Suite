/**
 * `[CC.21]` **¿La ficha que subió el cliente ENTRÓ al banco?** — se deriva al leer, no se guarda.
 *
 * La ficha sólo prueba que alguien dice que depositó; el abono en el estado de cuenta prueba que el dinero llegó; y el
 * cobro de Kepler que la conciliación bancaria (CB) ya ligó a ese abono dice a QUÉ CLIENTE se aplicó. Las tres juntas
 * contestan lo que Cobranza tiene que decidir sin abrir el banco:
 *
 *   ficha (monto y fecha leídos de la foto) → abono del banco (±$1, del día anterior a 3 días después, en la cuenta
 *   destino si la foto la trae) → cobro de Kepler que CB ya le ligó → ¿es del MISMO cliente?
 *
 * Medido en prod el 2026-11-17, usando los 923 cobros de depósito/transferencia de octubre como si fueran fichas:
 *  · el monto solo da un abono único en 738; de ésos, CB dice que es OTRO cobro en 59 (8 %), y el placebo (monto
 *    ×1.0037) encuentra un abono «único» en 63 de 923 (7 %). ⇒ **el monto solo no valida**: hace falta el cliente.
 *  · el estado de cuenta se SUBE A MANO (`sync_source = 'upload'`), cada 1 a 5 días; un abono tarda 3 días en llegar
 *    a la Suite (p90 8). ⇒ «no está en el banco» sólo se puede afirmar si el estado de cuenta ya está cargado hasta
 *    después del depósito; si no, se dice hasta qué día está cargado (ADR-056: lo no medido se declara).
 */

/** Tolerancia de monto contra el abono (redondeo), en pesos. Igual que `BANK_TOL` del cruce de oficina. */
export const BANCO_TOL = 1;
/** El abono puede fecharse el día anterior (fecha valor) … */
export const BANCO_DIAS_ANTES = 1;
/** … o hasta 3 días después (un depósito del sábado se abona el lunes). */
export const BANCO_DIAS_DESPUES = 3;
/** Una cuenta «recibe depósitos» si tuvo abonos en al menos estos días distintos de los últimos 60. */
export const DIAS_CUENTA_VIVA = 10;

/** Un cobro de Kepler que CB ya ligó al abono. */
export interface CobroLigado {
  sucursal: string; folio: string; tipo: string; cliente_code: string | null; cliente_nombre: string | null;
}
export interface AbonoCandidato {
  id: string; fecha: string; monto: number; banco: string; cuenta: string;
  cobros: CobroLigado[] | null; declarado: string | null;
}
/** Lo que sale de la consulta, por ficha. */
export interface FilaFichaEnBanco {
  id: string; cliente_code: string | null; cuenta_id: string | null; cargado_hasta: string | null;
  abonos: AbonoCandidato[];
}

export type EstadoBanco =
  | 'aplicado'          // un abono, y CB ya lo ligó a un cobro de ESTE cliente: sólo falta ligar la ficha
  | 'sin_aplicar'       // un abono, sin cobro en Kepler: el dinero llegó y nadie lo ha aplicado
  | 'de_otro_cliente'   // un abono, pero CB lo ligó al cobro de OTRO cliente
  | 'varios'            // más de un abono posible: lo decide una persona
  | 'no_aparece'        // el estado de cuenta ya cubre la fecha y no hay abono
  | 'banco_sin_cargar'  // el estado de cuenta todavía no llega a esa fecha: NO MEDIDO
  | 'sin_dato';         // la ficha no trae monto o fecha

export interface FichaEnBanco {
  estado: EstadoBanco;
  /** Hasta qué día está cargado el estado de cuenta que se miró (de la cuenta destino, o el más atrasado). */
  cargado_hasta: string | null;
  abonos: AbonoCandidato[];
  /** El cobro de Kepler al que se puede ligar la ficha (sólo en `aplicado`). */
  cobro: CobroLigado | null;
  /** Otra ficha de cliente que apunta al MISMO abono único (dos fichas, un depósito). */
  disputado_con: string | null;
}

const mismo = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim() === b.trim();

/** Clasifica UNA ficha a partir de su fila. Pura: la prueba no necesita base. */
export function clasificarFichaEnBanco(f: FilaFichaEnBanco, diaDeposito: string | null, monto: number | null): FichaEnBanco {
  const base = { cargado_hasta: f.cargado_hasta, abonos: f.abonos || [], cobro: null, disputado_con: null };
  if (!diaDeposito || monto == null || !(monto > 0)) return { ...base, estado: 'sin_dato' };
  const abonos = f.abonos || [];
  if (abonos.length > 1) return { ...base, estado: 'varios' };
  if (abonos.length === 1) {
    const cobros = abonos[0].cobros || [];
    if (!cobros.length) return { ...base, estado: 'sin_aplicar' };
    const suyo = cobros.find((c) => mismo(c.cliente_code, f.cliente_code));
    return suyo ? { ...base, estado: 'aplicado', cobro: suyo } : { ...base, estado: 'de_otro_cliente' };
  }
  // Sin abono: sólo se afirma si el estado de cuenta ya cubre la ventana completa.
  const limite = sumarDias(diaDeposito, BANCO_DIAS_DESPUES);
  const cubre = !!f.cargado_hasta && f.cargado_hasta >= limite;
  return { ...base, estado: cubre ? 'no_aparece' : 'banco_sin_cargar' };
}

/** Marca las fichas que apuntan al mismo abono único: un depósito no paga dos fichas. */
export function marcarDisputas(porFicha: Map<string, FichaEnBanco>): void {
  const dueno = new Map<string, string>();
  for (const [id, b] of porFicha) {
    if (b.abonos.length !== 1) continue;
    const mov = b.abonos[0].id;
    const otro = dueno.get(mov);
    if (otro) { b.disputado_con = otro; const o = porFicha.get(otro); if (o && !o.disputado_con) o.disputado_con = id; }
    else dueno.set(mov, id);
  }
}

export function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * La consulta. `fuente` es el cuerpo de un CTE que entrega `(id, cliente_code, monto, monto_alt, fecha, cuenta_dest)`;
 * en la Suite son las fichas de `finance.collection_deposits` (`monto` = lo que declaró el cliente, `monto_alt` = lo que
 * leyó la foto: si difieren, el banco desempata), y en la medición, cobros de Kepler tomados como fichas.
 *
 * ⚠️ «Cargado hasta» de una ficha SIN cuenta destino reconocida es el estado de cuenta MÁS ATRASADO de las cuentas que
 * reciben depósitos (abonos en `DIAS_CUENTA_VIVA` = 10 días distintos de los últimos 60): si se tomara el más nuevo, una
 * cuenta sin subir haría decir «no aparece» a un depósito que sí entró. Las cuentas casi sin abonos no cuentan para esto
 * (medido el 2026-11-17: SANTANDER 1621, con 1 abono en 30 días, cargada al 3-nov, habría detenido todos los veredictos);
 * un depósito en una de ellas puede salir «no aparece» antes de tiempo, y la pantalla dice hasta cuándo está cargado.
 */
export function sqlFichaEnBanco(fuente: string): string {
  return `
    WITH f AS (${fuente}),
    acc AS (
      SELECT a.id, a.bank, a.account_label, max(m.movement_date) AS hasta,
             count(DISTINCT m.movement_date) FILTER (WHERE m.amount_in > 0 AND m.movement_date >= current_date - 60) AS dias_con_abono
        FROM finance.bank_accounts a
        JOIN finance.bank_movements m ON m.bank_account_id = a.id AND m.deleted_at IS NULL
       WHERE a.kind = 'bank' AND a.active
       GROUP BY a.id, a.bank, a.account_label
      HAVING max(m.movement_date) >= current_date - 60
    ),
    fa AS (
      SELECT f.*, (
        SELECT a.id FROM acc a
         WHERE a.account_label ~ '^[0-9]{3,}$'
           AND regexp_replace(COALESCE(f.cuenta_dest, ''), '\\D', '', 'g') <> ''
           AND regexp_replace(COALESCE(f.cuenta_dest, ''), '\\D', '', 'g') LIKE '%' || a.account_label
         ORDER BY length(a.account_label) DESC LIMIT 1) AS cuenta_id
        FROM f
    )
    SELECT fa.id, fa.cliente_code, fa.cuenta_id,
      (CASE WHEN fa.cuenta_id IS NOT NULL THEN (SELECT hasta FROM acc WHERE acc.id = fa.cuenta_id)
            ELSE COALESCE((SELECT min(hasta) FROM acc WHERE dias_con_abono >= ${DIAS_CUENTA_VIVA}), (SELECT min(hasta) FROM acc))
       END)::text AS cargado_hasta,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', m.id, 'fecha', m.movement_date::text, 'monto', m.amount_in, 'banco', a.bank,
                 'cuenta', a.account_label, 'declarado', m.customer_code,
                 'cobros', (SELECT jsonb_agg(jsonb_build_object(
                                'sucursal', r.kepler_sucursal, 'folio', r.kepler_doc_folio, 'tipo', r.kepler_doc_tipo,
                                'cliente_code', ec.cliente_code, 'cliente_nombre', ec.cliente_nombre))
                              FROM finance.bank_recon_matches r
                              -- El cliente del cobro, directo del documento de Kepler (kdm1, por su índice de abonos).
                              -- Por la vista de cobros (erp_collections) costaba 60 ms POR abono (medido: 20 fichas, 3.3 s).
                              LEFT JOIN LATERAL (
                                SELECT NULLIF(btrim(k.c10), '') AS cliente_code, NULLIF(btrim(k.c32), '') AS cliente_nombre
                                  FROM kepler_ods.kdm1 k
                                 WHERE k.c2 = 'U' AND k.c3 = 'A'
                                   AND btrim(k.sucursal) = r.kepler_sucursal AND btrim(k.c1) = r.kepler_sucursal
                                   AND k.c4::integer = CASE r.kepler_doc_tipo WHEN 'U-A-5' THEN 5 WHEN 'U-A-7' THEN 7 END
                                   AND btrim(k.c6) = r.kepler_doc_folio
                                   AND btrim(COALESCE(k.c43, '')) <> 'C'
                                 LIMIT 1) ec ON true
                             WHERE r.bank_movement_id = m.id))
               ORDER BY m.movement_date)
          FROM finance.bank_movements m
          JOIN acc a ON a.id = m.bank_account_id
         WHERE m.deleted_at IS NULL
           AND (m.amount_in BETWEEN fa.monto - ${BANCO_TOL} AND fa.monto + ${BANCO_TOL}
                OR m.amount_in BETWEEN fa.monto_alt - ${BANCO_TOL} AND fa.monto_alt + ${BANCO_TOL})
           AND m.movement_date BETWEEN fa.fecha - ${BANCO_DIAS_ANTES} AND fa.fecha + ${BANCO_DIAS_DESPUES}
           AND (fa.cuenta_id IS NULL OR m.bank_account_id = fa.cuenta_id)
      ), '[]'::jsonb) AS abonos
      FROM fa`;
}
