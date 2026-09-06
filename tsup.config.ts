import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    web: "src/web.ts",
    horizon: "src/horizon/provider.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: "es2022",
  external: ["react", "swr"],
});
