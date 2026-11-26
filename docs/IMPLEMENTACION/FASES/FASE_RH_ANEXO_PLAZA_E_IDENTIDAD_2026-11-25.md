# Fase RH · Anexo — La persona no tiene plaza: cambiar de plaza, bajas e identidad en Asistencia

> 2026-11-25 · `[RH.21]` · Origen: Edgar intentó «mover» a una persona de 8-Esquinas a PH desde la ficha de
> `/rh/asistencia` y siguió en 8-Esquinas. Este anexo explica por qué, mide cuántos casos hay de la misma familia
> y propone el orden para arreglarlo **de raíz**.
>
> ⚠️ El repo es público: aquí no van nombres de personas. Los casos se citan por plaza y código del reloj.

---

## 1. El caso que lo destapó

En la ficha de una persona (plaza 8-Esquinas, código 6), RH cambió la **sección** de `ESQUINAS` a `PH` creyendo
mandarla a la sucursal PH. Se guardó bien (queda en `identity.user_events`, `ficha_plaza_editada`), y la persona pasó
al grupo «PH (3)» **dentro del reporte de 8-Esquinas**. Nunca salió de 8-Esquinas, y no podía salir: nada en la ficha
decide la plaza.

## 2. El modelo real: tres cosas que en pantalla parecen una

| En pantalla | Qué es | Dónde vive | Quién lo decide | ¿Lo cambia «Editar»? |
|---|---|---|---|---|
| **Plaza** (selector de arriba) | El reloj donde checa. El reporte de una plaza = quien checó en sus relojes | `hr.device_enrollments` → `hr.attendance_devices.site_code` | El reloj físico | **No** |
| **Sección** | Un grupo dentro del reporte de ESA plaza. Texto libre, por plaza | `hr.person_site_profiles.report_section` | RH | Sí |
| **Departamento · puesto · sucursal** | Datos de la persona en la Suite | `identity.users` | RH (sin acceso) o Sistemas (con acceso) | Sí (sin acceso) |

Y una cuarta, que es la trampa más fina: **el código del reloj es por plaza, no por persona.** El «6» de 8-Esquinas
y el «6» de Sucursal PH son dos personas distintas. Por eso «mover» a alguien no puede ser cambiar un campo: en la
plaza nueva tiene otro número, en otro equipo, con su huella registrada ahí.

**La causa raíz:** la persona no tiene plaza propia, sólo «relojes donde aparece». La plaza, la baja y hasta la
identidad cuelgan del reloj (`plaza + código`), no de la persona (`user_id`). Cada arreglo en pantalla tapa un
síntoma y el siguiente aparece en otro lado.

## 3. Lo que hay de la misma familia — medido en prod el 2026-11-25 (sólo lectura)

Universo: 363 combinaciones plaza + código que checaron en los últimos 14 días (`hr.attendance_logs`).

| # | Hallazgo | Tipo | Casos hoy | Gravedad |
|---|---|---|---|---|
| H1 | **No existe «cambiar de plaza».** La única palanca visible es la sección, que no mueve nada | Estructural | — (cada cambio de plaza que pida RH) | Alta |
| H2 | **La baja no tiene fecha y borra hacia atrás.** `is_active=false` saca a la persona de TODOS los periodos (`attendance-reader.ts:138`, `logic/asistencia-persona.ts:284`): las horas trabajadas antes de la baja no llegan a la prenómina ni al banco de horas extra, y tampoco cuentan como «sin identificar» al cerrar | Lógico | **10 fichas, ~106 días trabajados** en 56 días que hoy no aparecen en ningún reporte | **Muy alta** (dinero de nómina) |
| H3 | **De baja y siguen checando.** La baja vive sólo en la Suite: el reloj la acepta y el reporte la esconde sin avisar | Estructural + diseño | 5 en 14 días (1 con la persona archivada) | Alta |
| H4 | **Dos identidades para la misma persona**: una cuenta con acceso (inicia sesión) y otra `sin_acceso` (la que checa), con el mismo nombre. RH edita departamento y sucursal en la que no inicia sesión | Estructural (datos) | 10 parejas de nombre idéntico (en las 10 el reloj está en la `sin_acceso`) + 4 de nombre parecido | Alta |
| H5 | **Secciones con el nombre de otra plaza** («PH» dentro de 8-Esquinas, «STAFF LA PIEDAD» en otras cinco, «RD» dentro de Sucursal PH…). Heredadas de Mega Talento, donde la sección mezclaba áreas con plazas, y la lista de la ficha las ofrece | Diseño | ~15 personas | Media |
| H6 | **«Es promotora» engaña.** La casilla arranca del filtro de la vista y no de `is_promoter`; además una sección que contiene «promotor» la hace promotora aunque la casilla esté apagada. Al desmarcar dice «ahora en Planta» y sigue en Promotoras | Lógico | 7 | Media |
| H7 | **Sin sección, el grupo lo decide el departamento** de la persona (`reader.ts:93`): cambiar el departamento la mueve de grupo en todas sus plazas sin decirlo | Diseño | 170 fichas activas sin sección | Media |
| H8 | **El código guarda el estado y quien lo hereda, lo hereda todo**: ficha, horario, incidencias y ajustes de horas extra van por `plaza + código`; ligar sólo cambia `device_enrollments.user_id` | Lógico | 0 hoy (latente: aparece al reusar un número) | Alta cuando ocurra |
| H9 | **«Semana cerrada» sólo bloquea incidencias.** Horario, sección, baja y ajustes se pueden cambiar después del cierre, y el PDF «para firmar» se recalcula en vivo | Lógico + diseño | 0 cierres registrados (latente: muerde en cuanto se empiece a cerrar) | Alta cuando ocurra |
| H10 | **Checan en dos o más plazas**: el reporte es por plaza; falta confirmar si la semana de esa persona se parte | Estructural, por confirmar | 8 personas | Por medir |
| H11 | **Checan sin persona ligada**: salen con el apodo del reloj | Proceso | 49 códigos | Media |
| H12 | «Actualizar en el reloj» escribe el nombre antes de que el reloj lo aplique; si la orden falla, la Suite cree que ya quedó | Lógico | 0 hoy | Baja |
| H13 | El horario asignado no llega al detector de alertas (`person_schedules.schedule_id` siempre vacío) | Lógico | 162 de 162 (sin consumidor visible hoy) | Baja |

