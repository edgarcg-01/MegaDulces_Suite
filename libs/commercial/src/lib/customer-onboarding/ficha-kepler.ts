import {
  CASILLAS_KEPLER,
  type ArmadoDeFicha,
  type CasillaKepler,
  type CasillaRecortada,
  type ConstanciaSituacionFiscal,
  type FichaKeplerCliente,
} from '@megadulces/contracts';

/**
 * `[ALC.1.3]` La constancia → la forma «Datos del cliente» de Kepler (`md_cat_cli_sc.kpl`, `kdud`).
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md) §1.1.
 *
 * La convención sale del maestro de Kepler, medida el 2026-11-04 (sucursal 00, sólo lectura):
 * - **Nombre** (`c3`): la razón social **sin** régimen de capital — 2 de 203 personas morales lo
 *   llevan. Es también lo que pide el CFDI 4.0.
 * - **Estado** (`c6`): `MICHOACAN` (1,582 fichas) y no `MICHOACAN DE OCAMPO` como lo escribe el SAT.
 * - **Dirección 1** (`c4`): la abreviatura de vialidad del SAT (`AV.` es la más usada: 45 contra 9
 *   `AV`) + calle + número; `CALLE` no se escribe (la mayoría empieza directo con el nombre).
 *   Número interior: `INT 6`.
 * - **Dirección 2** (`c5`): colonia + localidad (o municipio si no hay localidad), como la ficha de
 *   la captura de pantalla que dio Francisco.
 * La calle no va en el CFDI 4.0 (del domicilio sólo pide el CP): la convención es cosmética y la
 * persona la corrige en pantalla antes de guardar.
 */

/** Entidades que el SAT escribe largo y Kepler corto. Sólo Michoacán está medido; las otras dos siguen la misma regla. */
const ESTADO_CORTO: Record<string, string> = {
  'MICHOACAN DE OCAMPO': 'MICHOACAN',
  'VERACRUZ DE IGNACIO DE LA LLAVE': 'VERACRUZ',
  'COAHUILA DE ZARAGOZA': 'COAHUILA',
};

const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
const junta = (...partes: Array<string | null | undefined>): string =>
  partes.map((p) => String(p ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');

export function estadoCorto(entidad: string | null | undefined): string {
  const e = sinAcentos(String(entidad ?? '').toUpperCase()).replace(/\s+/g, ' ').trim();
  return ESTADO_CORTO[e] ?? e;
}

/** «AVENIDA (AV.)» → `AV.` · «CALLE» → `` · «PRIVADA» → `PRIVADA`. */
export function prefijoVialidad(tipo: string | null | undefined): string {
  const t = String(tipo ?? '').toUpperCase().trim();
  if (!t || t === 'CALLE') return '';
  const abreviatura = /\(([^)]+)\)/.exec(t)?.[1]?.trim();
  return abreviatura || t;
}

/** Ficha vacía: todas las casillas en `''`. */
export function fichaVacia(): FichaKeplerCliente {
  return Object.fromEntries(Object.keys(CASILLAS_KEPLER).map((k) => [k, ''])) as FichaKeplerCliente;
}

/** Lo que no cabe en su casilla se reporta (el valor completo y lo que entra). No recorta la ficha. */
export function recortesDe(ficha: FichaKeplerCliente): CasillaRecortada[] {
  const out: CasillaRecortada[] = [];
  for (const casilla of Object.keys(CASILLAS_KEPLER) as CasillaKepler[]) {
    const { largo } = CASILLAS_KEPLER[casilla];
    const completo = String(ficha[casilla] ?? '');
    if (completo.length > largo) out.push({ casilla, completo, cabe: completo.slice(0, largo), largo });
  }
  return out;
}

export function fichaDesdeConstancia(c: ConstanciaSituacionFiscal): ArmadoDeFicha {
  const d = c.domicilio;
  const interior = d.numero_interior ? `INT ${d.numero_interior}` : '';
  const ficha: FichaKeplerCliente = {
    ...fichaVacia(),
    nombre: c.nombre_fiscal.toUpperCase(),
    direccion_1: junta(prefijoVialidad(d.tipo_vialidad), d.vialidad, d.numero_exterior, interior).toUpperCase(),
    direccion_2: junta(d.colonia, d.localidad || d.municipio).toUpperCase(),
    estado: estadoCorto(d.entidad),
    codigo_postal: String(d.codigo_postal ?? ''),
    rfc: c.rfc,
    curp: c.tipo === 'fisica' ? String(c.curp ?? '') : '',
  };
  return { ficha, recortes: recortesDe(ficha) };
}
