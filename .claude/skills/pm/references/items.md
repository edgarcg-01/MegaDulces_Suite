# Items del tracker — historias, criterios y Definition of Ready

## 1. El formato real (no inventar otro)

Así se escriben en `01_TRACKER_PROGRESO.md` (medido sobre SM, GX, VAC):

```markdown
- [ ] **[XX.N]** ⬜ **<Frase que dice qué cambia para quién, no la tarea>** — AAAA-MM-DD. <cuerpo>
```

- **Código**: prefijo de la fase + número correlativo (`SM.12`, `GX.59`). Sufijo letra para
  partir un item (`CGA-A.15b`, `VAC.4a`) o tema (`VAC.H2`, `VAC.L3`). **No** se codifica la capa en
  el número: la capa va en el cuerpo o en la sección.
- **Título = resultado**, no actividad: «El arqueo se engancha al TURNO de Kepler», no «Implementar
  endpoint de turnos». Así se escriben también los commits: `feat([XX.N]): <la misma frase>`.
- **Estado** con símbolo: ⬜ → 🔨 → 🧪 → 🚀 → ✅ · ⚠️ BLOCKED · ❌ REVERTED.

## 2. El cuerpo de un item que se va a hacer

```markdown
- [ ] **[XX.N]** ⬜ **<resultado>** — <fecha>.
  **Para:** <puesto real, de MATRIZ_ACCESOS> · **Por qué:** <qué cambia en la MÉTRICA de la fase, con monto si hay>
  **Capa:** C0|C1|C2|C3 · **Depende de:** <XX.M (estado requerido)>
  **Criterios:**
  - Dado <datos concretos>, cuando <acción>, entonces <resultado con cifra + unidad + universo>.
  - Dado <sin dato / fuente caída>, entonces <«sin dato» / `status:'unknown'`> — nunca 0.
  - Dado <error del servidor>, entonces <se distingue de vacío>.
  - ❌ Dado <puesto sin la clave XX_VER>, cuando <llama>, entonces 403.
  **Verificado contra:** <testigo independiente, mismo ERP y grano>.
  **¿Escribe?** sí → prueba contra base real con el payload de la pantalla.
  **No incluye:** <lo que alguien va a suponer que entra>.
```

## 3. Reglas de los criterios

- **Uno por camino**: feliz · vacío · sin dato · error · sin permiso. Los cinco son distintos.
- **Cifra con unidad y universo.** «Ve el total» no se puede verificar; «el total en pesos sin IVA
  de la 01 del día cuadra con `kdm1` U/D/10 al centavo» sí.
- **Si cambia un número**: criterio de antes/después con la misma consulta. Si además optimiza, son
  **dos items** (optimizar ≠ cambiar alcance de negocio).
- **Si inventa un mecanismo genérico** (frescura, cobertura, bandeja…): criterio de que vive en
  `libs/`, o item de deuda con nombre (ADR-056).
- **C3**: permiso propio **repartido** en prod, entrada de sidebar, <500 ms, `check:pantalla` sin
  fallas nuevas.
- **Seguridad/BD**: el criterio intenta **violar** la defensa y espera el error exacto.

## 4. Definition of Ready (no pasa a 🔨 sin esto)

- [ ] Fase con fila en el roadmap y cupo (`tablero.js`)
- [ ] Métrica de la fase con «HOY» medido
- [ ] Capa de abajo ✅ o verificada (C0 con árbitro)
- [ ] Fuente identificada en `kepler_ods.*` — sin importer, sin copia de tabla
- [ ] Criterios de los cinco caminos, con cifra y unidad
- [ ] Impacto recorrido (`impacto.md`), dependencias nombradas
- [ ] Decisiones de negocio que lo afectan, firmadas
- [ ] Escritura pesada en prod → ventana fuera de horario hábil

## 5. Tamaño

No hay story points. Un item que no cabe en un commit revisable se parte (`a`, `b`). Lo que
compromete es **la fecha de cierre de la fase y su dueño**; la fase que pierde cualquiera de los
dos cae a ⏸️ (método §3).