Las consultas de cada cifra están al final (§7). **Corrección de una medición del mismo día:** un primer conteo dio
526 personas «de baja y siguen checando»; usaba `device_enrollments.last_seen_at`, que se refresca cada 30 min al
leer la lista de usuarios del reloj, no al checar. La cifra con checadas reales es 5.

## 4. El modelo que se propone

**La persona tiene plaza; los relojes son la evidencia.**

1. **Plaza de adscripción con vigencia**, por persona (`user_id`), con fecha desde/hasta. El reporte de una plaza en
   un periodo = quienes estaban adscritos ahí en ese periodo, más quien checó ahí sin estarlo (marcado como
   «checó fuera de su plaza», no escondido).
2. **La baja es un hecho con fecha**, no una casilla: cuenta desde su fecha hacia adelante, nunca hacia atrás (cierra H2).
   Una baja con checadas posteriores se avisa (cierra H3).
3. **Lo que se le asigna a una persona va por `user_id`**, no por `plaza + código` (horario, incidencias, ajustes,
   ficha). El código del reloj queda como dato del enrolamiento (cierra H8).
4. **El acto «Cambiar de plaza»** (cierra H1): elegir la plaza destino y la fecha →
   - la Suite manda dar de alta a la persona en el reloj destino (el agente ya sabe crear usuarios:
     `restaurar_usuario` en `database/importers/checadores/agente/escritura.js`), con un código libre y su nombre;
   - queda pendiente «registrar su huella en el reloj de <plaza>». ⛔ La huella **no viaja**: la librería del reloj
     no lee plantillas, así que alguien la registra en el equipo;
   - con la primera checada en el reloj destino, la adscripción anterior se cierra con la fecha. Opción «se queda
     también en la plaza de origen» para quien checa en dos (H10).
5. **La sección deja de ofrecer nombres de plaza** y se dice en claro que es sólo un grupo del reporte (H5); la
   casilla de promotora lee y escribe `is_promoter` y nada más (H6); sin sección se dice «sin sección», no el
   departamento disfrazado (H7).
6. **El cierre congela todo lo que cambia la semana** (H9), y el PDF de una semana cerrada sale del `snapshot`.
7. **Fusionar las identidades duplicadas** (H4) con la regla del ligado: la cuenta con acceso se queda y la
   `sin_acceso` se funde en ella (enrolamientos, ficha, historial). Cada pareja se confirma antes de fundir.

## 5. Orden propuesto (por capas, `METODO_DE_TRABAJO`)

