const MAX_LINES = 50;

/** 内存环。只记来源和扫到的字符串，不记服务器地址。 */
export class FieldLog {
  #lines: string[] = [];

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > MAX_LINES) this.#lines.shift();
  }

  text(): string {
    return this.#lines.join('\n');
  }

  clear(): void {
    this.#lines = [];
  }
}
