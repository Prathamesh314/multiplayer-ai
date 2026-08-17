export type Segment = {
  text: string;
  /** Theme-aware class for the 8/16 colour codes. */
  className?: string;
  /** Explicit colour for 256/truecolour codes. */
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type Line = Segment[];

type Style = Omit<Segment, "text">;

/** Basic and bright foreground codes, mapped to classes that work in both themes. */
const FOREGROUND: Record<number, string> = {
  30: "text-vs-muted",
  31: "text-red-600 dark:text-red-400",
  32: "text-emerald-600 dark:text-emerald-400",
  33: "text-amber-600 dark:text-amber-400",
  34: "text-blue-600 dark:text-blue-400",
  35: "text-fuchsia-600 dark:text-fuchsia-400",
  36: "text-cyan-600 dark:text-cyan-400",
  37: "text-vs-fg",
  39: "",
  90: "text-vs-muted",
  91: "text-red-500 dark:text-red-300",
  92: "text-emerald-500 dark:text-emerald-300",
  93: "text-amber-500 dark:text-amber-300",
  94: "text-blue-500 dark:text-blue-300",
  95: "text-fuchsia-500 dark:text-fuchsia-300",
  96: "text-cyan-500 dark:text-cyan-300",
  97: "text-vs-fg",
};

const BACKGROUND: Record<number, string> = {
  41: "rgb(153 27 27 / 0.55)",
  42: "rgb(6 95 70 / 0.55)",
  43: "rgb(146 64 14 / 0.55)",
  44: "rgb(30 64 175 / 0.55)",
  45: "rgb(134 25 143 / 0.55)",
  46: "rgb(14 116 144 / 0.55)",
  47: "rgb(120 120 120 / 0.4)",
};

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/**
 * Incremental ANSI-to-segments buffer. Written to as chunks arrive, so long
 * output is not re-parsed on every update.
 *
 * Supported: SGR colour/bold/italic/underline (including 256 and truecolour),
 * `\r` line rewrites, `\b`, and `\t`. Other escape sequences are discarded
 * rather than printed as garbage.
 */
export class AnsiBuffer {
  private lines: Line[] = [[]];
  private style: Style = {};
  /** True after a `\r`: the next printable text restarts the current line. */
  private rewriteLine = false;
  /** Holds an escape sequence split across two chunks. */
  private partialEscape = "";
  private version = 0;

  write(chunk: string): void {
    const source = this.partialEscape + chunk;
    this.partialEscape = "";
    let index = 0;

    while (index < source.length) {
      const character = source[index];

      if (character === "\x1b") {
        const consumed = this.readEscape(source, index);
        if (consumed === -1) {
          // Incomplete — wait for the rest of the sequence.
          this.partialEscape = source.slice(index);
          break;
        }
        index = consumed;
        continue;
      }

      if (character === "\n") {
        this.lines.push([]);
        this.rewriteLine = false;
        index += 1;
        continue;
      }

      if (character === "\r") {
        this.rewriteLine = true;
        index += 1;
        continue;
      }

      if (character === "\b") {
        this.deleteLastCharacter();
        index += 1;
        continue;
      }

      // Drop remaining C0 controls (bell, etc.) but keep tabs.
      if (character < " " && character !== "\t") {
        index += 1;
        continue;
      }

      // Take the whole printable run at once.
      let end = index;
      while (end < source.length) {
        const next = source[end];
        if (next === "\x1b" || next === "\n" || next === "\r" || next === "\b") break;
        if (next < " " && next !== "\t") break;
        end += 1;
      }
      this.append(source.slice(index, end));
      index = end;
    }

    this.version += 1;
  }

  /** Current contents. The identity changes only when `write` was called. */
  snapshot(): { lines: Line[]; version: number } {
    return { lines: this.lines, version: this.version };
  }

  get lineCount(): number {
    return this.lines.length;
  }

  private append(text: string): void {
    if (text.length === 0) return;

    if (this.rewriteLine) {
      this.lines[this.lines.length - 1] = [];
      this.rewriteLine = false;
    }

    const line = this.lines[this.lines.length - 1];
    const last = line[line.length - 1];
    if (last && sameStyle(last, this.style)) last.text += text;
    else line.push({ text, ...this.style });
  }

  private deleteLastCharacter(): void {
    const line = this.lines[this.lines.length - 1];
    const last = line[line.length - 1];
    if (!last) return;
    last.text = last.text.slice(0, -1);
    if (last.text.length === 0) line.pop();
  }

  /** Returns the index just past the escape sequence, or -1 if it is truncated. */
  private readEscape(source: string, start: number): number {
    const introducer = source[start + 1];
    if (introducer === undefined) return -1;

    if (introducer === "[") {
      let index = start + 2;
      while (index < source.length && source[index] >= "0" && source[index] <= "?") index += 1;
      if (index >= source.length) return -1;
      const final = source[index];
      if (final === "m") this.applySgr(source.slice(start + 2, index));
      return index + 1;
    }

    // OSC and friends run until BEL or ST.
    if (introducer === "]" || introducer === "P" || introducer === "^" || introducer === "_") {
      const bell = source.indexOf("\x07", start);
      const stringTerminator = source.indexOf("\x1b\\", start + 2);
      if (bell === -1 && stringTerminator === -1) return -1;
      if (bell !== -1 && (stringTerminator === -1 || bell < stringTerminator)) return bell + 1;
      return stringTerminator + 2;
    }

    return start + 2;
  }

  private applySgr(parameters: string): void {
    const codes = parameters
      .split(";")
      .map((part) => (part === "" ? 0 : Number(part)))
      .filter((value) => Number.isFinite(value));

    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];

      if (code === 0) {
        this.style = {};
      } else if (code === 1) {
        this.style.bold = true;
      } else if (code === 2) {
        this.style.dim = true;
      } else if (code === 3) {
        this.style.italic = true;
      } else if (code === 4) {
        this.style.underline = true;
      } else if (code === 22) {
        this.style.bold = undefined;
        this.style.dim = undefined;
      } else if (code === 23) {
        this.style.italic = undefined;
      } else if (code === 24) {
        this.style.underline = undefined;
      } else if (code === 38 || code === 48) {
        const extended = readExtendedColor(codes, index);
        index = extended.nextIndex;
        if (code === 38) {
          this.style.color = extended.color;
          this.style.className = extended.color ? "" : this.style.className;
        } else {
          this.style.background = extended.color;
        }
      } else if (code === 39) {
        this.style.className = "";
        this.style.color = undefined;
      } else if (code === 49) {
        this.style.background = undefined;
      } else if (FOREGROUND[code] !== undefined) {
        this.style.className = FOREGROUND[code];
        this.style.color = undefined;
      } else if (BACKGROUND[code] !== undefined) {
        this.style.background = BACKGROUND[code];
      }
      // Anything else (blink, reverse, 100-107, …) is ignored on purpose.
    }
  }
}

