/**
 * no-silent-catch 규칙 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import { RuleTester }   from "eslint";
import noSilentCatch    from "../../scripts/eslint-rules/no-silent-catch.js";

RuleTester.describe = describe;
RuleTester.it       = it;
RuleTester.itOnly   = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });

tester.run("no-silent-catch", noSilentCatch, {
  valid: [
    "try { f(); } catch (err) { log(err); }",
    "try { f(); } catch (err) { throw err; }",
    "p.catch(err => log(err));",
    "p.catch(err => { metrics.inc(); return null; });",
    "p.catch(handleError);",
    "obj.catch();"
  ],
  invalid: [
    { code: "try { f(); } catch {}",                   errors: [{ messageId: "clause" }] },
    { code: "try { f(); } catch (_e) { /* 무시 */ }",    errors: [{ messageId: "clause" }] },
    { code: "p.catch(() => {});",                      errors: [{ messageId: "promise" }] },
    { code: "p.catch(() => []);",                      errors: [{ messageId: "promise" }] },
    { code: "p.catch(() => null);",                    errors: [{ messageId: "promise" }] },
    { code: "p.catch(() => ({}));",                    errors: [{ messageId: "promise" }] },
    { code: "p.catch(function () { return false; });", errors: [{ messageId: "promise" }] },
    { code: "p.catch(() => undefined);",               errors: [{ messageId: "promise" }] }
  ]
});
