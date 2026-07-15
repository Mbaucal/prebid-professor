function countDelimiter(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) count += 1;
  }

  return count;
}

function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  return candidates.reduce((best, item) =>
    countDelimiter(firstLine, item) > countDelimiter(firstLine, best) ? item : best,
  );
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((item) => item.some((cell) => cell.trim() !== ''));
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function normalizeCsvForApi(text: string): string {
  const input = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!input) return '';

  const delimiter = detectDelimiter(input);
  const rows = parseDelimited(input, delimiter);
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}