/** Parses `38;5;n` and `38;2;r;g;b`, returning the index of the last code used. */
function readExtendedColor(
  codes: number[],
  index: number,
): { color: string | undefined; nextIndex: number } {
  const mode = codes[index + 1];

  if (mode === 5 && codes.length > index + 2) {
    return { color: xterm256(codes[index + 2]), nextIndex: index + 2 };
  }
  if (mode === 2 && codes.length > index + 4) {
    const [red, green, blue] = codes.slice(index + 2, index + 5);
    return { color: `rgb(${red} ${green} ${blue})`, nextIndex: index + 4 };
  }
  return { color: undefined, nextIndex: index + 1 };
}

function xterm256(value: number): string {
  if (value < 16) {
    const base = value % 8;
    const bright = value >= 8;
    const level = bright ? 255 : 205;
    const dim = bright ? 85 : 0;
    const red = base === 1 || base === 3 || base === 5 || base === 7 ? level : dim;
    const green = base === 2 || base === 3 || base === 6 || base === 7 ? level : dim;
    const blue = base === 4 || base === 5 || base === 6 || base === 7 ? level : dim;
    return `rgb(${red} ${green} ${blue})`;
  }
  if (value < 232) {
    const offset = value - 16;
    return `rgb(${CUBE_LEVELS[Math.floor(offset / 36)]} ${CUBE_LEVELS[Math.floor(offset / 6) % 6]} ${CUBE_LEVELS[offset % 6]})`;
  }
  const gray = 8 + (value - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

function sameStyle(segment: Segment, style: Style): boolean {
  return (
    segment.className === style.className &&
    segment.color === style.color &&
    segment.background === style.background &&
    segment.bold === style.bold &&
    segment.dim === style.dim &&
    segment.italic === style.italic &&
    segment.underline === style.underline
  );
}
