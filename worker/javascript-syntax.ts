import { parse } from 'acorn';

/** Parse generated scripts without evaluating publisher code in the Worker. */
export function assertJavaScriptSyntax(source: string, fileName: string): void {
  try {
    parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (error) {
    const failure = error as Error & { loc?: { line: number; column: number } };
    const location = failure.loc ? ` at line ${failure.loc.line}, column ${failure.loc.column + 1}` : '';
    throw new Error(`Generated ${fileName} has invalid JavaScript syntax${location}. Review the imported template before generating or publishing.`);
  }
}
