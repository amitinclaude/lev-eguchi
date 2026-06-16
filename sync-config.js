/* ============================================================
   Cross-phone sync config.
   Until `apiKey` below is filled in, the app runs LOCAL-ONLY —
   all data stays on each device and nothing is uploaded.

   To turn on sync (so Amit's and Jonathan's phones share one
   session count and progress), paste the Firebase web config
   from the Firebase console into `firebase` below.
   ============================================================ */
window.SYNC_CONFIG = {
  firebase: {
    apiKey: "AIzaSyDCB94vDbotF3e3bzlEXjqNjebxtygccrw",
    authDomain: "lev-eguchi.firebaseapp.com",
    projectId: "lev-eguchi",
    storageBucket: "lev-eguchi.firebasestorage.app",
    messagingSenderId: "562665614153",
    appId: "1:562665614153:web:2e472b4f4e3ff0266dc898"
  },
  // Shared, hard-to-guess id for this family's data. Keep it as-is
  // on both phones (both load this same deployed file, so they match).
  familyId: "lev-7q4m2x9k"
};
