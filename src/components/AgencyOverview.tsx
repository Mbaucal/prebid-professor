import { AgencyFilter, AgencyLogo } from './AgencyHierarchy';
import type { Agency, Organization } from '../organization';

type Props = {
  agency: Agency | null;
  data: Organization;
  filter: string;
  onFilter: (value: string) => void;
};

/** Shared by the dashboard and the TEST publisher overview. */
export default function AgencyOverview({ agency, data, filter, onFilter }: Props) {
  return (
    <div className="agency-overview">
      <div className="agency-overview-identity">
        <AgencyLogo agency={agency} />
        <div className="agency-overview-text">
          <span className="agency-overview-label">Agency</span>
          <strong className="agency-overview-name">{agency?.name ?? 'Without agency'}</strong>
        </div>
      </div>
      <AgencyFilter data={data} value={filter} onChange={onFilter} label="Filter agencies" />
    </div>
  );
}
