// firebase-admin@14 usa la API modular (igual que el SDK de cliente de
// Firebase v9+): require('firebase-admin') YA NO expone el objeto
// namespaced viejo (admin.apps, admin.credential.cert, admin.app(),
// admin.messaging()) — eso es la API v9-y-anterior, retirada. Ahora hace
// falta importar de los submódulos reales:
//   - firebase-admin/app: initializeApp, getApps, getApp, cert
//   - firebase-admin/messaging: getMessaging
// (Bug real encontrado en producción: la versión anterior de este archivo
// usaba la API namespaced vieja contra un admin object que en v14 no la
// tiene — admin.apps era undefined, así que admin.apps.length tiraba
// TypeError en cuanto algo llamaba a getMessaging() de este archivo. El
// mock del test original de PR-B inventaba una forma de firebase-admin
// que coincidía con esa suposición equivocada, no con el paquete real
// instalado, así que nunca lo detectó — ver firebase.test.js, que ahora
// mockea los submódulos reales en vez de inventar una forma.)
const { initializeApp, getApps, getApp, cert } = require('firebase-admin/app');
const { getMessaging: getFirebaseMessaging } = require('firebase-admin/messaging');
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = require('../config/env');

// Firebase Admin SDK (FCM) — mismo patrón que cloudinary.js: un solo init
// para todo el proceso, credenciales leídas de env.js (nunca del archivo
// JSON completo, que no se commitea — ver .env.example).
//
// isConfigured() existe porque, a diferencia de Cloudinary, es normal que
// Railway todavía no tenga las 3 variables FIREBASE_* seteadas (ej. recién
// mergeado este PR, credenciales pendientes) — cert() con valores vacíos
// no falla al construirse, pero cualquier llamada real a la API de FCM sí,
// con un error de SDK poco claro. Chequear acá primero deja que
// push.service.js#sendToUser() lo detecte y lo loguee con un mensaje
// legible, en vez de tumbar al llamador con una excepción de bajo nivel.
const isConfigured = () =>
  Boolean(FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY);

/**
 * Devuelve el cliente de Messaging ya inicializado, o null si Firebase no
 * está configurado. getApps().length se chequea a propósito — llamar
 * initializeApp() dos veces con el mismo nombre de app (el default) lanza,
 * y este módulo puede volver a requerirse en el mismo proceso (tests, hot
 * reload).
 */
const getMessaging = () => {
  if (!isConfigured()) return null;

  const app = getApps().length
    ? getApp()
    : initializeApp({
        credential: cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY,
        }),
      });

  return getFirebaseMessaging(app);
};

module.exports = { getMessaging, isConfigured };
