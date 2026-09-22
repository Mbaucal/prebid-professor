import BulkImportPanel from './BulkImportPanel';
import type { CsvImportKind } from '../shared/types';

type Props = {
  publisherId: string;
  kinds: CsvImportKind[];
  onChanged?: () => void | Promise<void>;
};

export default function SectionCsvImport({ publisherId, kinds, onChanged }: Props) {
  return (
    <details className="section-csv-import" key={`${publisherId}:${kinds.join(',')}`}>
      <summary>CSV import · download template / upload CSV</summary>
      <BulkImportPanel publisherId={publisherId} kinds={kinds} onChanged={onChanged} />
    </details>
  );
}
