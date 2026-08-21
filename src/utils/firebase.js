const admin = require('firebase-admin');
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = require('../config/env');

// Firebase Admin SDK (FCM) — mismo patrón que cloudinary.js: un solo init
// para todo el proceso, credenciales leídas de env.js (nunca del archivo
// JSON completo, que no se commitea — ver .env.example).
//
// isConfigured() existe porque, a diferencia de Cloudinary, es normal que
// Railway todavía no tenga las 3 variables FIREBASE_* seteadas (ej. recién
// mergeado este PR, credenciales pendientes) — admin.credential.cert() con
// valores vacíos no falla al construirse, pero cualquier llamada real a la
// API de FCM sí, con un error de SDK poco claro. Chequear acá primero deja
// que push.service.js#sendToUser() lo detecte y lo loguee con un mensaje
// legible, en vez de tumbar al llamador con una excepción de bajo nivel.
const isConfigured = () =>
  Boolean(FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY);

/**
 * Devuelve el cliente admin.messaging() ya inicializado, o null si Firebase
 * no está configurado. admin.apps.length se chequea a propósito — llamar
 * initializeApp() dos veces con el mismo nombre de app (el default) lanza,
 * y este módulo puede volver a requerirse en el mismo proceso (tests, hot
 * reload).
 */
const getMessaging = () => {
  if (!isConfigured()) return null;

  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY,
        }),
      });

  return admin.messaging(app);
};

module.exports = { getMessaging, isConfigured };
