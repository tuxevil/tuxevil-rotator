import { render } from "preact";
import "./styles/app.css";
import { App } from "./app.js";
import { redirectLegacyRoutes } from "./state/router.js";
import { checkSession, migrateStoredToken } from "./state/store.js";

redirectLegacyRoutes();

const root = document.getElementById("app");
if (root) render(<App />, root);

void (async () => {
  // Old dashboards kept the admin token in localStorage; trade it for a cookie.
  if (await migrateStoredToken()) return;
  await checkSession();
})();
