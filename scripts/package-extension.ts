/** Build and package the distributable Chrome extension, including upstream licenses. */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const extensionVersion = JSON.parse(readFileSync(join(root, "extension/package.json"), "utf8")).version;
if (version !== extensionVersion) throw new Error("Root and extension versions must match before packaging");
await $`bun run build`.cwd(join(root, "extension"));
const built = join(root, "extension/.output/chrome-mv3");
const manifest = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8"));
if (manifest.name !== "jev-browser-use" || manifest.version !== version) throw new Error("Unexpected extension manifest identity");
const stage = join(root, "build/extension-package");
rmSync(stage, { recursive: true, force: true });
cpSync(built, stage, { recursive: true });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, file), join(stage, file));
mkdirSync(join(root, "dist"), { recursive: true });
const archive = join(root, "dist", `jev-browser-use-extension-${version}.zip`);
rmSync(archive, { force: true });
await $`zip -q -r ${archive} .`.cwd(stage);
console.log(archive);
