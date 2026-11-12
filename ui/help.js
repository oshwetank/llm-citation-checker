/* help.js — the help page (1.0.0): questions people ask, short answers, and
 * for people coming from 0.36 where each thing went. The text lives in
 * src/lib/onboarding.js (HELP, WHATS_CHANGED, CHECKLIST_STEPS) and is
 * translated like the rest of the interface. */
import { loadLang, chosenLang, tr, translatePage } from "./i18n.js";
import { HELP, WHATS_CHANGED, CHECKLIST_STEPS } from "../src/lib/onboarding.js";

const h = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "className") n.className = v;
    else n.setAttribute(k, typeof v === "string" && (k === "aria-label" || k === "title") ? tr(v) : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== "") n.append(c.nodeType ? c : document.createTextNode(tr(String(c))));
  return n;
};

export function changedList() {
  return h("dl", { className: "hp-changed" }, ...WHATS_CHANGED.flatMap((x) => [h("dt", {}, x.was), h("dd", {}, x.now)]));
}

async function main() {
  await loadLang(chosenLang());
  translatePage();
  document.title = tr("CitoSkeleton help");
  const root = document.getElementById("help");
  const open = h("a", { className: "wl-btn primary", href: "panel.html?mode=tab" }, "Open CitoSkeleton");
  root.replaceChildren(
    h("header", { className: "hp-head" }, h("h1", {}, "CitoSkeleton help"), h("p", { className: "hp-sub" }, "See which brands AI engines name and which sites they trust, from the answers you already get."), open),
    h("section", { className: "hp-card" }, h("h2", {}, "Get started"), h("ol", { className: "hp-steps" }, ...CHECKLIST_STEPS.map((s) => h("li", {}, h("b", {}, s.label), " ", h("span", {}, s.hint))))),
    h("section", { className: "hp-card" }, h("h2", {}, "Questions"),
      ...HELP.map((x, i) => h("details", { className: "hp-q", ...(i === 0 ? { open: "" } : {}) }, h("summary", {}, x.q), x.a ? h("p", {}, x.a) : changedList()))),
    h("p", { className: "hp-foot" }, "Something else? Press 💬 in Analyze, or About → Diagnostics.")
  );
}
main();
