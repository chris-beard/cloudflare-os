import type {
  GoogleDocsTab, ParagraphElement, StructuralElement, TextStyle,
} from "../src/docs-api";

/** A styled span of text within a paragraph. */
export type Run = { text: string; style?: TextStyle };

type ParagraphSpec = {
  runs: (Run | string)[];
  namedStyleType?: string;
  bullet?: { listId: string; nestingLevel: number };
};

type TableCellSpec = string | {
  paragraphs: (Run | string)[][];
  tableCellStyle?: { rowSpan?: number; columnSpan?: number };
};
type TableSpec = { table: TableCellSpec[][] };
type BlockSpec = ParagraphSpec | TableSpec;

/**
 * Builds a normalized `GoogleDocsTab` with the index bookkeeping the real API applies: a section
 * break occupies index 0, followed by paragraphs and tables in one shared index space.
 *
 * Every paragraph's last run must end in "\n", as Google's own responses do.
 */
export function buildTab(
  blocks: BlockSpec[],
  lists: GoogleDocsTab["lists"] = {},
): GoogleDocsTab {
  let index = 1;
  let content: StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];

  for (let spec of blocks) {
    if ("table" in spec) {
      let table = buildTable(index, spec.table);
      content.push(table);
      index = table.endIndex;
      continue;
    }
    let paragraph = buildParagraph(index, spec);
    content.push(paragraph);
    index = paragraph.endIndex;
  }

  return {
    tabId: "tab-1",
    title: "Fixture",
    index: 0,
    nestingLevel: 0,
    body: { content },
    lists,
    namedRanges: {},
  };
}

function buildParagraph(startIndex: number, spec: ParagraphSpec): StructuralElement {
  let index = startIndex;
  let elements: ParagraphElement[] = spec.runs.map(run => {
    let { text, style } = typeof run === "string" ? { text: run, style: undefined } : run;
    let runStart = index;
    index += text.length;
    return {
      startIndex: runStart,
      endIndex: index,
      textRun: { content: text, textStyle: style ?? {} },
    };
  });
  return {
    startIndex,
    endIndex: index,
    paragraph: {
      elements,
      paragraphStyle: { namedStyleType: spec.namedStyleType ?? "NORMAL_TEXT" },
      bullet: spec.bullet,
    },
  };
}

/** Build a Google Docs table element with the provider's nested index layout. */
export function buildTable(startIndex: number, rows: TableCellSpec[][]): StructuralElement {
  let index = startIndex + 1;
  let tableRows = rows.map(row => {
    let rowStart = index++;
    let tableCells = row.map(cell => {
      let cellStart = index++;
      let paragraphs = typeof cell === "string" ? [[cell]] : cell.paragraphs;
      let tableCellStyle = typeof cell === "string" ? undefined : cell.tableCellStyle;
      let content = paragraphs.map(runs => {
        let paragraph = buildParagraph(index, { runs });
        index = paragraph.endIndex;
        return paragraph;
      });
      return {
        startIndex: cellStart,
        endIndex: index,
        content,
        ...(tableCellStyle ? { tableCellStyle } : {}),
      };
    });
    return { startIndex: rowStart, endIndex: index, tableCells };
  });

  return {
    startIndex,
    endIndex: index + 1,
    table: { tableRows },
  };
}

/** A single-level bullet list definition, for paragraphs carrying a matching `bullet`. */
export const BULLET_LIST: GoogleDocsTab["lists"] = {
  L1: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } },
};
