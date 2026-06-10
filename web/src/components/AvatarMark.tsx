import { UsersRound } from "lucide-react";

type AvatarKind = "agent" | "brand" | "conversation" | "user";
type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const APP_LOGO_SRC = "/assets/brand/logo.png";

interface AvatarMarkProps {
  value?: string | undefined;
  label?: string | undefined;
  variantKey?: string | undefined;
  kind?: AvatarKind;
  size?: AvatarSize;
  className?: string | undefined;
  title?: string | undefined;
  onClick?: (() => void) | undefined;
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={["brand-mark", className].filter(Boolean).join(" ")} aria-label="AgentHub">
      <img className="brand-mark-image" src={APP_LOGO_SRC} alt="" draggable={false} />
    </span>
  );
}

export function AvatarMark({
  value,
  label,
  variantKey,
  kind = "user",
  size = "md",
  className,
  title,
  onClick
}: AvatarMarkProps) {
  const imageSrc = normalizeAvatarImage(value);
  const display = imageSrc ? normalizeAvatar(undefined, label) : normalizeAvatar(value, label);
  const tone = pickTone(display, kind);
  const logoVariant = kind === "conversation" && !imageSrc ? pickLogoVariant(variantKey ?? value, label) : undefined;
  const classes = ["avatar-mark", `avatar-mark-${kind}`, `avatar-size-${size}`, className].filter(Boolean).join(" ");
  const content = imageSrc ? (
    <img className="avatar-mark-image" src={imageSrc} alt={label ?? display} draggable={false} />
  ) : kind === "conversation" && logoVariant ? (
    <ProjectLogo variant={logoVariant} />
  ) : (
    <>
      <span className="avatar-mark-pattern" aria-hidden="true" />
      <span className="avatar-mark-dot" aria-hidden="true" />
      <span className="avatar-mark-text">{display}</span>
    </>
  );

  if (onClick) {
    return (
      <button className={classes} data-tone={tone} data-logo={logoVariant} type="button" title={title ?? label ?? display} onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <span className={classes} data-tone={tone} data-logo={logoVariant} title={title ?? label ?? display}>
      {content}
    </span>
  );
}

function normalizeAvatar(value: string | undefined, label: string | undefined) {
  const raw = (value || label || "U").trim();
  if (/^[A-Z]{1,3}$/.test(raw)) return raw;
  const letters = Array.from(raw)
    .filter((char) => /[a-zA-Z0-9\u4e00-\u9fa5]/.test(char))
    .slice(0, 2)
    .join("");
  return letters.toUpperCase() || "U";
}

function normalizeAvatarImage(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("/") || raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("data:image/")) return raw;
  return undefined;
}

function pickTone(value: string, kind: AvatarKind) {
  if (kind === "brand" || value === "AH") return "hub";
  if (value === "O") return "orchestrator";
  if (value === "C" || value === "OC") return "code";
  if (value === "UI") return "ui";
  if (value === "P") return "product";
  if (value === "R") return "review";
  if (value === "U") return "universal";
  if (value === "AD") return "admin";
  if (kind === "agent") return "agent";
  if (kind === "conversation") return "project";
  return "user";
}

function pickLogoVariant(value: string | undefined, label: string | undefined) {
  const source = `${value ?? ""}:${label ?? ""}` || "conversation";
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return String((hash % 13) + 1);
}

function ProjectLogo({ variant: _variant }: { variant: string }) {
  return (
    <>
      <span className="avatar-project-mark" aria-hidden="true">
        <UsersRound size={22} strokeWidth={2.45} />
      </span>
      <span className="sr-only">群聊</span>
    </>
  );
}
