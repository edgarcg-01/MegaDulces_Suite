/**
 * `[ZN.6]` — **Qué zonas se pueden ofrecer, sin borrar de la vista la que ya está guardada.**
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────────────────────
 * `trade.zones` tiene 11 filas vivas y **sólo 3 son zonas** (las mismas tres que declara el ERP
 * en `kepler_ods.kduk`). Las otras 8 son 4 sucursales, 2 canales, `OFICINAS` —que es una
 * actividad, no un lugar— y una fila que nació después de que `[ZN.0]` clasificara el resto.
 * El selector las ofrecía todas por igual, y por eso hay **34 personas en prod cuyo filtro de
 * zona no filtra por ninguna zona**: la más común es tener como «zona» su propia sucursal.
 *
 * ── Por qué no alcanza con filtrar ───────────────────────────────────────────────────────────
 * Recortar a `kind === 'zona'` y ya, deja el selector **en blanco** para las 54 personas que hoy
 * tienen guardada una de las otras 8. Y un selector en blanco no dice «esto está mal»: dice
 * **«no tiene zona»**, que es una afirmación distinta y falsa — y además esconde exactamente lo
 * que hay que arreglar. Así que lo guardado se conserva en la lista, **marcado**, hasta que
 * alguien lo cambie a propósito.
 *
 * Es la misma regla de ADR-056 aplicada a un `<select>`: lo que no se puede sostener se DECLARA,
 * no se dibuja como vacío.
 */

/** Una fila de `trade.zones` tal como la devuelve `GET /users/zones`. */
export interface FilaDeZona {
  id: string;
  value: string;
  kind?: string | null;
  kind_motivo?: string | null;
}

export interface OpcionDeZona {
  label: string;
  value: string | null;
  /** `true` = está en la lista sólo porque es lo que la persona tiene guardado hoy. */
  fueraDelCatalogo?: boolean;
}

/** Lo único que cuenta como zona. El resto vive en la misma tabla sin serlo. */
export const ES_ZONA = (z: FilaDeZona): boolean => z.kind === 'zona';

/**
 * ⚠️ `kind` ausente o `null` **no** cuenta como zona: una fila sin clasificar no es una zona
 * *todavía*, y para un eje de alcance la postura correcta es fail-closed. Si el servidor viejo
 * no mandara `kind`, esto ofrecería sólo «Ninguna» — visible al instante — en vez de volver a
 * ofrecer las 11 en silencio, que es el defecto que estamos cerrando.
 */
export function opcionesDeZona(
  zonas: readonly FilaDeZona[],
  guardada: string | null,
): OpcionDeZona[] {
  const opts: OpcionDeZona[] = [{ label: 'Ninguna', value: null }];
  for (const z of zonas) {
    if (ES_ZONA(z)) {
      opts.push({ label: z.value, value: z.id });
    } else if (guardada && z.id === guardada) {
      opts.push({ label: `${z.value} — no es una zona`, value: z.id, fueraDelCatalogo: true });
    }
  }
  return opts;
}

/**
 * La fila guardada, cuando NO es una zona, con el motivo que la propia fila trae escrito
 * (`trade.zones.kind_motivo`) — para poder decir *por qué* está mal y no sólo *que* está mal.
 *
 * `null` = no hay nada que declarar (o no tiene zona, o la que tiene es legítima).
 */
export function zonaGuardadaQueNoEsZona(
  zonas: readonly FilaDeZona[],
  guardada: string | null,
): { nombre: string; motivo: string | null } | null {
  if (!guardada) return null;
  const z = zonas.find((x) => x.id === guardada);
  if (!z || ES_ZONA(z)) return null;
  return { nombre: z.value, motivo: z.kind_motivo ?? null };
}
