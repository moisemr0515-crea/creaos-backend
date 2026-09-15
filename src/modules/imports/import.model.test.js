const Import = require('./import.model');

describe('import.model — contrato del campo errors', () => {
  test('conserva el nombre persistido y suprime únicamente el warning de Mongoose', () => {
    expect(Import.schema.path('errors')).toBeDefined();
    expect(Import.schema.options.suppressReservedKeysWarning).toBe(true);
  });
});
