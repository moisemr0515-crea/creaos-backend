# Sub-fase 0.a — Contención y backup — Reporte de ejecución

**Fecha de ejecución:** 2026-08-14
**Modo:** solo lectura sobre producción. Ningún dato de MongoDB fue modificado. Ningún código de producción fue tocado (ver §4 sobre por qué el campo `tenantId` no se agregó en esta sub-fase).
**Referencia:** [`docs/implementation/implementation-blueprint.md`](implementation-blueprint.md), §9 "Sub-fase 0.a — Contención y backup (sin código de producto)", §5 (paso 4), §5.1, §5.2, §7.

---

## 1. Backup

Script: [`scripts/backup-whatsapp-data.js`](../../scripts/backup-whatsapp-data.js) (solo lectura — `find({}).lean()` por colección, sin escrituras).

Ejecutado contra producción (`railway run node scripts/backup-whatsapp-data.js`) el 2026-08-14 22:23 (hora local).

**Ubicación:** `backups/2026-08-15T03-23-41-358Z/` (carpeta local, excluida de git vía `.gitignore` — contiene datos personales de leads, nunca se commitea).

| Colección | Documentos respaldados |
|---|---|
| `businesses` | 3 |
| `leads` | 24 |
| `conversations` | 6 |
| `webhookconfigs` | 2 |
| `whatsappconnections` | 0 |

Cada colección quedó en su propio `.json` dentro de esa carpeta, más un `manifest.json` con el detalle (conteo, nombre de archivo, timestamp, nombre de la base).

**Restauración** (si algo sale mal en una sub-fase posterior):

```bash
node scripts/restore-whatsapp-backup.js backups/2026-08-15T03-23-41-358Z
# o, contra producción:
railway run node scripts/restore-whatsapp-backup.js backups/2026-08-15T03-23-41-358Z
```

El script de restauración ([`scripts/restore-whatsapp-backup.js`](../../scripts/restore-whatsapp-backup.js)) hace `replaceOne({_id}, doc, {upsert:true})` documento por documento — no borra nada que no esté en el backup, y no toca documentos creados después del backup salvo que compartan `_id` con uno respaldado (no debería ocurrir en operación normal).

⚠️ **Nota de seguridad sobre el backup #2 (webhookconfigs):** el documento `platform:'meta'` incluye un `accessToken` de Meta en texto plano (así vive hoy en `WebhookConfig.accessToken`, sin cifrar — esto no es nuevo, es el estado actual del schema). Al inspeccionar ese archivo durante esta sub-fase, **el token completo terminó impreso en la salida de un comando de esta sesión de chat**, violando la disciplina de redacción de secretos que veníamos siguiendo. Recomendación: rotar ese Page Access Token de Meta desde el panel de la Meta App cuando sea conveniente, ya que quedó expuesto en el transcript de esta conversación (expira igual el 2026-09-11, pero rotarlo antes es más seguro si este chat se llega a compartir o guardar). No afecta a Gupshup ni a este Blueprint — es un token de la integración de Meta Lead Ads, ya identificado en el inventario original como fuera de alcance de Fases 0-3.

---

## 2. Auditoría de `WebhookConfig` (Gupshup)

Verificado de nuevo con query real contra producción (2026-08-14):

- **1 solo `WebhookConfig` con `platform:'gupshup'`** existe en toda la base — confirma el hallazgo original del Caso 8, no cambió.
  - `_id: 6a51c554df3c4c967ab5a1f4`
  - `business: 6a3a028d8f0b137e53a05b82` (**CREA OS**)
  - `isActive: true`
  - `totalLeadsReceived: 0` (campo no incrementado — vestigial, el conteo real se ve indirectamente vía `Lead.source:'whatsapp'`, abajo)
- **Documentos dependientes de ese `businessId`** (los que se verían afectados por la migración de Fase 1):
  - `Lead` con `source:'whatsapp'` bajo CREA OS: **6**
  - `Conversation` con `channel:'whatsapp'` bajo CREA OS: **6**
- **Otros negocios sin `WebhookConfig` gupshup** (confirma que nunca recibieron tráfico real vía Gupshup, tal como documentaba el Blueprint §5 paso 3):
  - `Myrel Company` (`6a52de897e51be411da70623`) — sin `WebhookConfig` gupshup
  - `Billions` (`6a7910c5d5cf388d12be6c5a`) — sin `WebhookConfig` gupshup

