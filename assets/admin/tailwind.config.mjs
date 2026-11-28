import forms from "@tailwindcss/forms";
import containerQueries from "@tailwindcss/container-queries";
import theme from "./tailwind-theme.js";

export default {
  ...theme,
  content: {
    relative: true,
    files: ["./index.html", "./admin.js", "./modules/**/*.js"],
  },
  plugins: [forms, containerQueries],
};
