/// <reference types="node" />
import { readFileSync } from "node:fs";
import { MTPClient } from "mtp";
import { inject } from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    mtpWasmPath: string;
  }
}

export async function initMtpForTest() {
  await MTPClient.init({ module_or_path: readFileSync(inject("mtpWasmPath")) });
}
