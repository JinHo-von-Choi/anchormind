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
      /**
       * 미사용 변수를 실패로 다룬다.
       *
       * 경고로 두면 130건까지 쌓여도 CI가 통과하고, 그 안에 섞인 실제 결함이
       * 묻힌다. 의도적으로 쓰지 않는 인자와 catch 변수는 밑줄 접두로 표시한다.
       */
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
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
