// The one hover card every chart on the page shares.

import { esc, val } from "./format.js";

const tip = () => document.getElementById("tip");

/** rows: { label, value, colour }[], in the order the caller wants them shown. */
export function showTip(event, title, rows, total = true) {
  const node = tip();
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const lines = rows
    .slice(0, 14)
    .map(
      (r) =>
        `<div class="line"><span><i class="sw" style="background:${r.colour}"></i>${esc(r.label)}</span><span>${val(r.value)}</span></div>`,
    );
  if (rows.length > 14)
    lines.push(`<div class="line"><span>${rows.length - 14} more</span><span></span></div>`);
  const foot =
    total && rows.length > 1
      ? `<div class="line sum"><span>Total</span><span>${val(sum)}</span></div>`
      : "";
  node.innerHTML = `<b>${esc(title)}</b>${lines.join("") || '<div class="line"><span>Nothing</span><span>0</span></div>'}${foot}`;
  node.hidden = false;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  node.style.left = `${Math.min(event.clientX + 14, innerWidth - w - 8)}px`;
  node.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - h - 8))}px`;
}

export function hideTip() {
  tip().hidden = true;
}
