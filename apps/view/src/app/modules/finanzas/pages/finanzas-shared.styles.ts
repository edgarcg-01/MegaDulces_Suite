/**
 * Vocabulario visual compartido de Finanzas — fuente única para `/finanzas/bancos` y
 * `/finanzas/caja`: el chrome de la página (segmentado de vistas, skeleton) y los organismos
 * del cuadre (veredicto, control-total, tags, drill).
 *
 * Las dos pantallas responden la misma pregunta con la misma forma: enfrentar N fuentes que
 * deberían decir lo mismo, declarar si cuadran, y dejar abrir el renglón que no cuadra. El
 * diseño de referencia es el de **Bancos** (veredicto arriba, cards `card-premium card-flat`,
 * control-total en `table.tw-tbl`, tags, drill); Caja lo adopta.
 *
 * Uso:  styles: [FINANZAS_SHARED_STYLES, `…lo propio de esta vista…`]
 *
 * Solo lleva selectores con prefijo (`tw-`, `fb-`, `*-tag`). NADA de clases genéricas
 * (`.muted`, `.num`, `.strong`, `.ta-r`): cada pantalla ya define las suyas y redefinirlas
 * acá las pisaría en silencio — en Caja `.muted` es `--text-faint` y en Bancos `--text-muted`.
 *
 * Regla: una clase que necesiten las dos vistas va acá — no se copia.
 * Tokens en libs/design-tokens/tokens.css. Cero hex crudo.
 */
