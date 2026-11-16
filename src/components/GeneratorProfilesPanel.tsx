import ScriptSetupPanel from './ScriptSetupPanel';
export default function GeneratorProfilesPanel({ publisherId, onOpenPrebid, onChanged, onContinue }: {
  publisherId: string; onOpenPrebid?: () => void; onChanged?: () => void | Promise<void>; onContinue?: () => void;
}) {
  return <ScriptSetupPanel publisherId={publisherId} onOpenPrebid={onOpenPrebid} onChanged={onChanged} onContinue={onContinue} />;
}
