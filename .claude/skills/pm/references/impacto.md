# Análisis de impacto — «qué se rompe si…»

Se recorre el código; no se adivina. Salida: tabla
`pieza | archivo:línea | qué cambia | quién lo siente (puesto) | riesgo | cómo se prueba`.

| Si el cambio toca… | Recorrer | Lección que lo exige |
|---|---|---|
| Un tipo de `libs/contracts` | `git grep` del campo en `apps/*` y `libs/*`, **plantillas Angular incluidas** | #346: `priority` nullable → `TS2538` en 3 plantillas con 2657 tests verdes (vitest no tipa plantillas) |
| Una columna `NOT NULL` o una PK | `grep` del nombre de la tabla: **todos** los caminos que insertan | `denom_key`: se actualizó 1 de 2 inserciones → arqueo 8 días sin cerrar |
| Una vista | Quién la lee (`apps/`, `libs/`, `database/`) y vistas dependientes | Recrear una vista viva da `0A000` (planes cacheados) |
| Un decorador, provider o firma inyectada de Nest | Prueba de `design:paramtypes`, o declarar «arranque no verificado» | #414: API caída en prod con CI verde |
| Cómo falla una API | Cada consumidor y cada camino de fallo | VAC.L3: `200 {ok:false}` se pintaba como «no encontrado» |
| Un permiso | `MATRIZ_ACCESOS.md`: qué puestos ganan o pierden qué | SM.10: `auxiliar_tienda` perdía la diferencia pero seguía viendo la venta |
| Una migración | `node scripts/nueva-migracion.js`; aditiva **antes** del código que la lee; `check:mig-colisiones` | 187 de 1,084 migraciones comparten marca |
| Una tabla que más de una sesión escribe | Quién más la toca hoy (`git log -S`, commits recientes) | CGA frente C |
| Una pieza compartida de UI | Cuántas pantallas la usan; extender **aditivo** | `app-metric-strip`: 96 pantallas, `density="compact"` con default intacto |
| Un número publicado | Quién lo consume para decidir y el antes/después | ADR-051, CANON.0.1 |

Cierre del análisis: qué **no** se pudo recorrer, dicho como NO MEDIDO.
