import {
  Atom,
  BookOpen,
  Bot,
  Boxes,
  BrainCircuit,
  BriefcaseBusiness,
  CircleGauge,
  Cloud,
  Code2,
  Compass,
  Database,
  FileText,
  FlaskConical,
  Gem,
  Globe2,
  GraduationCap,
  Layers3,
  Library,
  Lightbulb,
  Network,
  Puzzle,
  Rocket,
  SearchCheck,
  Sparkles,
  WandSparkles,
  Workflow
} from "lucide-react";

export const HUB_LOGO_OPTIONS = [
  "sparkles", "book", "brain", "database", "library", "search", "files", "code",
  "workflow", "network", "puzzle", "boxes", "layers", "bot", "wand", "lightbulb",
  "rocket", "globe", "cloud", "atom", "flask", "graduation", "briefcase", "compass",
  "gauge", "gem"
] as const;

export const HUB_LOGO_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c",
  "#ca8a04", "#16a34a", "#0d9488", "#0891b2", "#475569"
] as const;

export type HubLogoKey = (typeof HUB_LOGO_OPTIONS)[number];

const icons = {
  sparkles: Sparkles,
  book: BookOpen,
  brain: BrainCircuit,
  database: Database,
  library: Library,
  search: SearchCheck,
  files: FileText,
  code: Code2,
  workflow: Workflow,
  network: Network,
  puzzle: Puzzle,
  boxes: Boxes,
  layers: Layers3,
  bot: Bot,
  wand: WandSparkles,
  lightbulb: Lightbulb,
  rocket: Rocket,
  globe: Globe2,
  cloud: Cloud,
  atom: Atom,
  flask: FlaskConical,
  graduation: GraduationCap,
  briefcase: BriefcaseBusiness,
  compass: Compass,
  gauge: CircleGauge,
  gem: Gem
} satisfies Record<HubLogoKey, typeof Sparkles>;

export function HubAssetLogo(props: {
  logo?: string | null | undefined;
  color?: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const logo = normalizeHubLogo(props.logo);
  const Icon = icons[logo];
  const color = normalizeHubLogoColor(props.color);
  return (
    <span
      className={`hub-asset-logo ${props.className ?? ""}`.trim()}
      style={{ color, backgroundColor: `${color}14`, borderColor: `${color}2b` }}
    >
      <Icon size={props.size ?? 23} />
    </span>
  );
}

export function HubAssetLogoPicker(props: {
  logo: string;
  color: string;
  onLogoChange: (logo: HubLogoKey) => void;
  onColorChange: (color: string) => void;
}) {
  return (
    <div className="hub-logo-picker">
      <div className="hub-logo-preview">
        <HubAssetLogo logo={props.logo} color={props.color} size={28} />
        <div>
          <strong>资产 Logo</strong>
          <span>选择图形和强调色，将用于 Hub 卡片与 Agent 绑定界面。</span>
        </div>
      </div>
      <div className="hub-logo-grid" aria-label="选择资产 Logo">
        {HUB_LOGO_OPTIONS.map((logo) => {
          const Icon = icons[logo];
          return (
            <button
              key={logo}
              type="button"
              className={normalizeHubLogo(props.logo) === logo ? "active" : ""}
              title={logo}
              onClick={() => props.onLogoChange(logo)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
      <div className="hub-logo-colors" aria-label="选择 Logo 颜色">
        {HUB_LOGO_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={normalizeHubLogoColor(props.color) === color ? "active" : ""}
            style={{ backgroundColor: color }}
            title={color}
            onClick={() => props.onColorChange(color)}
          />
        ))}
      </div>
    </div>
  );
}

export function normalizeHubLogo(value: unknown): HubLogoKey {
  return typeof value === "string" && (HUB_LOGO_OPTIONS as readonly string[]).includes(value)
    ? value as HubLogoKey
    : "sparkles";
}

export function normalizeHubLogoColor(value: unknown) {
  return typeof value === "string" && (HUB_LOGO_COLORS as readonly string[]).includes(value)
    ? value
    : HUB_LOGO_COLORS[0];
}
