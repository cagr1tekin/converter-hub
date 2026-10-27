import { basename, extname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { defineModule } from "@/core/types";
import {
  bodyHeightOf,
  buildLines,
  renderPage,
  stripRunningHeaders,
  type PageContent,
  type RenderOptions,
  type TextItem,
} from "@/core/pdf-text";

/**
 * Runs in-process rather than through a container.
 *
 * Docling would reconstruct structure more faithfully, but it carries a PyTorch
 * stack that wants 2-4GB of RAM — more than this machine's Docker VM can spare
 * without falling over. pdf.js reads the text layer directly, needs no model,
 * and starts instantly; structure is inferred from layout geometry in
 * core/pdf-text.ts.
 *
 * The trade-off worth stating: this reads the PDF's text layer. A scanned page
 * is an image with no text layer, and no amount of parsing will find words in
 * it — that needs OCR, which is a separate module.
 */
export default defineModule({
  id: "pdf-to-md",
  name: "PDF'ten Markdown",
  description:
    "PDF metnini Markdown'a cevirir. Basliklari, listeleri ve tablolari yerlesimden cikarir.",
  category: "document",
  engine: "inproc",
  icon: "📄",

  inputMode: "files",
  accepts: { ext: ["pdf"], multiple: true },

  options: [
    {
      key: "format",
      type: "select",
      label: "Cikti",
      default: "markdown",
      choices: [
        { value: "markdown", label: "Markdown (.md)" },
        { value: "text", label: "Duz metin (.txt)" },
      ],
    },
    {
      key: "pageMarkers",
      type: "select",
      label: "Sayfa ayraci",
      default: "none",
      choices: [
        { value: "none", label: "Yok - kesintisiz metin" },
        { value: "comment", label: "Gizli yorum" },
        { value: "rule", label: "Yatay cizgi + sayfa no" },
      ],
    },
    {
      key: "detectHeadings",
      type: "boolean",
      label: "Basliklari bul",
      default: true,
      help: "Govde metninden buyuk satirlari baslik sayar ve boyutlarina gore siralar.",
    },
    {
      key: "detectTables",
      type: "boolean",
      label: "Tablolari bul",
      default: true,
      help: "Ust uste hizalanmis sutunlari tablo olarak yazar.",
    },
    {
      key: "stripRepeats",
      type: "boolean",
      label: "Tekrar eden ustbilgi/altbilgiyi at",
      default: true,
      help: "Her sayfada tekrarlanan sayfa numarasi, tarih ve baslik satirlarini siler. En az 3 sayfa gerekir.",
    },
    {
      key: "detectLists",
      type: "boolean",
      label: "Listeleri bul",
      default: true,
      advanced: true,
    },
    {
      key: "joinHyphens",
      type: "boolean",
      label: "Bolunmus kelimeleri birlestir",
      default: true,
      help: "Satir sonunda tireyle bolunmus kelimeleri tek parca yapar.",
      advanced: true,
    },
    {
      key: "combine",
      type: "boolean",
      label: "Tek dosyada birlestir",
      default: false,
      help: "Butun PDF'leri tek bir cikti dosyasina yazar.",
      advanced: true,
    },
  ],

  async run({ inputs, outDir, options, onProgress, log, signal }) {
    // The legacy build is the one meant for Node; the default build assumes a
    // browser worker environment.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const plainText = options.format === "text";
    const render: RenderOptions = {
      detectHeadings: Boolean(options.detectHeadings),
      // Detection stays on for plain text too — renderPage writes aligned
      // columns instead of a Markdown table in that mode.
      detectTables: Boolean(options.detectTables),
      detectLists: Boolean(options.detectLists),
      joinHyphens: Boolean(options.joinHyphens),
      plainText,
    };
    const markers = String(options.pageMarkers);
    const ext = plainText ? "txt" : "md";

    const combined: string[] = [];
    const outputs = [];
    let totalPages = 0;
    let emptyPages = 0;

    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();

      const data = new Uint8Array(await readFile(file.path));
      // Only the text layer is read, so fonts never need to be built — skipping
      // that is both faster and keeps font programs from untrusted files unused.
      const loadingTask = pdfjs.getDocument({ data, disableFontFace: true });
      let doc;
      try {
        doc = await loadingTask.promise;
      } catch (err) {
        // pdf.js reports "Invalid PDF structure" and similar, which does not
        // tell the user which of their files is the problem.
        const detail = err instanceof Error ? err.message : String(err);
        if (/password/i.test(detail)) {
          throw new Error(`${file.name}: parola korumali, acilamadi.`);
        }
        throw new Error(`${file.name}: gecerli bir PDF degil (${detail}).`);
      }

      const stem = basename(file.name, extname(file.name));
      const pageCount = doc.numPages;

      // Read every page before rendering any: running headers can only be
      // recognised by comparing pages against each other.
      let pages: PageContent[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        signal.throwIfAborted();

        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();

        const items: TextItem[] = [];
        for (const raw of content.items) {
          if (!("str" in raw)) continue;
          items.push({
            str: raw.str,
            x: raw.transform[4],
            y: raw.transform[5],
            width: raw.width ?? 0,
            height: raw.height ?? 0,
            fontName: String(raw.fontName ?? ""),
          });
        }
        const [, y0, , y1] = page.view;
        page.cleanup();

        pages.push({
          lines: buildLines(items),
          bodyHeight: bodyHeightOf(items),
          pageHeight: Math.abs(y1 - y0) || 792,
        });

        onProgress(
          ((index + (pageNumber / pageCount) * 0.8) / inputs.length) * 100,
          `${index + 1}/${inputs.length} · sayfa ${pageNumber}/${pageCount}`
        );
      }

      if (options.stripRepeats) {
        const before = pages.reduce((n, p) => n + p.lines.length, 0);
        pages = stripRunningHeaders(pages);
        const removed = before - pages.reduce((n, p) => n + p.lines.length, 0);
        if (removed > 0) log(`${file.name}: ${removed} tekrar eden ustbilgi/altbilgi satiri atildi.`);
      }

      const parts: string[] = [];
      let fileEmpty = 0;

      for (const [pageIndex, page] of pages.entries()) {
        const rendered = renderPage(page, render);
        if (!rendered.trim()) fileEmpty++;

        if (markers === "rule" && parts.length > 0) parts.push("---");
        if (markers === "comment") parts.push(`<!-- sayfa ${pageIndex + 1} -->`);
        else if (markers === "rule") parts.push(`*sayfa ${pageIndex + 1}*`);
        if (rendered.trim()) parts.push(rendered);
      }
      onProgress(((index + 1) / inputs.length) * 100, `${index + 1}/${inputs.length}`);
      // Tear down the worker for this file before opening the next one, so a
      // long batch does not accumulate one worker per PDF.
      await loadingTask.destroy();
      totalPages += pageCount;
      emptyPages += fileEmpty;

      const body = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

      if (fileEmpty === pageCount) {
        log(
          `${file.name}: metin katmani yok, cikti bos. Taranmis belge olabilir - bunun icin OCR gerekir.`
        );
      } else if (fileEmpty > 0) {
        log(`${file.name}: ${pageCount} sayfanin ${fileEmpty} tanesi bos (muhtemelen gorsel).`);
      } else {
        log(`${file.name}: ${pageCount} sayfa islendi.`);
      }

      if (options.combine) {
        combined.push(plainText ? `${stem}\n\n${body}` : `# ${stem}\n\n${body}`);
      } else {
        const target = join(outDir, `${stem}.${ext}`);
        await writeFile(target, body, "utf8");
        outputs.push({ path: target, name: `${stem}.${ext}` });
      }
    }

    if (options.combine && combined.length > 0) {
      const name = `birlesik.${ext}`;
      const target = join(outDir, name);
      await writeFile(target, combined.join("\n\n---\n\n"), "utf8");
      outputs.push({ path: target, name });
    }

    return {
      outputs,
      summary:
        `${inputs.length} PDF, ${totalPages} sayfa donusturuldu` +
        (emptyPages > 0 ? ` (${emptyPages} sayfada metin katmani yok)` : ""),
    };
  },
});
