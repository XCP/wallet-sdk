import { defineConfig } from "vitest/config";

/**
 * Pure layers only, no DOM. What is worth testing here is the code where
 * being wrong is silent: a quantity serializer that puts the wrong digits
 * into a transaction, a journal that forgets a spend, a quote that disagrees
 * with consensus at an integer boundary. The React bindings are exercised by
 * the sites that consume them.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
