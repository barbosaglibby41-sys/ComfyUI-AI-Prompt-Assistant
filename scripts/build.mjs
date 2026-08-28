import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "web");

await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
    entryPoints: [resolve(root, "web", "index.js")],
    outfile: resolve(output, "index.js"),
    bundle: true,
    external: ["/scripts/*"],
    format: "esm",
    legalComments: "none",
    minify: true,
    sourcemap: true,
    target: ["chrome120", "firefox121"],
});

await Promise.all([
    cp(resolve(root, "web", "style.css"), resolve(output, "style.css")),
    cp(resolve(root, "web", "studio.css"), resolve(output, "studio.css")),
]);

const sizes = await Promise.all(["index.js", "style.css", "studio.css"].map(async (file) => {
    const info = await stat(resolve(output, file));
    if (!info.size) throw new Error(`Production asset is empty: ${file}`);
    return `${file} ${Math.ceil(info.size / 1024)} KiB`;
}));

console.log(`Production UI built in dist/web\n${sizes.join("\n")}`);
