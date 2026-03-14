# Análisis del proyecto Presencia

## 1) Resumen ejecutivo

Presencia es una aplicación web "single-page" sin backend, orientada a la operación de cultos en tiempo real. El producto ya cubre necesidades clave (proyección, himnario, canciones libres, Biblia, orden del culto, anuncios, audio, utilidades y remoto), con una UX sólida para operación local.

El mayor valor actual es su **autonomía offline parcial** y su **arquitectura de ventanas desacopladas** (panel/proyección/remoto). La principal deuda técnica es el tamaño y acoplamiento de `index.html`, que concentra estilos, estructura y lógica de múltiples dominios en un único archivo.

---

## 2) Lectura técnica del estado actual

### Fortalezas

- App 100% navegador, simple de desplegar y usar.
- Comunicación panel/proyección por `BroadcastChannel` (rápida, sin servidor).
- Persistencia local en `localStorage` para contenido y configuración.
- Cobertura funcional amplia para operación de culto.
- Control remoto por WebRTC (PeerJS) con código simple de conexión.

### Riesgos / limitaciones observadas

1. **Monolito front-end**: gran parte de la lógica está en `index.html`, dificultando testeo, mantenibilidad y evolución.
2. **Dependencia de internet para Biblia/remoto**: no hay fallback robusto cuando falla conectividad.
3. **Persistencia sin versionado de esquema**: cambios futuros en estructuras JSON pueden romper compatibilidad.
4. **Escalabilidad de datos en `localStorage`**: imágenes base64 y librerías grandes pueden exceder cuota.
5. **Sin suite de pruebas automatizadas**: alto riesgo de regresiones al agregar funciones.
6. **Sin empaquetado modular**: no hay separación por dominios (`himnos`, `orden`, `anuncios`, etc.).

---

## 3) Propuestas de mejora (priorizadas)

## Prioridad alta (impacto inmediato)

### A. Modularización incremental

- Separar `index.html` en:
  - `src/ui/` (render y componentes)
  - `src/modules/` (himnos, canciones, biblia, orden, anuncios, audio, remoto)
  - `src/core/` (estado global, storage, bus de eventos, utilidades)
- Mantener compatibilidad usando una fase intermedia con scripts ES modules.

**Beneficio**: menor complejidad cognitiva, cambios más seguros, base para pruebas.

### B. Capa de almacenamiento robusta

- Crear `storageService` con:
  - versionado (`schemaVersion`)
  - migraciones automáticas
  - validación básica de payload (shape checking)
  - fallback de recuperación ante JSON corrupto

**Beneficio**: menos pérdida de datos y upgrades más seguros.

### C. Migrar medios a IndexedDB

- Dejar `localStorage` para configuración ligera.
- Mover imágenes de anuncios/audio metadata a IndexedDB.

**Beneficio**: evita límites de cuota y mejora estabilidad.

### D. Observabilidad mínima

- Implementar logger con niveles (`info`, `warn`, `error`) y panel de diagnóstico opcional.
- Registrar eventos críticos: conexión remoto, fallos API Biblia, import/export.

**Beneficio**: soporte más rápido y diagnóstico en producción.

---

## Prioridad media (producto)

### E. Mejora de resiliencia offline

- Cachear últimas consultas bíblicas y capítulos recientes.
- Mostrar estado de red y modo degradado.
- Reintentos con backoff para API bíblica.

### F. Accesibilidad y operación

- Navegación por teclado más completa en panel.
- Modo alto contraste y presets tipográficos.
- Señales visuales de foco más visibles.

### G. Flujo de operación en vivo

- "Centro de control" con estado consolidado: módulo activo, texto en proyección, cronómetro, remoto conectado.
- Botón global de pánico (limpiar + negro + detener audio).

---

## Prioridad estratégica (nuevas capacidades)

### H. Multi-operador (roles)

- Modo local con perfiles: operador proyección, operador audio, líder liturgia.
- Sin servidor inicialmente: perfiles locales y bloqueo de secciones por PIN.

### I. Escenas / plantillas de culto

- Guardar escenas compuestas: tema + tipografía + fondo + contenido + temporizador.
- Lanzamiento con un clic desde Orden del Culto.

### J. Biblioteca compartible

- Exportación/importación "paquete de culto" (orden + canciones + anuncios + configuración).
- Firma/versionado de paquete para detectar incompatibilidades.

### K. Teleprompter para predicador

- Vista adicional con texto desplazable y control de velocidad desde remoto.
- Modo espejo/flip para monitores de escenario.

### L. Métricas operativas locales

- Historial de uso: himnos/canciones más usados, duración por bloque, tiempos reales.
- Tablero de mejora para equipos de producción.

---

## 4) Roadmap sugerido (90 días)

### Fase 1 (Semanas 1–3)
- Introducir estructura modular base y utilidades compartidas.
- Implementar `storageService` versionado.
- Añadir validaciones en import/export.

### Fase 2 (Semanas 4–7)
- Migrar anuncios/imágenes a IndexedDB.
- Integrar caché bíblica y manejo de reintentos.
- Agregar centro de control operativo.

### Fase 3 (Semanas 8–12)
- Incorporar escenas/plantillas.
- Lanzar paquete de culto (backup integral).
- Iniciar teleprompter (MVP).

---

## 5) KPIs recomendados

- Tiempo medio de preparación pre-culto.
- Fallos de proyección por servicio.
- Tasa de éxito de import/export.
- Uso de remoto (% cultos con remoto activo).
- Tiempo de recuperación ante error (MTTR operativo).

---

## 6) Próximos pasos concretos

1. Definir una versión objetivo (`v1.1`) enfocada en estabilidad.
2. Ejecutar modularización mínima sin romper UX actual.
3. Implementar backup/restauración integral con validación.
4. Agregar pruebas smoke automatizadas para flujos críticos:
   - proyectar texto
   - navegar orden
   - activar/desactivar pantalla negra
   - importar/exportar canciones/anuncios
