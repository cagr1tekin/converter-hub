import "server-only";

/**
 * PDF text extraction with layout awareness.
 *
 * pdf.js hands back positioned text runs, not a document tree — there is no
 * "heading" or "table" in a PDF, only glyphs at coordinates. Structure is
 * therefore inferred from geometry: font height relative to the body text marks
 * headings, left indentation marks lists, and repeated column alignment across
 * consecutive lines marks tables.
 *
 * This is a heuristic reconstruction and is honest about its limits: it reads
 * the text layer, so a scanned PDF with no text layer yields nothing (that
 * needs OCR), and a heavily designed multi-column layout will not survive.
 */

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

export interface Line {
  text: string;
  x: number;
  y: number;
  height: number;
  cells: string[];
  cellStarts: number[];
}

export interface PageContent {
  lines: Line[];
  /** Most common glyph height on the page — the body text size. */
  bodyHeight: number;
  /** Page height in PDF units, needed to locate the header/footer bands. */
  pageHeight: number;
}

/** Group runs that share a baseline into lines, then split each into cells. */
export function buildLines(items: TextItem[]): Line[] {
  const visible = items.filter((i) => i.str.trim().length > 0);
  if (visible.length === 0) return [];

  const tolerance = Math.max(1.5, median(visible.map((i) => i.height)) * 0.4);

  const rows: TextItem[][] = [];
  for (const item of [...visible].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  return rows.map((row) => {
    const sorted = row.sort((a, b) => a.x - b.x);
    const height = Math.max(...sorted.map((i) => i.height));

    // A gap wider than roughly two spaces separates cells rather than words.
    const gapThreshold = Math.max(6, height * 0.9);
    const cells: string[] = [];
    const cellStarts: number[] = [];
    let current = "";
    let previousEnd = -Infinity;

    for (const item of sorted) {
      const gap = item.x - previousEnd;
      if (current === "") {
        cellStarts.push(item.x);
        current = item.str;
      } else if (gap > gapThreshold) {
        cells.push(current.trim());
        cellStarts.push(item.x);
        current = item.str;
      } else {
        // Runs are split mid-word by kerning; only insert a space for a real gap.
        current += gap > height * 0.18 && !current.endsWith(" ") ? ` ${item.str}` : item.str;
      }
      previousEnd = item.x + item.width;
    }
    if (current.trim()) cells.push(current.trim());

    return {
      text: cells.join(" ").replace(/\s+/g, " ").trim(),
      x: sorted[0].x,
      y: sorted[0].y,
      height,
      cells,
      cellStarts: cellStarts.slice(0, cells.length),
    };
  });
}

/** The height that most of the text uses, weighted by how much text is at it. */
export function bodyHeightOf(items: TextItem[]): number {
  const weights = new Map<number, number>();
  for (const item of items) {
    if (!item.str.trim()) continue;
    const key = Math.round(item.height * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + item.str.trim().length);
  }
  let best = 12;
  let bestWeight = -1;
  for (const [height, weight] of weights) {
    if (weight > bestWeight) {
      best = height;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Drop running headers and footers.
 *
 * A page number, a date, or a document title repeated in the same band on every
 * page is furniture, not content, and it wrecks a Markdown conversion by
 * injecting a stray line between every section. Detection is by repetition:
 * text near the top or bottom edge that shows up on most pages. Digits are
 * masked first, so "1/3" and "2/3" count as the same recurring line.
 *
 * Needs at least three pages — on two pages a genuine repetition is
 * indistinguishable from a coincidence.
 */
export function stripRunningHeaders(pages: PageContent[]): PageContent[] {
  if (pages.length < 3) return pages;

  const BAND = 0.12;
  const mask = (text: string) => text.replace(/\d+/g, "#").trim().toLowerCase();

  // Furniture is set in small type. A section heading repeated at the top of
  // each page ("Chapter 1", "Chapter 2") masks to the same string as a running
  // header would, so size is what separates the two — without this guard the
  // stripper eats real headings.
  const isFurnitureSized = (line: Line, bodyHeight: number) =>
    line.height <= bodyHeight * 1.1;

  const inBand = (line: Line, page: PageContent) =>
    line.y >= page.pageHeight * (1 - BAND) || line.y <= page.pageHeight * BAND;

  const seen = new Map<string, Set<number>>();
  pages.forEach((page, pageIndex) => {
    for (const line of page.lines) {
      if (!line.text || !inBand(line, page)) continue;
      if (!isFurnitureSized(line, page.bodyHeight)) continue;
      const key = mask(line.text);
      if (!key) continue;
      const pagesWithKey = seen.get(key) ?? new Set<number>();
      pagesWithKey.add(pageIndex);
      seen.set(key, pagesWithKey);
    }
  });

  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const furniture = new Set(
    [...seen.entries()].filter(([, p]) => p.size >= threshold).map(([key]) => key)
  );
  if (furniture.size === 0) return pages;

  return pages.map((page) => ({
    ...page,
    lines: page.lines.filter((line) => {
      if (!inBand(line, page)) return true;
      if (!isFurnitureSized(line, page.bodyHeight)) return true;
      return !furniture.has(mask(line.text));
    }),
  }));
}

/* ------------------------------------------------------------------ render */

export interface RenderOptions {
  detectHeadings: boolean;
  detectTables: boolean;
  detectLists: boolean;
  joinHyphens: boolean;
  plainText: boolean;
}

const BULLET = /^[•·▪◦●○–—*-]\s+/;
const NUMBERED = /^(\d{1,3})[.)]\s+/;

export function renderPage(page: PageContent, options: RenderOptions): string {
  const { lines, bodyHeight } = page;
  if (lines.length === 0) return "";

  // Heading sizes, largest first, so the biggest becomes h1 and so on.
  const headingSizes = options.detectHeadings
    ? [...new Set(lines.map((l) => Math.round(l.height * 2) / 2))]
        .filter((h) => h > bodyHeight * 1.12)
        .sort((a, b) => b - a)
        .slice(0, 5)
    : [];

  const tableRows = options.detectTables ? findTableRows(lines) : new Set<number>();
  const listRows = options.detectLists
    ? findListRows(lines, tableRows)
    : new Set<number>();

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listBuffer: string[] = [];
  let tableBuffer: Line[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(joinLines(paragraph, options.joinHyphens));
    paragraph = [];
  };
  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push(listBuffer.join("\n"));
    listBuffer = [];
  };
  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    blocks.push(options.plainText ? tableAsText(tableBuffer) : tableAsMarkdown(tableBuffer));
    tableBuffer = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const [index, line] of lines.entries()) {
    if (!line.text) continue;

    if (tableRows.has(index)) {
      flushParagraph();
      flushList();
      tableBuffer.push(line);
      continue;
    }
    flushTable();

    const size = Math.round(line.height * 2) / 2;
    const headingLevel = headingSizes.indexOf(size);
    if (headingLevel !== -1) {
      flushAll();
      blocks.push(
        options.plainText ? line.text : `${"#".repeat(headingLevel + 1)} ${line.text}`
      );
      continue;
    }

    if (listRows.has(index)) {
      flushParagraph();
      const bullet = line.text.match(BULLET);
      const numbered = line.text.match(NUMBERED);
      const body = line.text.replace(BULLET, "").replace(NUMBERED, "");

      // A line indented past the item text it follows is that item wrapping,
      // not a new bullet.
      const previous = lines[index - 1];
      const isWrap =
        !bullet &&
        !numbered &&
        listBuffer.length > 0 &&
        previous !== undefined &&
        listRows.has(index - 1) &&
        line.x > previous.x + line.height * 0.5;

      if (isWrap) {
        listBuffer[listBuffer.length - 1] += ` ${body}`;
      } else {
        const marker = numbered ? `${numbered[1]}.` : "-";
        listBuffer.push(options.plainText ? `  ${marker} ${body}` : `${marker} ${body}`);
      }
      continue;
    }
    flushList();

    // A vertical gap noticeably larger than the line pitch starts a paragraph.
    const previous = lines[index - 1];
    if (previous && paragraph.length > 0) {
      const gap = previous.y - line.y;
      if (gap > line.height * 1.8) flushParagraph();
    }
    paragraph.push(line.text);
  }

  flushAll();
  return blocks.join("\n\n");
}

/**
 * Lines that form list items.
 *
 * An explicit bullet or number is decisive, but many PDFs do not put the bullet
 * glyph in the text layer at all — it is drawn as vector art — so indentation is
 * often the only surviving evidence. A single indented line is more likely a
 * quote or a stray, so an indent-only list needs at least two consecutive lines
 * sharing the same left edge.
 */
function findListRows(lines: Line[], tableRows: Set<number>): Set<number> {
  const rows = new Set<number>();
  const candidates = lines.filter((_, i) => !tableRows.has(i));
  if (candidates.length === 0) return rows;

  const bodyLeft = median(candidates.map((l) => l.x));

  for (let i = 0; i < lines.length; i++) {
    if (tableRows.has(i)) continue;
    const line = lines[i];
    if (!line.text) continue;

    if (BULLET.test(line.text) || NUMBERED.test(line.text)) {
      rows.add(i);
      continue;
    }

    if (line.x <= bodyLeft + line.height * 0.6) continue;

    // Walk the run of consecutive indented lines starting here.
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (tableRows.has(j) || !lines[j].text) break;
      if (lines[j].x <= bodyLeft + lines[j].height * 0.6) break;
      end = j;
    }
    if (end > i) {
      for (let k = i; k <= end; k++) rows.add(k);
      i = end;
    }
  }
  return rows;
}

