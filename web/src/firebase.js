import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAFwNBcSTg8YEr8q-yk6ux7tiX4_CtUGFE",
  authDomain: "ada-vision.firebaseapp.com",
  projectId: "ada-vision",
  storageBucket: "ada-vision.firebasestorage.app",
  messagingSenderId: "436874633755",
  appId: "1:436874633755:web:4b8acc97cc7d9210c9cebe"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
