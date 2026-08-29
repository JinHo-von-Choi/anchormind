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
       * 조건 블록마다 자리표시자 번호를 올리는 패턴을 허용한다.
       *
       * SQL 조건을 순서대로 붙이는 코드는 마지막 블록에서도 번호를 올려 둔다.
       * 그 값은 그 시점에 읽히지 않지만, 다음 조건이 추가될 때 올리는 것을
       * 잊으면 바인딩이 한 칸씩 밀려 조용히 틀린 질의가 된다. 마지막 하나만
       * 지우는 규칙은 그 함정을 만든다.
       */
      "no-useless-assignment": "off",
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