**Conclusión:** sin cambios respecto al diagnóstico previo. El hardcode (`BUSINESS_ID = '6a3a028d...'` en `scripts/seed-gupshup-webhook.js` y `scripts/update-gupshup-pageid.js`) sigue siendo el único punto de resolución de negocio para Gupshup, y sigue afectando únicamente a CREA OS (6 leads + 6 conversaciones) — ningún dato de `Myrel Company`/`Billions` está en riesgo porque nunca hubo tráfico real hacia esos negocios vía WhatsApp.

---

## 3. Reporte de normalización de teléfonos (solo detección)

Script: [`scripts/report-phone-duplicates.js`](../../scripts/report-phone-duplicates.js) (solo lectura, no normaliza ni fusiona nada).

Ejecutado contra producción el 2026-08-14. Salida completa: `backups/2026-08-15T03-23-49-731Z/phone-duplicates-report.json`.

**Total de leads analizados:** 24 (todos los negocios).

### 3.1 Distribución de formatos de `Lead.phone`

| Formato | Cantidad |
|---|---|
| Solo dígitos, sin `+` (ej. `51922800127`) | 10 |
| E.164 (`+51922800127`) | 9 |
| Con espacios (ej. `+51 922 800 127`) | 5 |

Confirma lo ya reportado manualmente en el Caso 8: **al menos 3 formatos distintos conviven hoy** para el mismo tipo de dato, sin normalización al guardar.

### 3.2 Duplicados por núcleo numérico (mismo número real, mismo negocio)

**3 grupos de duplicados, los 3 dentro de `Myrel Company`, 15 leads en total** — confirma exactamente el hallazgo previo (3 números de teléfono, 5 leads cada uno):

| Núcleo | Variantes de formato encontradas | Leads (nombres) | Conversaciones asociadas |
|---|---|---|---|
| `922800127` | `+51922800127` (×4), `+51 922 800 127` (×1) | Emprendedores, Crea, Crea, Crea, Crea | 0, 0, 0, 0, 0 |
| `923523382` | `+51923523382` (×3), `+51 923 523 382` (×2) | Te quiero Moringa, Te quiero (×3) | 0, 0, 0, 0, 0 |
| `949394656` | `+51949394656` (×2), `+51 949 394 656` (×2), `949394656` (×1) | Myrel Company, Myrel (×3) | 0, 0, 0, 0, 0 |

**Ningún duplicado fuera de `Myrel Company`** — ni en CREA OS ni en Billions. Confirma §5.2 del Blueprint: los 15 duplicados son 100% intra-tenant (mismo `business` en los 5 leads de cada grupo), nunca una fuga entre negocios, y ninguno tiene conversaciones activas asociadas — consistente con que son datos de prueba/importación duplicada, no conversaciones reales en curso. Tratamiento: **sin cambios respecto al Blueprint** — revisión manual humana, sin fusión automática, baja urgencia (§5.2, §7 paso 6).

---

## 4. Campo `tenantId` — NO agregado en esta sub-fase (hallazgo del corte 0.a vs. §5.1)

El mensaje que originó esta sub-fase pedía agregar `tenantId` como campo opcional+indexado a `Conversation` como parte de 0.a. Al confirmar contra el propio Blueprint (tal como se pidió explícitamente), encontré una inconsistencia y la resolví a favor del documento aprobado, no del pedido literal:

- **§9, Sub-fase 0.a** dice explícitamente: *"scripts de solo lectura para el reporte de duplicados de teléfono (§7.1) y el backup de las 3 colecciones (§5.4). **Ningún modelo ni endpoint nuevo.**"*
- **§11 (Criterios de aceptación), ítem 1 (Fase 0)** tampoco menciona `tenantId` — solo reporte de duplicados, backup, y el `WhatsAppChannel` de `901781253` (que en realidad pertenece a la sub-fase 1.a, no a 0.a).
- El **PR A de §5.1** ("agregar el campo, opcional todavía") no tiene sub-fase asignada explícitamente en §9 — es la pieza que falta encajar.

**Decisión tomada para esta ejecución:** no toqué `conversation.model.js` en esta sub-fase, para respetar la letra de 0.a ("sin código de producto", "ningún modelo nuevo"). El PR A de §5.1 (campo `tenantId` opcional + índice en background) queda para ejecutarse junto con la sub-fase **1.a** — que es la primera sub-fase que sí toca modelos de dominio (crea `WhatsAppChannel`, modifica `Lead` con el `pre('save')` de normalización) — o como un PR propio inmediatamente antes de 1.a, a tu criterio. Lo señalo explícitamente en vez de decidirlo por conveniencia, tal como venimos haciendo con toda ambigüedad del Blueprint.

