// Test real (Jest, commiteado — a diferencia de los scripts temporales
// que se usan en el resto del repo) de src/utils/firebase.js.
//
// A propósito NO inventa una forma de firebase-admin: mockea los 2
// submódulos REALES que existen en la v14.3.0 instalada
// (firebase-admin/app y firebase-admin/messaging, confirmados por
// inspección directa del paquete — ver package.json) y verifica que
// firebase.js llame exactamente a las funciones reales que esos
// submódulos exportan (initializeApp/getApps/getApp/cert desde
// 'firebase-admin/app', getMessaging desde 'firebase-admin/messaging').
//
// Esto es deliberado: la versión anterior de firebase.js estaba escrita
// contra la API "namespaced" vieja (admin.apps, admin.credential.cert,
// admin.messaging()), que en v14 ya no existe — y el mock del test
// original inventaba una forma de firebase-admin que coincidía con esa
// suposición equivocada, así que nunca detectó el desface. Mockeando los
// paths reales del paquete instalado, si alguna vez cambia la firma real
// (una migración de versión, por ejemplo), jest.mock('firebase-admin/app', ...)
// sigue apuntando a un módulo que existe — pero si firebase.js empieza a
// llamar a una función que ese submódulo ya no expone, el mock de abajo
// no la tendría definida y el test fallaría con un error claro, en vez de
// pasar en falso como pasó antes.

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
  getApps: jest.fn(),
  getApp: jest.fn(),
  cert: jest.fn(),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(),
}));

const ENV_VARS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];

const setConfiguredEnv = () => {
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@test-project.iam.gserviceaccount.com';
  // Con \n literales (2 caracteres, no salto de línea real) — mismo formato
  // en el que llega desde Railway. env.js es quien los des-escapa.
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nFAKEKEY\\n-----END PRIVATE KEY-----\\n';
};

describe('utils/firebase', () => {
  // Re-requeridos DESPUÉS de cada jest.resetModules() (ver beforeEach) —
  // resetModules() invalida el registro de módulos completo, así que
  // volver a llamar require('firebase-admin/app') ahí devuelve una
  // instancia NUEVA del mock (jest.mock() vuelve a correr su factory).
  // Guardar la referencia del require() de arriba del archivo y no
  // renovarla acá haría que .mockReturnValue(...) configure una instancia
  // vieja, distinta de la que después usa require('./firebase') dentro de
  // cada test — exactamente el bug que tenía la primera versión de este
  // archivo (los 3 tests de getMessaging() fallaban con el mismo
  // TypeError que el bug real en producción, por una razón totalmente
  // distinta: la referencia del mock, no el código bajo prueba).
  let initializeApp, getApps, getApp, cert, getRealMessaging;

  beforeEach(() => {
    jest.resetModules();
    ENV_VARS.forEach((key) => delete process.env[key]);

    ({ initializeApp, getApps, getApp, cert } = require('firebase-admin/app'));
    ({ getMessaging: getRealMessaging } = require('firebase-admin/messaging'));

    initializeApp.mockReturnValue({ name: '[DEFAULT]' });
    getApps.mockReturnValue([]);
    getApp.mockReturnValue({ name: '[DEFAULT]' });
    cert.mockImplementation((opts) => ({ __cert: opts }));
    getRealMessaging.mockReturnValue({ sendEachForMulticast: jest.fn() });
  });

  afterAll(() => {
    ENV_VARS.forEach((key) => delete process.env[key]);
  });

  describe('isConfigured()', () => {
    test('false si falta FIREBASE_PRIVATE_KEY', () => {
      process.env.FIREBASE_PROJECT_ID = 'x';
      process.env.FIREBASE_CLIENT_EMAIL = 'x';
      const { isConfigured } = require('./firebase');
      expect(isConfigured()).toBe(false);
    });

    test('false si ninguna variable está seteada', () => {
      const { isConfigured } = require('./firebase');
      expect(isConfigured()).toBe(false);
    });

    test('true con las 3 variables presentes', () => {
      setConfiguredEnv();
      const { isConfigured } = require('./firebase');
      expect(isConfigured()).toBe(true);
    });
  });

  describe('getMessaging()', () => {
    test('devuelve null sin llamar a ningún submódulo real si Firebase no está configurado', () => {
      const { getMessaging } = require('./firebase');
      const result = getMessaging();

      expect(result).toBeNull();
      expect(getApps).not.toHaveBeenCalled();
      expect(initializeApp).not.toHaveBeenCalled();
      expect(cert).not.toHaveBeenCalled();
      expect(getRealMessaging).not.toHaveBeenCalled();
    });

    test('sin ninguna app existente (getApps() vacío), llama a cert() e initializeApp() desde firebase-admin/app con las credenciales de env.js', () => {
      getApps.mockReturnValue([]);
      setConfiguredEnv();
      const { getMessaging } = require('./firebase');

      getMessaging();

      expect(getApps).toHaveBeenCalledTimes(1);
      expect(cert).toHaveBeenCalledWith({
        projectId: 'test-project',
        clientEmail: 'test@test-project.iam.gserviceaccount.com',
        // env.js des-escapa los \n literales a saltos de línea reales antes
        // de que este archivo los use — se verifica ese des-escapado acá.
        privateKey: '-----BEGIN PRIVATE KEY-----\nFAKEKEY\n-----END PRIVATE KEY-----\n',
      });
      expect(initializeApp).toHaveBeenCalledTimes(1);
      expect(getApp).not.toHaveBeenCalled();
    });

    test('con una app ya existente (getApps() no vacío), reutiliza getApp() y NO vuelve a inicializar', () => {
      getApps.mockReturnValue([{ name: '[DEFAULT]' }]);
      setConfiguredEnv();
      const { getMessaging } = require('./firebase');

      getMessaging();

      expect(getApp).toHaveBeenCalledTimes(1);
      expect(initializeApp).not.toHaveBeenCalled();
      expect(cert).not.toHaveBeenCalled();
    });

    test('obtiene el cliente de Messaging real llamando a getMessaging() de firebase-admin/messaging con la app', () => {
      const fakeApp = { name: '[DEFAULT]', marca: 'app-de-prueba' };
      initializeApp.mockReturnValue(fakeApp);
      setConfiguredEnv();
      const { getMessaging } = require('./firebase');

      const resultado = getMessaging();

      expect(getRealMessaging).toHaveBeenCalledWith(fakeApp);
      expect(resultado).toBe(getRealMessaging.mock.results[0].value);
    });
  });
});