/**
 * Rows belonging to a table: at least two consecutive lines that split into the
 * same number of cells (2+) at roughly the same x positions.
 */
function findTableRows(lines: Line[]): Set<number> {
  const rows = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const start = lines[i];
    if (start.cells.length < 2) continue;

    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      if (candidate.cells.length !== start.cells.length) break;
      if (!columnsAlign(start.cellStarts, candidate.cellStarts, start.height)) break;
      end = j;
    }

    // A single row is a coincidence; two or more aligned rows is a table.
    if (end > i) {
      for (let k = i; k <= end; k++) rows.add(k);
      i = end;
    }
  }
  return rows;
}

function columnsAlign(a: number[], b: number[], height: number): boolean {
  if (a.length !== b.length) return false;
  const tolerance = Math.max(12, height * 1.5);
  return a.every((x, i) => Math.abs(x - b[i]) <= tolerance);
}

function tableAsMarkdown(rows: Line[]): string {
  const width = Math.max(...rows.map((r) => r.cells.length));
  const cell = (r: Line, i: number) => (r.cells[i] ?? "").replace(/\|/g, "\\|").trim();

  const header = rows[0];
  const body = rows.slice(1);

  const out = [
    `| ${Array.from({ length: width }, (_, i) => cell(header, i)).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((r) => `| ${Array.from({ length: width }, (_, i) => cell(r, i)).join(" | ")} |`),
  ];
  return out.join("\n");
}

function tableAsText(rows: Line[]): string {
  const width = Math.max(...rows.map((r) => r.cells.length));
  const columns = Array.from({ length: width }, (_, i) =>
    Math.max(...rows.map((r) => (r.cells[i] ?? "").length))
  );
  return rows
    .map((r) =>
      Array.from({ length: width }, (_, i) => (r.cells[i] ?? "").padEnd(columns[i])).join("  ")
    )
    .join("\n")
    .trimEnd();
}

/** Rejoin wrapped lines, healing words split by a hyphen at the line break. */
function joinLines(lines: string[], joinHyphens: boolean): string {
  let out = "";
  for (const line of lines) {
    if (out === "") {
      out = line;
      continue;
    }
    if (joinHyphens && /[a-zçğıöşü]-$/i.test(out) && /^[a-zçğıöşü]/i.test(line)) {
      out = out.slice(0, -1) + line;
    } else {
      out += ` ${line}`;
    }
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
