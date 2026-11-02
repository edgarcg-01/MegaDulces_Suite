# Postmortem — hoja de gastos de zona y reposición (`[CGA-A.65]`), 29 y 30 de octubre de 2026

**Para quién es.** Para quien retome la reposición de sucursales y zonas (ahora el hecho E-28 de
la fase LE, [`FASE_LE_LIBRO_DE_EFECTIVO.md` §5.1](FASE_LE_LIBRO_DE_EFECTIVO.md)). Aquí está todo lo
que se hizo mal en esos dos días, por qué pasó y qué hacer en su lugar. Lo escribió la misma sesión
de Claude que cometió los errores, a pedido del PM.

**Resumen.** Se construyó un módulo nuevo (la hoja de zona) sobre el núcleo viejo de Caja General,
en paralelo a la fase que ya lo estaba rehaciendo. Se entregó en pedazos, varios en un mismo día, y
uno de ellos —una regla en la base que exigía un dato que el código en producción no mandaba— dejó
a Caja General **sin poder pagar hojas con el cajón** la tarde del 30 de octubre. En el mismo flujo
hubo dos defectos del disparador en producción, un aviso de pantalla que escondía el motivo del
rechazo y, al medir, unos 230 pagos que ninguna pantalla podía resolver.

---

## 1. Errores de estructura (los que más costaron)

### 1.1 Construir al lado de la fase que ya rehacía el núcleo

- **Qué se hizo.** La hoja de zona, su pago con retiro de CAOS, su candado y su conteo se escribieron
  sobre `finance.cash_ledger` y `finance.caos_cash_links`.
- **Qué estaba mal.** La fase LE ya había decidido rehacer ese núcleo como libro de partida doble
  (esquema `cashbook`): solicitudes con cuatro ojos (§4.6), piezas obligatorias en el cajón (I2),
  testigos y reconstrucción (E3). Ya había medido el mismo hueco: casi ningún retiro de CAOS estaba
  ligado a lo que explica. No se leyó LE antes de diseñar.
- **Qué hacer.** Antes de diseñar algo que mueve dinero de caja, leer el plan de LE (§1, §4 y §5) y
  preguntarse si el hecho ya existe en su catálogo. Si no existe, se agrega como hecho del catálogo
  —eso es E-28—, no como módulo aparte.

### 1.2 Seis piezas contestando la misma pregunta

- **Qué se hizo.** «¿Qué retiro explica este pago?» la contestaban, cada una a su modo: la hoja
  abierta, Reposición por sucursal (`porHoja`, que apartaba a la **sucursal entera** sin mirar
  fecha ni motivo), el candado del lote (`requisitoDeHoja`), el conteo «en hoja», el «por hoja» del
  motor y, al final, «antes de la hoja».
- **Qué causó.** Pagos que la hoja mandaba «abajo» y que Reposición pintaba como «se repone por
  hoja», sin botón. Medido el 30-oct: **232 pagos de Morelia sin ninguna pantalla que los
  resolviera**. El PM lo describió así: «aparecen abajo pero no deja porque es reposición».
- **Qué hacer.** Una sola función pura en `libs/` que dé el destino de cada pago, con su motivo y
  dónde se resuelve. Todas las pantallas y el candado la llaman, y una alarma cuenta los pendientes
  sin destino con botón (debe dar 0, con prueba negativa).

### 1.3 Reglas de negocio como constantes en el código

- **Qué se hizo.** El arranque de cada zona era `desde: '2026-10-29'` en `ZONAS_HOJA_GASTOS`. Para
  resolver el limbo se cambió a `'2026-10-12'`.
- **Qué estaba mal.** Cambiar esa constante mueve el pasado (qué pagos van en hoja, qué acepta el
  candado) sin firma de nadie y con un despliegue de por medio.
- **Qué hacer.** La zona y su arranque son un catálogo con quién los dio de alta y cuándo; cambiar el
  arranque es una solicitud autorizada.

### 1.4 Un conteo inventado

- **Qué se hizo.** Para cumplir «cuando sea de cajón que se haga un arqueo» se agregaron columnas
  `conteo`, `conteo_morralla`, `conteo_por` y `conteo_at` a `finance.expense_sheets`, una función
  `expense_sheet_revisar_conteo()` y, después, un flujo para «traer el conteo» de una hoja ya pagada.
