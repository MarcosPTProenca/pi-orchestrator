import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "quality/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: "error",
    },
  },
  {
    // node:test registra os casos com test(), que devolve promise que o runner aguarda sozinho.
    files: ["test/**/*.ts", "evals/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
);
