/**
 * The environment loader's precedence rules, pinned.
 *
 * These exist because the previous implementation - three identical copies, one per
 * script - could not express the distinction that matters: an empty value in the
 * shell versus an absent one. `unset HOROS_VAULT_OWNER` therefore reloaded the value
 * from .env, the variable came back, and the deployment came out owned by the agent
 * wallet when the intent was the local deployer. The command looked like it had
 * worked.
 */

import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {loadEnv, required} from "./env.js";

let dir: string;
let cwd: string;
const SAVED = {...process.env};

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "horos-env-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, {recursive: true, force: true});
  // Restore, then drop anything the test introduced.
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

describe("loadEnv precedence", () => {
  it("reads a var from .env when neither the shell nor .env.local sets it", () => {
    writeFileSync(".env", "HOROS_TEST_VALUE=from-dot-env\n");
    delete process.env.HOROS_TEST_VALUE;
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("from-dot-env");
  });

  it("prefers .env.local over .env", () => {
    writeFileSync(".env", "HOROS_TEST_VALUE=from-dot-env\n");
    writeFileSync(".env.local", "HOROS_TEST_VALUE=from-local\n");
    delete process.env.HOROS_TEST_VALUE;
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("from-local");
  });

  it("prefers the shell over both files", () => {
    writeFileSync(".env", "HOROS_TEST_VALUE=from-dot-env\n");
    writeFileSync(".env.local", "HOROS_TEST_VALUE=from-local\n");
    process.env.HOROS_TEST_VALUE = "from-shell";
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("from-shell");
  });

  // The bug. An empty string in the shell means "deliberately none", and the files
  // must not fill it back in.
  it("treats a shell value set to empty as deliberate, and does not overwrite it", () => {
    writeFileSync(".env", "HOROS_TEST_VALUE=from-dot-env\n");
    process.env.HOROS_TEST_VALUE = "";
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("");
  });

  it("leaves an absent variable absent when no file defines it", () => {
    writeFileSync(".env", "SOMETHING_ELSE=1\n");
    delete process.env.HOROS_TEST_VALUE;
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBeUndefined();
  });

  it("strips surrounding quotes, which .env.local is written with", () => {
    writeFileSync(".env", 'HOROS_TEST_VALUE="quoted value"\n');
    delete process.env.HOROS_TEST_VALUE;
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("quoted value");
  });

  it("ignores comments and blank lines rather than inventing variables from them", () => {
    process.env = {...process.env};
    writeFileSync(".env", "# a comment\n\nNOT A VAR\nHOROS_TEST_VALUE=ok\n");
    delete process.env.HOROS_TEST_VALUE;
    loadEnv();
    expect(process.env.HOROS_TEST_VALUE).toBe("ok");
    expect(process.env["NOT A VAR"]).toBeUndefined();
  });

  it("does nothing when there is no file at all", () => {
    delete process.env.HOROS_TEST_VALUE;
    expect(() => loadEnv()).not.toThrow();
    expect(process.env.HOROS_TEST_VALUE).toBeUndefined();
  });
});

describe("required", () => {
  it("returns the value when set", () => {
    process.env.HOROS_TEST_VALUE = "here";
    expect(required("HOROS_TEST_VALUE", "for the test")).toBe("here");
  });

  it("names the variable and the reason rather than throwing something bare", () => {
    delete process.env.HOROS_TEST_VALUE;
    expect(() => required("HOROS_TEST_VALUE", "the deployer wallet needs it")).toThrow(/HOROS_TEST_VALUE/);
    expect(() => required("HOROS_TEST_VALUE", "the deployer wallet needs it")).toThrow(/deployer wallet/);
  });

  it("treats an empty value as missing", () => {
    process.env.HOROS_TEST_VALUE = "";
    expect(() => required("HOROS_TEST_VALUE", "why")).toThrow(/not set/);
  });
});
