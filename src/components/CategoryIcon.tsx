import { getIcon } from '@/lib/icons';

interface Props {
  name?: string | null;
  color: string;
  size?: number;
  /** Render with a soft colored background tile */
  tile?: boolean;
  tileSize?: number;
}

export default function CategoryIcon({ name, color, size = 16, tile = false, tileSize = 36 }: Props) {
  const Icon = getIcon(name);
  if (!tile) return <Icon size={size} color={color} />;
  return (
    <div style={{
      width: tileSize, height: tileSize, borderRadius: 10, flexShrink: 0,
      background: `${color}20`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Icon size={size} color={color} />
    </div>
  );
}
