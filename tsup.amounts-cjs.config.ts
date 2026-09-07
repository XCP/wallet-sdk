import { defineConfig } from "tsup";

// Keep the standalone pure contract available to existing CommonJS backends.
// Run after the primary build so its clean step cannot delete this artifact.
export default defineConfig({
  entry: { amounts: "src/amounts.ts" },
  format: ["cjs"],
  dts: true,
  sourcemap: true,
  clean: false,
  splitting: false,
  target: "es2022",
});
