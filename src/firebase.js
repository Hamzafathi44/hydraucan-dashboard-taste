import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

// Upgrade (copy, 2026-11-26 — Gemini 4 Hydrogen plan, Security phase):
// required Firebase keys are validated at startup so a misconfigured
// build fails with a clear message instead of cryptic auth errors.
// NOTE: Firebase App Check is deliberately NOT added here — no App
// Check provider key is configured, and initializeAppCheck without one
// would break the app. It stays a manual follow-up (see report).

const REQUIRED_ENV_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];

const missingKeys = REQUIRED_ENV_KEYS.filter((k) => !import.meta.env[k]);
if (missingKeys.length > 0) {
  throw new Error(
    `Configuration Firebase incomplète — variables manquantes : ${missingKeys.join(", ")}. Vérifiez les variables d'environnement Vercel.`
  );
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
// Single Storage instance (2026-11-26): views import this instead of
// calling getStorage() themselves.
export const storage = getStorage(app);