Esto no bloquea nada de lo demás: el backup, la auditoría de `WebhookConfig` y el reporte de teléfonos ya están completos y no dependen de este campo.

---

## 5. Temporalidad del número compartido (`901781253` / `WebhookConfig` actual)

Documentado aquí, en `docs/`, tal como pedía la tarea. El **comentario en código** (task 5, parte "en el código") también queda para la sub-fase 1.a, por la misma razón que el punto 4: el Blueprint (§5, paso 5) ata ese comentario a la creación del `WhatsAppChannel` con `connectionType:'PLATFORM'`, que es donde ese metadata realmente vive — no existe todavía un lugar natural en el código para documentarlo sin anticipar la sub-fase 1.a.

**Constancia formal (válida desde ahora):**

> El `WebhookConfig` con `platform:'gupshup'` (`_id: 6a51c554df3c4c967ab5a1f4`, atado a `business: 6a3a028d8f0b137e53a05b82` / CREA OS) es una solución **temporal y de un solo negocio**. Su reemplazo estructural (`WhatsAppChannel` + `ChannelResolver`, resolución por `phoneNumberId`/`wabaId` real en vez de por negocio fijo) está en curso según el plan documentado en [`docs/implementation/implementation-blueprint.md`](implementation-blueprint.md) §4.1–§4.4 y §5 (plan de migración en 10 pasos). Este `WebhookConfig` **no se borra ni se modifica** durante la migración — se mantiene disponible en modo lectura como mecanismo de rollback (§5, paso 6 y 9) hasta que se cumpla la ventana de validación de 14 días (sub-fase 1.e) y se ejecute la limpieza dedicada (sub-fase 1.f).

---

## 6. Confirmación: no reasignación de históricos ambiguos

Ningún dato fue reasignado de un negocio a otro durante esta sub-fase. Los 15 duplicados de `Myrel Company` (§3.2) permanecen sin tocar — ni normalizados, ni fusionados, ni reasignados. Los 6 leads/conversaciones de CREA OS bajo el `WebhookConfig` actual tampoco se tocaron. Toda esta sub-fase fue estrictamente de lectura + generación de artefactos locales (backups, reportes, este documento).

---

## 7. Resumen para revisión

| Tarea pedida | Estado | Nota |
|---|---|---|
| 1. Backup de colecciones relevantes | ✅ Hecho | `backups/2026-08-15T03-23-41-358Z/` — 5 colecciones, script de restauración incluido |
| 2. Auditoría de `WebhookConfig` | ✅ Hecho | 1 config gupshup, atado a CREA OS, 6 leads + 6 conversaciones dependientes — sin cambios vs. diagnóstico previo |
| 3. Reporte de normalización de teléfonos | ✅ Hecho | 3 formatos, 15 duplicados (3 grupos × 5), 100% dentro de Myrel Company |
| 4. Campo `tenantId` opcional + índice | ⏸️ **No ejecutado en 0.a** — corresponde a 1.a por el propio texto del Blueprint (§9). Ver §4 de este reporte. | Pendiente de tu confirmación de que 1.a es el lugar correcto |
| 5. Documentar temporalidad del número compartido | ✅ Hecho (en `docs/`) — el comentario en código queda para 1.a por la misma razón que el punto 4 | |
| 6. No reasignar históricos ambiguos | ✅ Respetado | Nada se tocó |

**Hallazgo inesperado:** exposición accidental de un `accessToken` de Meta en la salida de un comando de esta sesión (ver nota de seguridad en §1) — recomendación de rotarlo, no bloquea nada de esta sub-fase.

**Artefactos de esta sub-fase (para el PR):**
- `scripts/backup-whatsapp-data.js` (nuevo)
- `scripts/restore-whatsapp-backup.js` (nuevo, complemento no pedido explícitamente pero necesario para que el backup sea útil como mecanismo de rollback real)
- `scripts/report-phone-duplicates.js` (nuevo)
- `.gitignore` (una línea: excluir `backups/`)
- `docs/implementation/fase-0a-contencion-report.md` (este archivo)

Los backups y el reporte JSON en sí (`backups/...`) **no se commitean** — quedan solo en disco local, excluidos por `.gitignore`.
