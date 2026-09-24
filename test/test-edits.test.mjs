import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppend, isBlockInsertion, affectsOtherTests } from '../plugins/cc-harness/lib/test-edits.mjs';

const JS = 'import { test } from "node:test";\n\ntest("a", () => {\n  assert.ok(1);\n});\n\n// --- later ---\n\ntest("z", () => {});\n';
const GO = 'package x\n\nimport "testing"\n\nfunc TestA(t *testing.T) {\n\tif 1 != 1 {\n\t\tt.Fatal("x")\n\t}\n}\n\nfunc TestZ(t *testing.T) {}\n';

test('isBlockInsertion: a complete top-level test block added between blocks passes, in JS/TS and Go', () => {
  const jsEdit = { old_string: 'test("a", () => {\n  assert.ok(1);\n});', new_string: 'test("a", () => {\n  assert.ok(1);\n});\n\ntest("m", () => {\n  assert.ok("}");\n});' };
  assert.equal(isBlockInsertion('x.test.ts', JS, [jsEdit]), true);
  assert.equal(isBlockInsertion('x.test.mjs', JS, [{ old_string: '// --- later ---', new_string: 'describe("group", () => {\n  it("works", () => {});\n});\n\n// --- later ---' }]), true);   // added before the anchor
  assert.equal(isBlockInsertion('x_test.go', GO, [{ old_string: '\t}\n}', new_string: '\t}\n}\n\nfunc TestM(t *testing.T) {\n\tt.Log("}")\n}' }]), true);
});

test('isBlockInsertion: anything that is not whole blocks at a block boundary is not one', () => {
  assert.equal(isBlockInsertion('x.test.ts', JS, [{ old_string: '  assert.ok(1);', new_string: '  assert.ok(1);\n  assert.ok(2);' }]), false);          // inside a test
  assert.equal(isBlockInsertion('x.test.ts', JS, [{ old_string: '});\n\n// --- later ---', new_string: '});\n\nconst shared = 1;\n\n// --- later ---' }]), false);   // not a test block
  assert.equal(isBlockInsertion('x.test.ts', JS, [{ old_string: 'test("a", () => {\n  assert.ok(1);\n});', new_string: 'test("a", () => {\n  assert.ok(1);\n});\n\ntest("m", () => {\n  assert.ok(1);' }]), false);   // unbalanced
  assert.equal(isBlockInsertion('x.test.ts', JS, [{ old_string: 'test("a", () => {', new_string: 'test("a", () => {\n\ntest("m", () => {});' }]), false);   // after an unclosed opener: inside the block
  assert.equal(isBlockInsertion('x.test.ts', JS, [{ old_string: '"a"', new_string: '"b"' }]), false);                                              // a change
  assert.equal(isBlockInsertion('x.test.php', 'class T {}\n', [{ old_string: 'class T {}', new_string: 'class T {}\nfunction testM() {}' }]), false);   // unsupported language
  assert.equal(isBlockInsertion('x_test.go', GO, [{ old_string: '\t}\n}', new_string: '\t}\n}\n\nfunc helper() {}' }]), false);                  // not a test function
});

test('isAppend and affectsOtherTests moved here keep their behaviour', () => {
  assert.equal(isAppend('Write', { content: JS + 'test("b", () => {});\n' }, JS), true);
  assert.equal(isAppend('Edit', { old_string: 'test("z", () => {});', new_string: 'test("z", () => {});\ntest("b", () => {});' }, JS), true);
  assert.equal(isAppend('Edit', { old_string: '"a"', new_string: '"b"' }, JS), false);
  assert.equal(affectsOtherTests('test.only("x", () => {});'), 'test.only(');
  assert.equal(affectsOtherTests('test("only once", () => {});'), null);
});

const NESTED = 'import { describe, it } from "vitest";\n\ndescribe("group", () => {\n  it("a", () => {\n    run();\n  });\n\n  it("z", () => {});\n});\n';

test('isBlockInsertion: a test inserted inside a describe group at the group\'s indentation passes', () => {
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("a", () => {\n    run();\n  });', new_string: '  it("a", () => {\n    run();\n  });\n\n  it("m", () => {\n    run();\n  });' }]), true);
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: 'describe("group", () => {', new_string: 'describe("group", () => {\n  it("first", () => {});\n' }]), true);   // first child after the group opener
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("z", () => {});', new_string: '  it("m", () => {});\n\n  it("z", () => {});' }]), true);          // before a sibling, anchor starts after the indentation
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("z", () => {});\n});', new_string: '  it("z", () => {});\n});\n\ndescribe("other", () => {\n  it("b", () => {});\n});' }]), true);   // a whole nested group at top level
});

test('isBlockInsertion: nested insertions that break the indentation or land inside a test still ask', () => {
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("a", () => {\n    run();\n  });', new_string: '  it("a", () => {\n    run();\n  });\n\nit("m", () => {});' }]), false);   // column 0 inside the group
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '    run();', new_string: '    run();\n    it("m", () => {});' }]), false);                                            // inside a test body
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("a", () => {', new_string: '  it("a", () => {\n    it("m", () => {});' }]), false);                              // after a test opener, not a group opener
});

test('isBlockInsertion: an anchor that spans the last block and the closing line of its group still admits a whole block between them', () => {
  // The edit's old_string is neither a prefix nor a suffix of new_string: the block lands between the two anchor lines.
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("z", () => {});\n});', new_string: '  it("z", () => {});\n\n  it("m", () => {\n    run();\n  });\n});' }]), true);
  assert.equal(isBlockInsertion('x_test.go', GO, [{ old_string: 'func TestZ(t *testing.T) {}\n', new_string: 'func TestM(t *testing.T) {}\n\nfunc TestZ(t *testing.T) {}\n' }]), true);   // suffix anchor including its newline
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("z", () => {});\n});', new_string: '  it("z", () => {});\n\n  it("m", () => {});\n});\n' }]), false);   // the closing line changes too
  assert.equal(isBlockInsertion('x.test.ts', NESTED, [{ old_string: '  it("z", () => {});\n});', new_string: '  it("z", () => {}); // note\n\n  it("m", () => {});\n});' }]), false);   // the anchor line itself changes
});