| Paso | Qué | Capa | Por qué en este orden |
|---|---|---|---|
| 1 | **H2: la baja con fecha** (no borrar hacia atrás) + recuperar los ~106 días de las 10 fichas | C1 lógica | Es dinero de nómina y hoy está pasando |
| 2 | H4: fusionar identidades (las 10 parejas, confirmadas una a una) | C0 datos | Sin una sola identidad, la adscripción del paso 3 se pondría a la persona equivocada |
| 3 | Adscripción con vigencia + estado por `user_id` (H8) | C0 + C1 | Es la base de todo lo demás |
| 4 | El acto «Cambiar de plaza» (H1, H10) | C2 + C3 | Necesita el paso 3 |
| 5 | Pantalla: sección, promotora, sin sección, avisos de baja con checadas (H3, H5, H6, H7) | C3 | Se puede adelantar en paralelo: no depende del modelo |
| 6 | Cierre que congela (H9) antes de cerrar la primera semana | C1 | Latente hoy (0 cierres), pero obligatorio antes del primero |
| 7 | H11, H12, H13 | C1/C3 | Menores |

## 6. Decisiones que son de Edgar / RH

- **D1.** El reporte de una plaza: ¿quien está **adscrito** ahí (propuesto, con «checó fuera de su plaza» visible) o
  sólo quien **checa** ahí (como hoy y como Mega Talento)?
- **D2.** Quien checa en dos plazas: ¿una adscripción principal y la otra como «apoyo», o dos adscripciones iguales?
- **D3.** Las 10 fichas de baja con días trabajados antes de la baja: ¿se recuperan esas horas para la nómina de su
  semana? (Requiere ver con RH a qué semana corresponden.)
- **D4.** Las 10 parejas de identidad duplicada: confirmar que cada pareja es la misma persona antes de fundir.

## 7. Instrumentos (sólo lectura, prod, 2026-11-25)

```sql
-- Universo: plaza + código que checaron en 14 días
SELECT count(*) FROM (SELECT DISTINCT d.site_code, l.device_user_id FROM hr.attendance_logs l
  JOIN hr.attendance_devices d ON d.id = l.device_id WHERE l.punched_at > now() - interval '14 days') z;   -- 363

-- H2: fichas de baja con checadas en 56 días (y días-persona que se pierden)
SELECT d.site_code, COALESCE(e.person_code, e.device_user_id) code, count(DISTINCT l.punched_local::date) dias
  FROM hr.device_enrollments e JOIN hr.attendance_devices d ON d.id = e.device_id
  JOIN identity.users u ON u.id = e.user_id
  LEFT JOIN hr.person_site_profiles p ON p.site_code = d.site_code AND p.person_code = COALESCE(e.person_code, e.device_user_id)
  JOIN hr.attendance_logs l ON l.device_id = e.device_id AND l.device_user_id = e.device_user_id
 WHERE l.punched_at >= now() - interval '56 days' AND (p.is_active = false OR u.status NOT IN ('active','invited'))
 GROUP BY 1, 2;                                                                                              -- 10 fichas, 106 días

-- H3: de baja en la plaza y checó ahí en 14 días
SELECT count(*) FROM hr.person_site_profiles p
  JOIN (SELECT DISTINCT d.site_code, l.device_user_id c FROM hr.attendance_logs l JOIN hr.attendance_devices d ON d.id = l.device_id
         WHERE l.punched_at > now() - interval '14 days') k ON k.site_code = p.site_code AND k.c = p.person_code
 WHERE NOT p.is_active;                                                                                      -- 5

-- H4: parejas con acceso / sin acceso de nombre idéntico
WITH n AS (SELECT id, role_name, upper(translate(regexp_replace(trim(nombre), '\s+', ' ', 'g'), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) k
             FROM identity.users WHERE deleted_at IS NULL AND status IN ('active','invited'))
SELECT count(*) FROM n a JOIN n b ON a.k = b.k AND a.role_name <> 'sin_acceso' AND b.role_name = 'sin_acceso';  -- 10

-- H6: la sección dice promotora y la casilla no
SELECT count(*) FROM hr.person_site_profiles
 WHERE is_active AND NOT is_promoter AND report_section ~* 'promotor' AND report_section !~* 'mega\s*dulces';  -- 7

-- H7: fichas activas sin sección
SELECT count(*) FROM hr.person_site_profiles WHERE is_active AND (report_section IS NULL OR trim(report_section) = '');  -- 170

-- H9: cierres registrados
SELECT count(*) FROM hr.attendance_closures;                                                                -- 0

-- H13: horarios asignados sin schedule_id
SELECT count(*) FILTER (WHERE schedule_id IS NULL), count(*) FROM hr.person_schedules;                      -- 162 / 162
```

Descartado al medir: «un código ligado en un reloj y suelto en otro de la misma plaza» daba 93, pero todos en relojes
inactivos; con relojes activos, 0. «Incidencias cuyo código hoy es de otra persona»: 0. «Nombre escrito por una orden
al reloj que falló»: 0. Quedan como latentes (H8, H12), no como casos.
