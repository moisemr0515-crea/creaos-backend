// Test puro (Jest, sin Mongo real) de timeTriggers.registry.js — Caso 7 del
// backlog, PR 2/3. Cubre extractDaysThreshold() y buildLeadCandidateFilter()
// (+ su wrapper sobre un Automation) de forma aislada: dado un trigger.type
// y trigger.conditions, ¿el filtro de Mongo generado es exactamente el
// esperado? Sin conexión a base de datos — este módulo es 100% síncrono.
const {
  TIME_TRIGGER_TYPES,
  DAYS_THRESHOLD_FIELD,
  extractDaysThreshold,
  buildLeadCandidateFilter,
  buildLeadCandidateFilterForAutomation,
} = require('./timeTriggers.registry');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('timeTriggers.registry — TIME_TRIGGER_TYPES', () => {
  test('expone exactamente los 2 triggers que necesita el Caso 5, ni uno más', () => {
    expect(TIME_TRIGGER_TYPES.sort()).toEqual(['lead_stale', 'stage_stalled'].sort());
  });
});

describe('timeTriggers.registry — extractDaysThreshold()', () => {
  test('extrae el umbral de una condición daysThreshold/greater_than válida', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 3 }];
    expect(extractDaysThreshold(conditions)).toBe(3);
  });

  test('ignora otras condiciones en el array y encuentra la que corresponde', () => {
    const conditions = [
      { field: 'pipelineStage', operator: 'not_equals', value: 'won' },
      { field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 5 },
    ];
    expect(extractDaysThreshold(conditions)).toBe(5);
  });

  test('umbral 0 es válido ("hace más de 0 días" = en cualquier momento antes de ahora)', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 0 }];
    expect(extractDaysThreshold(conditions)).toBe(0);
  });

  test('lanza un error claro si falta la condición daysThreshold', () => {
    expect(() => extractDaysThreshold([])).toThrow(/falta la condición/);
    expect(() => extractDaysThreshold(undefined)).toThrow(/falta la condición/);
  });

  test('lanza un error claro si el operador no es greater_than', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'less_than', value: 3 }];
    expect(() => extractDaysThreshold(conditions)).toThrow(/solo soporta el operador "greater_than"/);
  });

  test('lanza el mismo error claro si la condición no trae operador (no es undefined silencioso)', () => {
    // 'greater_than' es el único valor que el parser reconoce hoy —
    // no hay ningún otro operador ya contemplado en el código. Esta
    // comparación (condicion.operator !== 'greater_than') es estricta,
    // así que un operador ausente cae en el mismo camino de error que
    // uno explícitamente incorrecto — lo confirmamos con un test aparte
    // en vez de asumirlo, porque el shape es distinto (falta la key, no
    // solo tiene un valor distinto).
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, value: 3 }];
    expect(() => extractDaysThreshold(conditions)).toThrow(/solo soporta el operador "greater_than"/);
  });

  test('lanza un error claro si el valor no es un número finito', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 'muchos' }];
    expect(() => extractDaysThreshold(conditions)).toThrow(/número finito/);
  });

  test('lanza un error claro si el valor es negativo', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: -1 }];
    expect(() => extractDaysThreshold(conditions)).toThrow(/no puede ser negativo/);
  });
});

describe('timeTriggers.registry — buildLeadCandidateFilter()', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  test('lead_stale: arma el $or sobre lastContactedAt/createdAt con el cutoff correcto', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 3 }];
    const filtro = buildLeadCandidateFilter('lead_stale', conditions, now);

    const cutoffEsperado = new Date(now.getTime() - 3 * DAY_MS);
    expect(filtro).toEqual({
      $or: [
        { lastContactedAt: { $lt: cutoffEsperado } },
        { lastContactedAt: null, createdAt: { $lt: cutoffEsperado } },
      ],
    });
  });

  test('stage_stalled: mismo patrón, sobre stageChangedAt/createdAt', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 7 }];
    const filtro = buildLeadCandidateFilter('stage_stalled', conditions, now);

    const cutoffEsperado = new Date(now.getTime() - 7 * DAY_MS);
    expect(filtro).toEqual({
      $or: [
        { stageChangedAt: { $lt: cutoffEsperado } },
        { stageChangedAt: null, createdAt: { $lt: cutoffEsperado } },
      ],
    });
  });

  test('umbral 0: el cutoff es exactamente "now"', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 0 }];
    const filtro = buildLeadCandidateFilter('lead_stale', conditions, now);

    expect(filtro.$or[0].lastContactedAt.$lt).toEqual(now);
    expect(filtro.$or[1].createdAt.$lt).toEqual(now);
  });

  test('lanza un error claro para un triggerType que el registro no reconoce', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 3 }];
    expect(() => buildLeadCandidateFilter('lead_created', conditions, now)).toThrow(
      /tipo de trigger desconocido "lead_created"/
    );
    expect(() => buildLeadCandidateFilter('algo_inventado', conditions, now)).toThrow(
      /lead_stale, stage_stalled/
    );
  });

  test('propaga el error de extractDaysThreshold si el umbral es inválido (ej. negativo)', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: -5 }];
    expect(() => buildLeadCandidateFilter('lead_stale', conditions, now)).toThrow(/no puede ser negativo/);
  });

  test('sin `now` explícito, usa la hora actual sin explotar', () => {
    const conditions = [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 1 }];
    const antes = Date.now();
    const filtro = buildLeadCandidateFilter('lead_stale', conditions);
    const despues = Date.now();

    const cutoffMs = filtro.$or[0].lastContactedAt.$lt.getTime();
    // cutoff debería caer en algún punto entre (antes - 1 día) y (después - 1 día)
    expect(cutoffMs).toBeGreaterThanOrEqual(antes - 1 * DAY_MS - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(despues - 1 * DAY_MS + 1000);
  });
});

describe('timeTriggers.registry — buildLeadCandidateFilterForAutomation()', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  test('produce el mismo filtro que buildLeadCandidateFilter(), desarmando trigger.type/conditions de la Automation', () => {
    const automation = {
      trigger: {
        type: 'lead_stale',
        conditions: [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 3 }],
      },
    };

    const directo = buildLeadCandidateFilter('lead_stale', automation.trigger.conditions, now);
    const viaWrapper = buildLeadCandidateFilterForAutomation(automation, now);

    expect(viaWrapper).toEqual(directo);
  });

  test('propaga el error de tipo desconocido si la Automation no trae un trigger.type de tiempo', () => {
    const automation = { trigger: { type: 'lead_created', conditions: [] } };
    expect(() => buildLeadCandidateFilterForAutomation(automation, now)).toThrow(/tipo de trigger desconocido/);
  });

  test('propaga un error claro (no revienta con TypeError) si la Automation viene sin trigger', () => {
    expect(() => buildLeadCandidateFilterForAutomation({}, now)).toThrow(/tipo de trigger desconocido/);
  });
});
