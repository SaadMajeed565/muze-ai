/**
 * The page observer content script.
 *
 * It is injected into the page's MAIN world at document_start, which is the
 * only place where the page's own `alert`, `confirm`, `prompt`, `fetch` and
 * `XMLHttpRequest` can be wrapped before the page uses them.
 *
 * The implementation lives in the browser engine so it can be unit tested;
 * this file only starts it.
 */

import { installObserver } from "../../libs/browser-engine/page/observer.js";

installObserver();

export {};