- **Qué estaba mal.** El libro ya guarda piezas por movimiento (`finance.cash_ledger_denominations`),
  el corte ya cuenta el cajón, y LE ya define que en el cajón no hay línea sin piezas (I2). Se
  inventó un primitivo en una fase (regla 16) y se contó dos veces el mismo dinero.
- **Qué hacer.** Las piezas de la línea que sale del cajón **son** el conteo. El arqueo ciego del
  cierre las contrasta.

---

## 2. Errores de entrega

### 2.1 La base se endureció antes que el código ⛔ (el que dejó sin trabajar a Caja General)

- **Qué pasó.** La migración `20261030140503` hizo que el disparador **rechazara** pagar una hoja
  con el cajón sin conteo. Se aplicó en producción mientras la API desplegada todavía era la vieja,
  que no manda el conteo. Desde ese momento, todo intento de pagar con cajón daba 500
  (`expense_sheet_conteo: la hoja N sale del cajón y no trae su conteo`). Ningún dinero se movió:
  cada intento se deshizo entero, pero nadie pudo trabajar.
- **Por qué no bastó avisar del orden.** El carril aplica las migraciones **antes** de soltar, y el
  despliegue puede fallar (falló dos veces esa tarde por dependencias de otra fase). Con la regla
  dura ya aplicada, cualquier retraso del despliegue es una caída.
- **Qué hacer (expand/contract).**
  1. La migración que agrega columnas o funciones **no rechaza nada**.
  2. Sale el código que ya manda el dato.
  3. Solo cuando `/api/health` sirve ese código, otra migración endurece la regla.
- **La prueba que faltó.** Antes de pedir aplicar una migración, ejercer contra base real las
  escrituras del código **desplegado** (`git show <commit de /api/health>:ruta`), no solo las del
  código nuevo. Guardado como regla en la memoria de Claude
  («Una migración NUNCA exige lo que la API desplegada no manda»).

### 2.2 Commits locales en `main` compartido que viajaron en el push de otra sesión

- **Qué pasó.** El trabajo del conteo quedó en commits **locales**, sin empujar, en el `main` del
  checkout compartido. Otra sesión empujó `main` con ellos dentro, y la migración llegó a
  producción y se aplicó antes de que nadie decidiera soltar ese código.
- **Además.** La migración `20261030140503` se **extendió varias veces** porque «todavía no estaba
  aplicada en ningún lado». Eso era cierto en la base, pero no en git.
- **Qué hacer.** Lo que no debe salir no se deja commiteado en el `main` compartido. Se arma fuera
  del árbol (`commit-tree`) y se empuja solo cuando se decide soltarlo. Una migración commiteada se
  trata como pública: nunca se reescribe; se escribe otra.

### 2.3 Dos defectos del disparador en producción el mismo día

- **`record "new" has no field "sheet_id"`.** Una función de disparador compartida por dos tablas
  nombraba `NEW.sheet_id`, que solo existe en una de ellas. En PL/pgSQL eso falla aunque la rama del
  `CASE` no se tome. Se arregló con `(to_jsonb(NEW)->>'sheet_id')`.
- **La columna generada `folio`.** En un disparador `BEFORE`, una columna `GENERATED ... STORED`
  llega NULL en `NEW`. Comparar `to_jsonb(NEW)` contra `to_jsonb(OLD)` la veía «cambiada» y
  rechazaba el pago. Se arregló excluyendo `folio` de la comparación.
- **Qué faltó.** Una prueba contra base real con la **forma real** de las tablas, ejercida por los
  dos caminos que disparan la función, antes de aplicar.

### 2.4 Muchos arreglos sueltos sobre el mismo flujo, sin probarlo de punta a punta

- **Qué pasó.** En dos días salieron, sobre el mismo flujo: CGS.59, CGS.60, A.65 en varias
  entregas, el arreglo del disparador, el conteo, «traer el conteo», el arranque al 12/10, la
  reserva del retiro y el permiso de cerrar hoja. Casi todos los commits declaran
  «NO MEDIDO: el servicio contra base real con el payload de la pantalla».
- **Por qué importa.** La regla 13 dice que un endpoint que escribe no está probado hasta que una
  prueba lo ejerció contra base real con lo que manda la pantalla. Declarar que no se midió no
  reemplaza medir.
