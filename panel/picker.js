// The filter picker: every dimension's values, each with its all-time total,
// ticked on to keep only those.

import { esc, fmt } from "./format.js";

const NAMES = {
  account: "Account",
  model: "Model",
  repo: "Repository",
  folder: "Folder",
  source: "Local/remote",
  session: "Session",
};

export function openPicker(anchor, facets, filters, onChange) {
  const node = document.getElementById("picker");
  const chosen = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, new Set(v)]));
  let dim = "account";
  const render = () => {
    const query = node.querySelector("input")?.value ?? "";
    node.innerHTML = `<div style="display:flex;gap:8px;align-items:center">
        <select aria-label="Dimension">${Object.entries(NAMES)
          .map(([k, n]) => `<option value="${k}"${k === dim ? " selected" : ""}>${n}</option>`)
          .join("")}</select>
        <input type="search" placeholder="Search" value="${esc(query)}" style="flex:1" />
        <button type="button" class="btn" data-act="clear">Clear</button>
        <button type="button" class="btn" data-act="done">Done</button>
      </div><div class="list"></div>`;
    list(node.querySelector(".list"), facets[dim] ?? [], chosen, dim, query);
    node.querySelector("select").addEventListener("change", (event) => {
      dim = event.target.value;
      render();
    });
    const input = node.querySelector("input");
    input.addEventListener("input", () =>
      list(node.querySelector(".list"), facets[dim] ?? [], chosen, dim, input.value),
    );
    input.focus();
    node.querySelector("[data-act=clear]").addEventListener("click", () => {
      delete chosen[dim];
      render();
    });
    node.querySelector("[data-act=done]").addEventListener("click", close);
  };
  const close = () => {
    node.hidden = true;
    removeEventListener("mousedown", outside, true);
    onChange(
      Object.fromEntries(
        Object.entries(chosen)
          .filter(([, set]) => set.size > 0)
          .map(([k, set]) => [k, [...set]]),
      ),
    );
  };
  const outside = (event) => {
    if (!node.contains(event.target)) close();
  };
  render();
  const box = anchor.getBoundingClientRect();
  node.style.left = `${Math.min(box.left, innerWidth - node.offsetWidth - 8)}px`;
  node.style.top = `${box.bottom + 6}px`;
  node.hidden = false;
  addEventListener("mousedown", outside, true);
}

function list(host, values, chosen, dim, query) {
  const q = query.trim().toLowerCase();
  const shown = values.filter((v) => q === "" || v.label.toLowerCase().includes(q)).slice(0, 200);
  host.innerHTML = shown
    .map(
      (v, i) =>
        `<label><input type="checkbox" data-i="${i}"${chosen[dim]?.has(v.key) ? " checked" : ""} /><span>${esc(v.label)}</span><span>${fmt(v.total)}</span></label>`,
    )
    .join("");
  for (const box of host.querySelectorAll("input")) {
    box.addEventListener("change", () => {
      const value = shown[Number(box.dataset.i)].key;
      chosen[dim] ??= new Set();
      if (box.checked) chosen[dim].add(value);
      else chosen[dim].delete(value);
    });
  }
}
