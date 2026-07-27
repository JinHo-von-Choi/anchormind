import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**", ".worktrees/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process:       "readonly",
        console:       "readonly",
        Buffer:        "readonly",
        setTimeout:    "readonly",
        setImmediate:  "readonly",
        clearTimeout:  "readonly",
        clearImmediate:"readonly",
        setInterval:   "readonly",
        clearInterval: "readonly",
        global:        "readonly",
        globalThis:    "readonly",
        performance:   "readonly",
        crypto:        "readonly",
        structuredClone:"readonly",
        URL:             "readonly",
        URLSearchParams: "readonly",
        fetch:           "readonly",
        AbortController: "readonly",
        AbortSignal:     "readonly",
      }
    },
    rules: {
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-undef": "error"
    }
  },
  {
    files: ["assets/**/*.js"],
    languageOptions: {
      globals: {
        document:              "readonly",
        window:                "readonly",
        sessionStorage:        "readonly",
        localStorage:          "readonly",
        navigator:             "readonly",
        Node:                  "readonly",
        location:              "readonly",
        history:               "readonly",
        Element:               "readonly",
        HTMLElement:            "readonly",
        customElements:        "readonly",
        Event:                 "readonly",
        CustomEvent:           "readonly",
        MutationObserver:      "readonly",
        IntersectionObserver:  "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame:  "readonly",
        getComputedStyle:      "readonly",
        DOMParser:             "readonly",
        XMLSerializer:         "readonly",
        btoa:                  "readonly",
        atob:                  "readonly",
        self:                  "readonly",
        confirm:               "readonly",
        alert:                 "readonly",
        prompt:                "readonly",
        d3:                    "readonly",
      }
    }
  },
  {
    files: ["tests/**/*.test.js"],
    languageOptions: {
      globals: {
        describe:   "readonly",
        it:         "readonly",
        test:       "readonly",
        expect:     "readonly",
        beforeAll:  "readonly",
        afterAll:   "readonly",
        beforeEach: "readonly",
        afterEach:  "readonly",
        jest:       "readonly",
        module:     "readonly",
      }
    }
  }
];
