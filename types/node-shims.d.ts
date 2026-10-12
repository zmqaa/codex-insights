declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  indexOf(value: number): number;
  equals(other: Uint8Array): boolean;
  subarray(begin?: number, end?: number): Buffer;
  toString(encoding?: string): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

declare module "node:fs" {
  export type FileHandle = {
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  };
  export const promises: any;
}

declare module "node:fs/promises" {
  export const mkdtemp: any;
  export const mkdir: any;
  export const readFile: any;
  export const rm: any;
  export const writeFile: any;
  export const utimes: any;
}

declare module "node:path" {
  const path: any;
  export default path;
}

declare module "node:os" {
  const os: any;
  export default os;
}

declare module "node:url" {
  export const fileURLToPath: any;
}

declare module "node:test" {
  const test: any;
  export default test;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
