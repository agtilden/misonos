import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { DialogProvider } from "./dialogs.js";
import { FavoritesProvider } from "./favorites.js";
import { LocalPlayerProvider } from "./localPlayer.js";
import { importServersFromUrl } from "./servers.js";
import "./styles.css";

// Merge any saved-locations list passed in via the propagate param (and strip it from
// the URL) before the app reads the list, so a freshly-switched-to host shows it.
importServersFromUrl();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DialogProvider>
      <FavoritesProvider>
        <LocalPlayerProvider>
          <App />
        </LocalPlayerProvider>
      </FavoritesProvider>
    </DialogProvider>
  </React.StrictMode>
);
