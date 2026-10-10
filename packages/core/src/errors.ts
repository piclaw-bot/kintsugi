import type { JsonObject } from "./json.ts";

export interface KintsugiError {
  code: string;
  message: string;
  details?: JsonObject;
}

export class KintsugiCoreError extends Error {
  readonly code: string;
  readonly details?: JsonObject;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function invalidArguments(message: string): KintsugiCoreError {
  return new KintsugiCoreError("invalid_arguments", message);
}
