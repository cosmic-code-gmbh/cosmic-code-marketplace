// Space pictures for the space headers: a dropped image or .app, or one chosen in the
// file picker that spaces-icons' "Icon & color…" popup asks for. A copy of the same
// functions in spaces-icons/main.js: a mod can't import from another mod's folder.
import { exec, appHome, shared, setShared, readTextFile } from "herdr";

// Space icons: copied under appHome() so image() finds them, as a 128px PNG
// (an SVG stays as it is). A new name per pick, so a changed icon shows at once.
const ICON_DIR = "space-icons";

// An .app's own icon file (Info.plist's CFBundleIconFile), null if it has none.
async function appIcon(app) {
  const r = await exec("defaults", ["read", `${app}/Contents/Info`, "CFBundleIconFile"]);
  const name = r.stdout.trim();
  if (r.code !== 0 || !name) return null;
  return `${app}/Contents/Resources/${name.endsWith(".icns") ? name : `${name}.icns`}`;
}

export async function setIcon(id, file) {
  let src = file.replace(/\/+$/, "");
  if (src.endsWith(".app")) src = await appIcon(src);
  if (!src) throw new Error("This app has no icon file.");
  const svgFile = /\.svg$/i.test(src);
  const rel = `${ICON_DIR}/${id}-${Date.now()}.${svgFile ? "svg" : "png"}`;
  const dest = `${appHome()}/${rel}`;
  await exec("mkdir", ["-p", `${appHome()}/${ICON_DIR}`]);
  const r = svgFile ? await exec("cp", [src, dest]) : await exec("sips", ["-s", "format", "png", "-Z", "128", src, "--out", dest]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't read that image.");
  clearIcon(id);
  setShared("space.icons", { ...(shared("space.icons") ?? {}), [id]: rel });
}

export function clearIcon(id) {
  const icons = { ...(shared("space.icons") ?? {}) };
  if (!icons[id]) return;
  exec("rm", ["-f", `${appHome()}/${icons[id]}`]);
  delete icons[id];
  setShared("space.icons", icons);
}

// The macOS file picker; resolves with the file, or null when cancelled.
// exec stops a program after 30 s, which closed the picker mid-choice: osascript
// runs detached instead and leaves its answer in a file, which is waited for
// in rounds that each fit in exec's limit.
export async function pickIcon(id, name) {
  const prompt = `Icon for ${name}`.replace(/["\\]/g, "");
  const script = `POSIX path of (choose file with prompt "${prompt}" of type {"public.image", "com.apple.application-bundle"})`;
  const answer = `${appHome()}/${ICON_DIR}/.pick-${id}-${Date.now()}`;
  await exec("mkdir", ["-p", `${appHome()}/${ICON_DIR}`]);
  // The answer: osascript's exit code, its output, then its errors, one per line.
  await exec("sh", ["-c", '( r=$(osascript -e "$1" 2>"$2.err"); c=$?; printf "%s\\n%s\\n%s" "$c" "$r" "$(cat "$2.err")" > "$2.tmp"; rm -f "$2.err"; mv "$2.tmp" "$2" ) </dev/null >/dev/null 2>&1 &', "sh", script, answer]);
  for (;;) {
    const r = await exec("sh", ["-c", 'for i in $(seq 1 50); do [ -e "$1" ] && exit 0; sleep 0.5; done; exit 1', "sh", answer]);
    if (r.code === 0) break;
  }
  const [code, file, ...err] = ((await readTextFile(answer)) ?? "").split("\n");
  await exec("rm", ["-f", answer]);
  // -128: the person cancelled.
  if (code !== "0" && !/-128/.test(err.join(" "))) throw new Error(err.join(" ").trim() || `The file picker failed (${code}).`);
  return code === "0" ? file.trim() || null : null;
}
