import { readFile, stat } from "node:fs/promises";
import { AppError } from "./errors.js";

export const sampleName = "Store Sales.pbix";
const sampleFile = new URL(`../../../samples/${sampleName}`, import.meta.url);

export async function assertSampleAvailable() {
  try {
    const file = await stat(sampleFile);
    if (!file.isFile() || !file.size || file.size > 64 * 1024 * 1024) throw new Error("Invalid sample");
  } catch {
    throw new AppError(503, "SampleUnavailable", "The bundled sample is missing or invalid. Restore samples/Store Sales.pbix before including the sample.");
  }
}

export async function sampleForm() {
  await assertSampleAvailable();
  let bytes: Buffer;
  try { bytes = await readFile(sampleFile); }
  catch { throw new AppError(503, "SampleUnavailable", "The bundled sample could not be read. Restore samples/Store Sales.pbix."); }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), sampleName);
  return form;
}