export const FINANZAS_SHARED_STYLES = `

  /* ── Chrome de la página: segmentado de vistas + skeleton ─────────────────
     Las dos pantallas de Finanzas navegan entre vistas con el MISMO control. Caja lo hacía
     con pestañas subrayadas y Bancos con un segmentado en píldora: la misma app se leía como
     dos productos. Manda el de Bancos. */
  /* Quiet-luxury (Linear/Stripe): hairline, cero gloss, cero sombra difusa. La regla de
     elevación in-page es borde 1px O sombra, nunca ambas — antes llevaba borde + doble
     sombra + gloss iOS, que encima necesitaba un override de dark aparte porque el brillo
     blanco no sobrevive el tema. El desborde se ANUNCIA con fade en los bordes: 9 destinos
     con scrollbar oculto dejaban vistas invisibles en pantalla mediana. */
  .fb-viewseg {
    display: flex; align-items: stretch; gap: 2px; margin: var(--sp-3) 0; padding: 3px;
    background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill);
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -ms-overflow-style: none;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-4)), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 var(--sp-4), #000 calc(100% - var(--sp-4)), transparent 100%);
  }
  .fb-viewseg::-webkit-scrollbar { display: none; }
  .fb-viewseg button {
    display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; border-radius: var(--r-pill);
    color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500;
    padding: var(--sp-1) var(--sp-3); cursor: pointer; white-space: nowrap;
    transition: background-color var(--dur-short) var(--ease-standard), color var(--dur-short) var(--ease-standard);
  }
  .fb-viewseg button:not(.active):hover { color: var(--text-main); }
  /* Activo = superficie + ring 1px tokenizado (no sombra): se lee igual en light y dark. */
  .fb-viewseg button.active {
    color: var(--action); background: var(--card-bg);
    box-shadow: 0 0 0 1px var(--border-color);
  }
  .fb-viewseg button:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
  .fb-seg-config { margin-left: auto; }
  .fb-skeleton { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
  .fb-skel-row { height: var(--row-h-md); border-radius: var(--r-sm); background: var(--hover-bg); animation: fb-pulse 1.4s ease-in-out infinite; }
  @keyframes fb-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
  @media (prefers-reduced-motion: reduce) { .fb-skel-row { animation: none; } }
  .fb-seg-count { display: inline-flex; align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; padding: 0 4px; margin-left: 4px; font-size: var(--fs-micro); font-weight: 700; border-radius: var(--r-pill); background: var(--warn-fg); color: var(--stone-950); }

  /* ── Veredicto: la conclusión, arriba de todo ──────────────────────────────
     Borde izquierdo de 3px como portador de estado además del icono. Elevación =
     borde, nunca sombra (regla del design system para superficies in-page). */
  .tw-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4);
    border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; margin-bottom: var(--sp-3); }
  .tw-verdict.ok { border-left-color: var(--ok-fg); }
  /* Un "no cuadra" es atención, no error: warn y no bad. */
  .tw-verdict.bad { border-left-color: var(--warn-fg); }
  .tw-verdict > i { font-size: 1.5rem; }
  .tw-verdict.ok > i { color: var(--ok-fg); }
  .tw-verdict.bad > i { color: var(--warn-fg); }
  .tw-verdict h3 { font-size: var(--fs-h3); font-weight: 700; margin: 0; color: var(--text-main); }
  .tw-verdict p { font-size: var(--fs-xs); margin: 2px 0 0; line-height: 1.4; }

  /* ── Cabeceras y notas de las cards ─────────────────────────────────────
     Mismas reglas que los .fb-* de BANCOS_STYLES, con prefijo propio: ahí las usan los otros
     10 componentes del tablero de bancos, y copiarlas para Caja abriría drift. Acá viven una
     sola vez y las consumen las dos vistas de cuadre. */
  .tw-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
  /* Título de una card cuya tabla va pegada al borde: el padding lo pone el título. */
  .tw-pnl-title { padding: var(--sp-3) var(--sp-3) 0; }
  .tw-tablewrap { padding: 0; overflow: hidden; }
  /* Lectura en llano al pie de un bloque (DESIGN §Q.2). */
  .tw-note { font-size: var(--fs-xs); margin: var(--sp-3) 0 0; }
  .tw-strong { font-weight: 600; color: var(--text-main); }
  /* Dirección del dinero: entra / sale. */
  .tw-in-ico { color: var(--ok-fg); font-size: var(--fs-xs); margin-right: 4px; }
  .tw-out-ico { color: var(--text-faint); font-size: var(--fs-xs); margin-right: 4px; }

  /* ── Control-total: las N fuentes enfrentadas, 2 renglones (entra / sale) ──
     Tabla cruda y no p-table a propósito: lleva encabezados agrupados con colspan/rowspan
     que p-table no arma, y son dos filas. */
  .tw-card { margin-bottom: var(--sp-3); }
  .tw-wrap { overflow-x: auto; }
  table.tw-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  table.tw-tbl th, table.tw-tbl td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
  table.tw-tbl thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
  table.tw-tbl thead th i { margin-right: 4px; }
  table.tw-tbl tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); }
  table.tw-tbl tbody tr:last-child td, table.tw-tbl tbody tr:last-child th { border-bottom: none; }

  /* Cabecera agrupada (Depósitos/Retiros, Ingreso/Gasto) + resalte de la columna del ERP. */
  .tw-grp { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; border-bottom: 1px solid var(--border-color); }
  .tw-grp i { margin-right: 4px; }
  :host ::ng-deep th.tw-kep, .tw-kep { background: color-mix(in srgb, var(--chart-2) 6%, transparent); }

  /* ── Tags de estado ─────────────────────────────────────────────────────── */
  .tw-tag { display: inline-block; font-size: var(--fs-micro); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
  .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
  .warn-tag { background: color-mix(in srgb, var(--warn-fg) 16%, transparent); color: var(--warn-fg); }
  .ok-tag { background: color-mix(in srgb, var(--ok-fg) 16%, transparent); color: var(--ok-fg); }

  /* ── Fila que abre detalle: el icono de lupa aparece al pasar el mouse ──── */
  .tw-clickable { cursor: pointer; }
  .tw-clickable:hover { background: var(--hover-bg); }
  .tw-drill-ico { font-size: .7rem; color: var(--text-faint); margin-left: 4px; opacity: 0; transition: opacity 120ms ease; }
  .tw-clickable:hover .tw-drill-ico { opacity: 1; }
  .tw-faint { color: var(--text-faint); font-size: .7rem; }
  .nowrap { white-space: nowrap; }
  /* Concepto largo: se trunca con title, nunca rompe la densidad de la fila. */
  .tw-concept { color: var(--text-muted); max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Detalle (diálogo o fila expandida) ─────────────────────────────────── */
  .dlg-lead { font-size: var(--fs-sm); color: var(--text-main); line-height: 1.5; margin: 0 0 var(--sp-3); }
  .tw-drill-kpis { display: flex; gap: var(--sp-3); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-3); }
  .tw-drill-kpis b { color: var(--text-main); }
  .tw-drill-tbl th, .tw-drill-tbl td { padding: var(--sp-1) var(--sp-3); }
  .tw-empty { padding: var(--sp-4); }

  /* Huérfanos: lo que una fuente registra y la otra no movió, enfrentados. */
  .tw-orphans { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-top: var(--sp-3); }
  @media (max-width: 720px) { .tw-orphans { grid-template-columns: 1fr; } }
  .tw-orphan { border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
  .tw-orphan h4 { font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); margin: 0; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); background: var(--surface-ground); }
  .tw-orphan table td { padding: 3px var(--sp-3); border-bottom: 1px solid var(--border-color); font-size: var(--fs-xs); }

  /* ── Filtros y orden del detalle ──────────────────────────────────────────
     El drill de las dos pantallas filtra y ordena igual: segmentos chicos, buscador y
     contador "X de Y" que deja escrito cuánto se está ocultando. */
  /* Encabezado ordenable: el th completo es el objetivo de clic. */
  .tw-sort { display: inline-flex; align-items: center; gap: 4px; width: 100%; background: none; border: none;
    font: inherit; color: inherit; cursor: pointer; padding: 0; text-align: inherit; justify-content: inherit; }
  .ta-r .tw-sort { justify-content: flex-end; }
  .ta-c .tw-sort { justify-content: center; }
  .tw-sort i { font-size: .65rem; opacity: .45; }
  .tw-sort:hover i { opacity: .9; }
  .tw-sort:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
  th[aria-sort]:not([aria-sort='none']) .tw-sort { color: var(--action); }
  th[aria-sort]:not([aria-sort='none']) .tw-sort i { opacity: 1; }
  .tw-drill-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
  .tw-fg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
  .tw-fg button { background: var(--card-bg); border: none; border-right: 1px solid var(--border-color); padding: 3px var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; }
  .tw-fg button:last-child { border-right: none; }
  .tw-fg button:hover { color: var(--text-main); }
  .tw-fg button.on { background: color-mix(in srgb, var(--action) 10%, transparent); color: var(--action); font-weight: 600; }
  .tw-fsearch { padding: 3px var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font-size: var(--fs-xs); min-width: 12rem; }
  .tw-fcount { font-size: var(--fs-xs); margin-left: auto; }
  .tw-cent { color: var(--warn-fg); } /* monto de la fuente ≠ workbook (centavos/tolerancia) */

  /* ── Export: ghost, discreto — es una acción secundaria ─────────────────── */
  .tw-xls { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-color);
    border-radius: var(--r-sm); color: var(--text-muted); font: inherit; font-size: var(--fs-xs);
    padding: 2px var(--sp-2); cursor: pointer; }
  .tw-xls:hover:not(:disabled) { color: var(--text-main); background: var(--hover-bg); }
  .tw-xls:disabled { opacity: .6; cursor: default; }
  .tw-xls:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
  .tw-xls-head { margin-left: var(--sp-2); vertical-align: middle; }
`;
