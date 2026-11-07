import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/migrate-cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them in.
  noExternal: ["@courier/protocol", "@courier/client"],
});
