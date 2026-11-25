/**
 * A spreadsheet as the file panel shows it: a header row and value rows,
 * read from a CSV or TSV revision's text.
 */

export interface Sheet {
  columns: string[];
  rows: string[][];
}

/** Spreadsheet column letters: A … Z, AA, AB … */
export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/**
 * Parse delimited text (RFC 4180): quoted fields may hold the delimiter,
 * doubled quotes and line breaks; CRLF and LF both end a record.
 */
export function parseDelimited(text: string, delimiter: "," | "\t" = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  // A trailing blank line is not a row.
  while (records.length && records.at(-1)!.every((value) => value === "")) records.pop();
  return records;
}

export function sheetFromDelimited(text: string, delimiter: "," | "\t" = ","): Sheet {
  const [header = [], ...rows] = parseDelimited(text, delimiter);
  return { columns: header, rows };
}

/** The widest row decides how many columns a sheet shows. */
export function sheetWidth(sheet: Sheet): number {
  let width = sheet.columns.length;
  for (const row of sheet.rows) width = Math.max(width, row.length);
  return width;
}
