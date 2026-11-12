/** Storage keys and the boot script, kept apart from theme.ts so the server layout can import them. */
export const KEYS = { mode: "goldlab-mode", accent: "goldlab-accent", lang: "goldlab-lang", local: "goldlab-local" };

// Languages written right to left; kept here so the boot script can set dir before paint.
const RTL = ["ar", "ur", "fa", "he"];

/** Runs in <head> before the page paints, so the saved theme shows without a flash. */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=localStorage.getItem("${KEYS.mode}")||"dark",a=localStorage.getItem("${KEYS.accent}")||"gold";
if(m==="auto")m=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";d.dataset.theme=m;d.dataset.accent=a;
var l=localStorage.getItem("${KEYS.lang}");if(l){d.lang=l;d.dir=${JSON.stringify(RTL)}.indexOf(l)>=0?"rtl":"ltr";}}catch(e){}})();`;

