// The window's views — Usage, Forecast, Code — and which one shows. The page
// keeps the choice in `body[data-view]`, which the stylesheets key off: Usage's
// own controls and boxes carry `usage-only`, the range and bucket `timed`
// (Usage and Code), and Forecast and Code each have a box of their own.

export const VIEWS = [
  ["usage", "Usage"],
  ["forecast", "Forecast"],
  ["code", "Code"],
];

/** A saved view's name, or Usage where the saved one is unknown. */
export const viewOf = (name) => (VIEWS.some(([key]) => key === name) ? name : "usage");

/** Show `view`: its box, its style, and its own `loads[view]()` to fill it. */
export function showView(view, loads) {
  document.body.dataset.view = view;
  for (const [key] of VIEWS) {
    const box = document.getElementById(key);
    if (box !== null) box.hidden = key !== view;
  }
  loads[view]();
}
