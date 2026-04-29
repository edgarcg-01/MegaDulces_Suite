# Script de Corrección Segura de Marcas y Productos

## 🎯 Propósito

Este script está diseñado para **diagnosticar y corregir productos que están asignados a marcas incorrectas** en producción, garantizando:

- ✅ **Cero pérdida de información**
- ✅ **Integridad referencial completa**
- ✅ **Backup automático antes de cambios**
- ✅ **Validación post-corrección**
- ✅ **Logs detallados de auditoría**

## 📋 Estructura de Datos

### Tablas involucradas:
- **`brands`** (marcas): `id`, `nombre`, `activo`, `orden`
- **`products`** (productos): `id`, `brand_id` (FK), `nombre`, `activo`, `orden`, `puntuacion`

### Relación:
```
brands (1) ←→ (N) products
    ↑                    ↑
  brand_id  ←  products.brand_id
```

## 🚀 Modos de Uso

### 1. Modo Diagnóstico (Seguro - Solo lectura)
```bash
node scripts/safe-brand-product-correction.js --dry-run
```
- Analiza la base de datos sin hacer cambios
- Muestra productos con marcas incorrectas
- Genera reporte de correcciones necesarias
- Crea backup de seguridad

### 2. Modo Corrección (Ejecuta cambios)
```bash
node scripts/safe-brand-product-correction.js --execute
```
- Ejecuta las correcciones detectadas
- Aplica cambios validados
- Verifica integridad post-corrección
- Genera log completo de auditoría

## 🔍 Qué detecta el script

### 1. Productos sin marca asignada
- Productos con `brand_id = NULL`
- Productos con `brand_id` que no existe en `brands`

### 2. Productos en marcas incorrectas (basado en patrones)
- **LA ROSA**: Mazapán, Nugs, Suizo, Japonés, Gummy, Paleta, Bombón, etc.
- **HERSHEY**: Pelón, Kisses, Crayón, Pelonetes, Hershey
- **ARCOR**: Nikolo, Bon o Bon, Butter Toffe, Poosh
- **WINIS**: Winis, Maxi Tubo, Frutaffy, Acidup, etc.
- **CANELS**: Canels, Goma Tueni, Cherry Sours, ICEE, etc.
- **OTRAS MARCAS**: Patrones específicos por cada marca

## 🛡️ Características de Seguridad

### 1. Backup Automático
- Guarda JSON completo de `brands` y `products`
- Timestamp único para cada ejecución
- Ubicación: `backups/brands-backup-*.json`

### 2. Validación de Integridad
- Verifica que todos `brand_id` existan en `brands`
- Detecta productos huérfanos
- Valida post-corrección automática

### 3. Logs Detallados
- Registro completo de operaciones
- Timestamp en cada entrada
- Guardado en: `logs/brand-correction-*.log`

### 4. Modo Dry-Run
- Simulación completa sin cambios
- Muestra exactamente qué se corregirá
- Permite revisión antes de ejecución

## 📊 Ejemplo de Salida

### Modo Diagnóstico:
```
📋 RESUMEN DE DIAGNÓSTICO:
   - Marcas: 13
   - Productos: 42
   - Productos sin marca: 0
   - Inconsistencias detectadas: 3

📝 Correcciones de marcas incorrectas (3):
   Mazapán Clásico: "ARCOR" → "LA ROSA" (patrón: mazapan)
   Pelón Gde: "LA ROSA" → "HERSHEY" (patrón: pelon)
   Winis T7: "CANELS" → "WINIS" (patrón: winis)
```

## ⚠️ Precauciones

### Antes de ejecutar en producción:
1. **Verificar conexión** a base de datos correcta
2. **Ejecutar primero** con `--dry-run`
3. **Revisar el reporte** de correcciones propuestas
4. **Hacer backup manual** adicional si es crítico
5. **Ejecutar en horario** de bajo tráfico

### Durante ejecución:
- No interrumpir el script
- Monitorear logs en tiempo real
- Verificar resultado final

## 🔄 Flujo de Ejecución

```
1. Conexión a BD
   ↓
2. Crear backup automático
   ↓
3. Validar integridad referencial inicial
   ↓
4. Detectar inconsistencias
   ↓
5. Mostrar resumen de diagnóstico
   ↓
6. Ejecutar correcciones (solo modo --execute)
   ↓
7. Validar integridad post-corrección
   ↓
8. Generar reporte final
```

## 📁 Archivos Generados

```
backups/
├── brands-backup-2024-04-29T16-30-45-123Z.json
└── products-backup-2024-04-29T16-30-45-123Z.json

logs/
└── brand-correction-2024-04-29T16-30-45-123Z.log
```

## 🚨 En caso de emergencia

### Restaurar desde backup:
```javascript
const fs = require('fs');
const backup = JSON.parse(fs.readFileSync('backups/products-backup-*.json'));
// Restaurar datos usando knex...
```

### Verificar logs:
```bash
tail -f logs/brand-correction-*.log
```

## 📞 Soporte

El script incluye validaciones automáticas que previenen:
- Pérdida de datos
- Corrupción de integridad referencial
- Ejecución sin validación previa

Si encuentras algún problema, revisa el archivo de log generado para detalles completos de la ejecución.
