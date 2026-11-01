import { render } from "preact";
import { App } from "./App.js";
import { ConfirmProvider, Toaster } from "./components/feedback.js";

const root = document.getElementById("root");
if (root) {
  render(
    <ConfirmProvider>
      <App />
      <Toaster />
    </ConfirmProvider>,
    root,
  );
}
