/**
 * Vocabulario visual del CUADRE de Finanzas — fuente única para `/finanzas/caja` y para la
 * pestaña Cuadre de `/finanzas/bancos`.
 *
 * Las dos pantallas responden la misma pregunta con la misma forma: enfrentar N fuentes que
 * deberían decir lo mismo, declarar si cuadran, y dejar abrir el renglón que no cuadra para
 * ver, lado a lado, qué tiene una fuente que la otra no. Mientras cada una tenía su propia
 * copia de las reglas, el mismo concepto se veía distinto en cada lado (una con iconos
 * pelados y la otra con `p-tag`, una con drill en diálogo y la otra inline, dos escalas
 * tipográficas). Esto lo vuelve un solo sistema.
 *
 * Uso:  styles: [CUADRE_STYLES, `…lo propio de esta vista…`]
 *
 * Regla: una clase que necesiten las dos pantallas va acá — no se copia. El prefijo `cg-`
 * se conserva (nació en caja) para no reescribir la pantalla que ya lo usaba.
 * Tokens en libs/design-tokens/tokens.css. Cero hex crudo.
 */
export const CUADRE_STYLES = `
  :host { display:block; }

  /* ── Tipografía de dato ─────────────────────────────────────────────────
     tabular-nums obligatorio: sin esto las columnas de cifras no se leen como columnas. */
  .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .strong { font-weight:700; }
  .muted { color:var(--text-faint); }
  .warn { color:var(--warn-fg); font-weight:700; }
  .ta-r { text-align:right; } .ta-c { text-align:center; }
  /* Calificador de una columna ("(caja)", "(manual)", "(ERP)"): baja de peso, no de sitio. */
  .cg-sub { font-weight:500 !important; font-size:.68rem !important; color:var(--text-faint) !important; }
  /* Fuente informativa — su diferencia no es descuadre accionable. */
  .cg-kep { color:var(--text-faint); font-style:italic; }
  .cg-eg { color:var(--warn-fg); } .cg-in { color:var(--ok-fg); }
  .cg-ok-i { color:var(--ok-fg); }
  .cg-bad-i { color:var(--bad-fg); }
  .cg-emp { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ── Control-total: las N fuentes enfrentadas, 2 renglones (entra / sale) ──
     Tabla cruda y no p-table a propósito: lleva encabezados agrupados y es de 2 filas. */
  .cg-kve-wrap { overflow-x:auto; margin-bottom:.6rem; }
  table.cg-kve { width:100%; border-collapse:collapse; font-size:.82rem; }
  table.cg-kve th, table.cg-kve td { padding:.35rem .6rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
  table.cg-kve thead th { font-size:.68rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); font-weight:700; }
  table.cg-kve tbody th[scope=row] { text-align:left; font-weight:600; color:var(--text-main); }
  table.cg-kve tbody tr:last-child td, table.cg-kve tbody tr:last-child th { border-bottom:none; }

  /* ── Veredicto: una línea, DESPUÉS de la tabla y su nota ──
     Va después a propósito: primero se ve el dinero, después la lectura. Borde izquierdo de
     3px como único portador de estado además del icono (elevación = borde, nunca sombra). */
  .cg-verdict { display:flex; align-items:center; gap:.5rem; padding:.6rem .85rem; margin:.4rem 0 .2rem;
    border:1px solid var(--border-color); border-left:3px solid var(--border-color); border-radius:var(--r-md);
    background:var(--card-bg); font-size:.85rem; }
  .cg-verdict.ok { border-left-color:var(--ok-fg); } .cg-verdict.ok .pi { color:var(--ok-fg); }
  .cg-verdict.warn { border-left-color:var(--warn-fg); } .cg-verdict.warn .pi { color:var(--warn-fg); }

  /* Aviso de contexto (falta una fuente, hay captura pendiente): mismo cuerpo que el veredicto. */
  .cg-legacy-note { display:flex; align-items:center; gap:.55rem; padding:.55rem .8rem; margin:.1rem 0 .7rem;
    border:1px solid var(--border-color); border-left:3px solid var(--warn-fg); border-radius:var(--r-md);
    background:var(--card-bg); font-size:.78rem; color:var(--text-muted); line-height:1.45; }
  .cg-legacy-note .pi { color:var(--warn-fg); }
  .cg-legacy-note b { color:var(--text-main); }

  /* Nota al pie: qué es cada fuente y qué significa el Δ (DESIGN §Q.2). */
  .cg-note { margin-top:.6rem; font-size:.74rem; color:var(--text-faint); line-height:1.5; }

  /* ── Fila expandible: el drill vive DENTRO de la tabla, no en un diálogo ──
     Así no se pierde el renglón de contexto ni hace falta volver a buscarlo al cerrar. */
  .cg-w-x { width:2.2rem; }
  .cg-w-d { width:3.5rem; } .cg-w-date { width:6rem; } .cg-w-e { width:6rem; }
  .cg-row-click { cursor:pointer; }
  .cg-row-click:hover { background:var(--hover-bg); }
  .cg-row-open { background:color-mix(in srgb, var(--action) 5%, transparent); }
  .cg-chev { font-size:.7rem; color:var(--text-faint); }
  .cg-detail-row > td { background:var(--surface-ground, var(--card-bg)); padding:.6rem .9rem !important; }

  /* ── Detalle del descuadre: qué tiene una fuente que la otra no ──
     Dos columnas enfrentadas por par de fuentes. El encabezado de cada columna lleva conteo
     Y monto: sin el monto, "18 movimientos" no dice si el problema es grande o chico. */
  .cg-drill-lead { font-size:.78rem; color:var(--text-main); line-height:1.5; margin:.2rem 0 .7rem; }
  .cg-pair { margin-bottom:.9rem; }
  .cg-pair-t { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; font-weight:700; color:var(--text-muted);
    border-bottom:1px solid var(--border-color); padding-bottom:.2rem; margin-bottom:.4rem; }
  .cg-side { margin-bottom:.6rem; }
  .cg-side-h { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; margin-bottom:.25rem; }
  .cg-side-name { font-size:.8rem; font-weight:700; color:var(--text-main); }
  .cg-side-sub { font-size:.68rem; }
  .cg-drill-clean { font-size:.75rem; margin:.15rem 0; }
  .cg-drill-cols { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; }
  @media (max-width:720px) { .cg-drill-cols { grid-template-columns:1fr; } }
  .cg-drill-col { border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; }
  .cg-drill-colh { font-size:.68rem; font-weight:700; padding:.3rem .5rem; border-bottom:1px solid var(--border-color); }
  /* El lado de la fuente de referencia se tinta con la acción; el otro, neutro. */
  .cg-col-caja { background:color-mix(in srgb, var(--action) 10%, transparent); color:var(--text-main); }
  .cg-col-other { background:color-mix(in srgb, var(--text-faint) 10%, transparent); color:var(--text-main); }
  .cg-drill-none { font-size:.72rem; padding:.3rem .5rem; }
  .cg-daywrap { overflow-x:auto; }
  .cg-daytbl { width:100%; border-collapse:collapse; font-size:.78rem; }
  .cg-daytbl th { text-align:left; font-size:var(--fs-xs); text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); padding:3px 8px; border-bottom:1px solid var(--border-color); }
  .cg-daytbl td { padding:3px 8px; border-bottom:1px solid var(--border-color); }

  /* Un drill que falla lo DICE: antes el catch guardaba [] y un 404/403 se leía igual que
     "no hubo nada". */
  .cg-dayerr { display:flex; align-items:flex-start; gap:var(--sp-2); padding:var(--sp-2) var(--sp-3); font-size:var(--fs-xs); color:var(--warn-fg); }
  .cg-dayerr i { margin-top:2px; flex:none; }

  .cg-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2rem 1rem; text-align:center; color:var(--text-muted); }
  .cg-empty .pi { font-size:1.6rem; color:var(--text-faint); }
  .cg-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }

  :host ::ng-deep .cg-tag { font-size:.64rem; }
`;
