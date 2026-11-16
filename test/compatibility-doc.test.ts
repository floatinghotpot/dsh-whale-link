/**
 * The compatibility matrix is documentation DSH cannot enforce, so it is the one
 * artifact that could drift from the manifest silently. Pin its current release
 * row to `package.json` and fail when the two disagree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface Manifest {
  version: string;
  engines?: { dsh?: string };
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
const releaseLine = manifest.version.split(".").slice(0, 2).join(".") + ".x";
const requirement = manifest.engines?.dsh;

/** The matrix row for the running release line. */
function currentRow(file: string): string {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const row = text.split("\n").find((line) => line.startsWith(`| \`${releaseLine}\``));
  assert.ok(row !== undefined, `${file}: missing the ${releaseLine} row`);
  return row;
}

for (const file of ["docs/COMPATIBILITY.md", "docs/COMPATIBILITY.zh.md"]) {
  test(`${file} keeps the current release row in sync with package.json`, () => {
    assert.ok(
      typeof requirement === "string" && requirement !== "",
      "package.json must declare engines.dsh for the matrix to state it",
    );
    const row = currentRow(file);
    assert.ok(
      row.includes(`\`${requirement}\``),
      `${file}: the ${releaseLine} row must state engines.dsh ${requirement}`,
    );
  });
}
