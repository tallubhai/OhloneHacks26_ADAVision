import React from "react";
import { createRoot } from "react-dom/client";
import SignupPage from "./pages/SignupPage";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SignupPage />
  </React.StrictMode>
);
