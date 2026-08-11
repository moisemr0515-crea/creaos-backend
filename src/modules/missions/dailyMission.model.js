const mongoose = require('mongoose');

// Una misión individual dentro del set de 3 del día. `lead` es opcional —
// solo se setea cuando la misión apunta a un lead específico (ej. "sigue con
// Juan Pérez, lleva 5 días sin respuesta"); las misiones genéricas de
// onboarding/fallback no referencian ningún lead.
const missionItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
  },
  { _id: false }
);

const dailyMissionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // Día calendario en formato 'YYYY-MM-DD' (zona horaria del negocio, ver
    // mission.service#obtenerFechaDeHoy) — deliberadamente NO es un timestamp
    // completo, para poder indexar/comparar "el mismo día" sin líos de horas.
    date: { type: String, required: true },
    missions: {
      type: [missionItemSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length === 3,
        message: 'Debe haber exactamente 3 misiones',
      },
    },
    generatedAt: { type: Date, default: Date.now },
    // Distingue misiones generadas por GPT-4o de las genéricas de fallback
    // (negocio sin leads todavía, o error al llamar a OpenAI).
    source: { type: String, enum: ['ai', 'fallback'], default: 'ai' },
  },
  { timestamps: true }
);

// Un solo DailyMission por negocio y día — evita duplicados y permite el
// lookup de cache en obtenerMisionDeHoy con un findOne directo. regenerar()
// hace upsert sobre este mismo índice en vez de insertar un doc nuevo.
dailyMissionSchema.index({ business: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyMission', dailyMissionSchema);
