import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: "index.html",
        ranking: "ranking.html",
      },
    },
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
