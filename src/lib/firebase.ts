import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// TEST CONNECTION
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firestore connection verified");
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration: Client is offline");
    } else {
      console.warn("Firestore connection check (expected if new DB):", error);
    }
  }
}
testConnection();

export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error: any) {
    if (error.code === 'auth/popup-blocked') {
      alert("Popup blocked! Please allow popups for this site to login.");
    } else if (error.code === 'auth/unauthorized-domain') {
      alert("This domain is not authorized for Firebase login. Please add the current URL to authorized domains in Firebase Console.");
    } else {
      console.error("Login failed:", error);
      alert(`Login failed: ${error.message}`);
    }
    throw error;
  }
}

