import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/migrate-cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // The protocol package ships TypeScript source, so bundle it in.
  noExternal: ["@courier/protocol"],
});