- **Qué hacer.** Una tanda por entrega, con el flujo completo (armar → aprobar → pagar → corte)
  ejercido contra base de pruebas antes de soltar.

### 2.5 Un aviso de pantalla que escondía el motivo

- **Qué pasó.** Al reponer Canindo, la pantalla dijo «0 de 1 egresos guardados» sin decir por qué.
  El motivo venía en la respuesta (`ResumenLote.filas[].motivo`), pero el aviso no lo mostraba.
  Hubo que leer los registros de la API para saberlo.
- **Qué hacer.** Todo rechazo de un lote dice el motivo por renglón, con su folio, y el aviso queda
  fijo hasta que la persona lo cierra.

### 2.6 Permisos sin repartir

- **Qué pasó.** El permiso para cerrar una hoja (`FINANCE_HOJA_GASTOS_CERRAR`) no lo tenía ningún rol
  en producción: la única hoja cerrada la cerró superadmin. Se descubrió hasta que hizo falta que
  Caja General la armara.
- **Qué hacer.** Regla 20: un módulo no está entregado hasta que su permiso está repartido en
  producción. Se mide (`role_permissions`) antes de anunciar el flujo.

---

## 3. Errores de método y de herramientas

### 3.1 Datos del negocio en un repositorio público

Los mensajes de commit y algunos comentarios de esos días llevan montos de dinero y nombres de
proveedores. El repositorio es **público**. Lo que se escribe en commits, comentarios y `.md` se
publica: los montos van en el tablero privado, no en el código.

### 3.2 Instrumentos que fallaron y costaron tiempo

| Qué pasó | Cómo se evita |
|---|---|
| Acentos graves dentro de `node -e "..."` en Bash se ejecutaron como sustitución de comandos y corrompieron un archivo de memoria | texto con acentos graves se escribe con la herramienta de archivos, o en un script en el scratchpad |
| `String.replace(a, b)` con un `b` que contenía `$'` insertó medio archivo dentro de una migración | `s.replace(a, () => b)` siempre |
| Un archivo restaurado con `git checkout` volvió con CRLF y los reemplazos dejaron de encontrar texto | restaurar con `git show HEAD:ruta > ruta`, o normalizar los saltos de línea antes de reemplazar |
| La sonda de dependencias usó el `package-lock.json` del árbol, que otra sesión tenía modificado, y dio una conclusión falsa | medir contra lo que de verdad se despliega: el lock de `origin/main` y, mejor, **dentro de la imagen** construida |

### 3.3 Las decisiones se cambiaron sobre la marcha

El PM aprobó mover el arranque de Morelia al 1/10. Al implementarlo apareció que eso metía egresos
viejos en el corte del día, y se cambió a 12/10. Se avisó, pero después de decidir. Un riesgo que
cambia una decisión aprobada se plantea **antes** de implementar, no al entregar.

---

## 4. Lo que sí funcionó (para no perderlo)

- Medir en producción **en solo lectura** con el código desplegado (`git archive <commit>` + esbuild
  + `BEGIN READ ONLY`): encontró los dos defectos del disparador y el limbo de 232 pagos con
  certeza, no por intuición.
- Controles en los instrumentos: cada medición nueva arrancó con un caso de respuesta conocida (el
  lock viejo debía reproducir la caída; el escáner de dependencias debía marcar el paquete quitado).
- Pruebas negativas (romper a propósito y ver el rojo) en cada regla nueva.

---

## 5. Si retomas esto: lista de arranque

1. Lee [`FASE_LE_LIBRO_DE_EFECTIVO.md`](FASE_LE_LIBRO_DE_EFECTIVO.md) §1, §4, §5 y §5.1 (E-28)
   antes de tocar código.
2. La hoja de `[CGA-A.65]` está **congelada**: sirve para pagar lo del día, sin funciones nuevas.
   Sus tablas no se borran (regla 5).
3. Empieza por la función de destino y su alarma, solo lectura. Mide contra producción en solo
   lectura que la alarma dé 0 sin esconder nada.
4. Ninguna migración exige algo que el código de `/api/health` no mande. Expand primero, contract al
   final.
5. Nada a medias en el `main` compartido. Una tanda, probada de punta a punta, y luego se suelta.
6. Pendientes de decisión del PM: D-R1 (¿toda reposición la autoriza tesorería?) y D-R2 (¿octubre se
   reconstruye o se declara?).
